-- ============================================================
-- Usuarios: blindaje de permisos en la BD + auditoría de cambios.
--
-- Hasta aquí un admin ya podía cambiar rol / módulos / activo de un usuario existente
-- (policy usuarios_pqrs_update, 0001; el módulo 'sst' y su rol, 0015), pero la BD no impedía:
--   - que un admin se degradara o desactivara a sí mismo (solo la interfaz bloqueaba el rol);
--   - dejar el sistema sin ningún admin activo (ni la carrera de dos admins que se degradan
--     el uno al otro al mismo tiempo);
--   - cambiar id / email / created_at del perfil por la API;
--   - y no quedaba rastro de quién cambió qué.
--
-- Esta migración agrega, sin tocar la policy de UPDATE (que sigue siendo «solo admin»):
--   1. usuarios_pqrs_proteger()  BEFORE UPDATE
--        · columnas fijas: id nunca cambia; email y created_at tampoco con sesión.
--        · sin auto-edición: quien tiene sesión no cambia SU PROPIO rol, módulos ni activo
--          (lo hace otro admin). Nombre sí.
--        · siempre ≥1 admin activo: no se degrada ni desactiva al último (con bloqueo
--          consultivo, para que dos admins no se quiten el rol a la vez).
--        · normaliza `modulos` (sin duplicados, ordenado) para comparar bien.
--   2. usuarios_pqrs_proteger_baja()  BEFORE DELETE: no se borra al último admin activo
--      (el borrado llega por la cascada de auth.users al eliminar la cuenta).
--   3. usuarios_pqrs_auditoria + trigger AFTER UPDATE: una fila por cambio de rol, módulos
--      o activo con antes/después, quién y cuándo. Solo la leen los admins; la escribe
--      únicamente el trigger.
--
-- Los procesos sin sesión (service_role, SQL del dashboard, migraciones) son «auth.uid() IS
-- NULL»: quedan fuera de las reglas de auto-edición y de columnas fijas (mantenimiento), pero
-- NO de la regla de «siempre ≥1 admin activo».
--
-- Requiere 0001, 0012 y 0015. Idempotente. Aplicar con apply_migration (MCP) ANTES de publicar el frontend.
-- ============================================================

-- ── 1. Reglas de protección (UPDATE) ─────────────────────────
CREATE OR REPLACE FUNCTION public.usuarios_pqrs_proteger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_otros   integer;
  v_mod_old text[] := COALESCE(ARRAY(SELECT DISTINCT m FROM unnest(OLD.modulos) AS m ORDER BY m), '{}'::text[]);
BEGIN
  -- Columnas fijas.
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'No se puede cambiar el identificador de un usuario';
  END IF;
  IF v_uid IS NOT NULL AND (NEW.email IS DISTINCT FROM OLD.email OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION 'El correo y la fecha de alta de un usuario no se pueden cambiar desde el panel';
  END IF;

  -- Módulos sin duplicados y ordenados (el CHECK ya acota los valores válidos).
  NEW.modulos := COALESCE(ARRAY(SELECT DISTINCT m FROM unnest(NEW.modulos) AS m ORDER BY m), '{}'::text[]);

  -- Sin auto-edición de permisos.
  IF v_uid IS NOT NULL AND OLD.id = v_uid
     AND (NEW.rol IS DISTINCT FROM OLD.rol
          OR NEW.activo IS DISTINCT FROM OLD.activo
          OR NEW.modulos IS DISTINCT FROM v_mod_old) THEN
    RAISE EXCEPTION 'No puedes cambiar tus propios permisos ni desactivarte: pídeselo a otro administrador';
  END IF;

  -- Siempre debe quedar al menos un administrador activo.
  IF OLD.rol = 'admin' AND OLD.activo AND (NEW.rol <> 'admin' OR NOT NEW.activo) THEN
    PERFORM pg_advisory_xact_lock(hashtext('usuarios_pqrs_admins'));
    SELECT count(*) INTO v_otros FROM usuarios_pqrs WHERE rol = 'admin' AND activo AND id <> OLD.id;
    IF v_otros = 0 THEN
      RAISE EXCEPTION 'Debe quedar al menos un administrador activo';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.usuarios_pqrs_proteger() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_usuarios_proteger ON public.usuarios_pqrs;
CREATE TRIGGER trg_usuarios_proteger
  BEFORE UPDATE ON public.usuarios_pqrs
  FOR EACH ROW EXECUTE FUNCTION public.usuarios_pqrs_proteger();

-- ── 2. No borrar al último administrador activo ──────────────
CREATE OR REPLACE FUNCTION public.usuarios_pqrs_proteger_baja()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_otros integer;
BEGIN
  IF OLD.rol = 'admin' AND OLD.activo THEN
    PERFORM pg_advisory_xact_lock(hashtext('usuarios_pqrs_admins'));
    SELECT count(*) INTO v_otros FROM usuarios_pqrs WHERE rol = 'admin' AND activo AND id <> OLD.id;
    IF v_otros = 0 THEN
      RAISE EXCEPTION 'No se puede eliminar al último administrador activo';
    END IF;
  END IF;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.usuarios_pqrs_proteger_baja() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_usuarios_proteger_baja ON public.usuarios_pqrs;
CREATE TRIGGER trg_usuarios_proteger_baja
  BEFORE DELETE ON public.usuarios_pqrs
  FOR EACH ROW EXECUTE FUNCTION public.usuarios_pqrs_proteger_baja();

-- ── 3. Auditoría de cambios de rol / módulos / activo ────────
-- Sin FK a usuarios_pqrs: el historial debe sobrevivir si la cuenta se elimina. El nombre y el
-- correo quedan copiados (usuarios_pqrs solo deja leer su fila a quien no es admin).
CREATE TABLE IF NOT EXISTS public.usuarios_pqrs_auditoria (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  usuario_id       uuid        NOT NULL,
  usuario_email    text,
  usuario_nombre   text,
  hecho_por        uuid,
  hecho_por_nombre text        NOT NULL,
  hecho_en         timestamptz NOT NULL DEFAULT now(),
  -- {"rol": {"antes": "mercadeo", "despues": "lector"}, "modulos": {...}, "activo": {...}}: solo lo que cambió.
  cambios          jsonb       NOT NULL
);
CREATE INDEX IF NOT EXISTS usuarios_pqrs_auditoria_usuario_idx ON public.usuarios_pqrs_auditoria (usuario_id, hecho_en DESC);
COMMENT ON TABLE public.usuarios_pqrs_auditoria IS
  'Historial de cambios de rol / módulos / activo de usuarios_pqrs. La llena el trigger trg_usuarios_auditar; solo la leen los administradores.';

ALTER TABLE public.usuarios_pqrs_auditoria ENABLE ROW LEVEL SECURITY;

-- Supabase otorga por defecto todo a anon/authenticated en tablas nuevas de public: aquí solo
-- se lee, y solo un admin (por RLS). Nadie escribe desde el cliente.
REVOKE ALL ON TABLE public.usuarios_pqrs_auditoria FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.usuarios_pqrs_auditoria TO authenticated;

DROP POLICY IF EXISTS "usuarios_pqrs_auditoria_select" ON public.usuarios_pqrs_auditoria;
CREATE POLICY "usuarios_pqrs_auditoria_select" ON public.usuarios_pqrs_auditoria
  FOR SELECT TO authenticated
  USING ((select get_user_role_pqrs()) = 'admin');

CREATE OR REPLACE FUNCTION public.usuarios_pqrs_auditar()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cambios jsonb := '{}'::jsonb;
  v_nombre  text;
  v_mod_old text[] := COALESCE(ARRAY(SELECT DISTINCT m FROM unnest(OLD.modulos) AS m ORDER BY m), '{}'::text[]);
BEGIN
  IF NEW.rol IS DISTINCT FROM OLD.rol THEN
    v_cambios := v_cambios || jsonb_build_object('rol', jsonb_build_object('antes', OLD.rol, 'despues', NEW.rol));
  END IF;
  IF NEW.modulos IS DISTINCT FROM v_mod_old THEN
    v_cambios := v_cambios || jsonb_build_object('modulos', jsonb_build_object('antes', to_jsonb(v_mod_old), 'despues', to_jsonb(NEW.modulos)));
  END IF;
  IF NEW.activo IS DISTINCT FROM OLD.activo THEN
    v_cambios := v_cambios || jsonb_build_object('activo', jsonb_build_object('antes', OLD.activo, 'despues', NEW.activo));
  END IF;
  IF v_cambios = '{}'::jsonb THEN RETURN NULL; END IF;

  SELECT COALESCE(NULLIF(nombre, ''), email) INTO v_nombre FROM usuarios_pqrs WHERE id = auth.uid();

  INSERT INTO usuarios_pqrs_auditoria (usuario_id, usuario_email, usuario_nombre, hecho_por, hecho_por_nombre, cambios)
  VALUES (NEW.id, NEW.email, COALESCE(NULLIF(NEW.nombre, ''), NEW.email), auth.uid(), COALESCE(v_nombre, 'Sistema'), v_cambios);
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.usuarios_pqrs_auditar() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_usuarios_auditar ON public.usuarios_pqrs;
CREATE TRIGGER trg_usuarios_auditar
  AFTER UPDATE ON public.usuarios_pqrs
  FOR EACH ROW
  WHEN (OLD.rol IS DISTINCT FROM NEW.rol OR OLD.modulos IS DISTINCT FROM NEW.modulos OR OLD.activo IS DISTINCT FROM NEW.activo)
  EXECUTE FUNCTION public.usuarios_pqrs_auditar();

NOTIFY pgrst, 'reload schema';

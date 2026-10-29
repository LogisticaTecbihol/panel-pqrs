-- ============================================================
-- Registro de gestión de cada PQRS (sección propia del detalle).
--
-- Hasta aquí lo único que dejaba rastro de lo que el equipo HACÍA con una PQRS eran las notas de la
-- bitácora, mezcladas con los eventos de sistema (cambios de estado, asignaciones, adjuntos). Ahora cada
-- PQRS tiene un registro de gestión aparte: una fila por cada acción realizada (llamada al cliente,
-- respuesta enviada, revisión con un área, escalamiento, solución aplicada...) con su fecha, tipo, qué se
-- hizo y en qué quedó.
--
-- Reglas (todas en la base de datos; el frontend solo es UX):
--   - LECTURA: quien tiene el módulo 'pqrs' (user_has_module_pqrs('pqrs'): admin, gestor, lector o módulo
--     asignado), igual que la bitácora y los adjuntos.
--   - ESCRIBIR: solo los roles admin y gestor. BORRAR: solo admin. No hay UPDATE: un registro de gestión es
--     evidencia, igual que las notas de la bitácora; si algo quedó mal se registra una gestión nueva (o el
--     admin elimina la equivocada y queda constancia).
--   - Quién y cuándo lo registró (creado_por, creado_por_nombre, creado_en) lo sella el servidor: el
--     navegador no puede falsificarlo. fecha_gestion es la fecha en que SE HIZO la gestión (editable al
--     registrar, para poder anotar lo de ayer) y no puede ser futura (hora de Colombia).
--   - La bitácora de la PQRS recibe sola un evento por cada gestión registrada o eliminada, escrito por
--     trigger (los tipos nuevos NO se agregan a la policy de INSERT de pqrs_bitacora, así que el navegador no
--     puede inventarlos). El evento de eliminación conserva el texto borrado.
--
-- Requiere 0003, 0004, 0009, 0010 y 0029. Idempotente. Aplicar con apply_migration (MCP) ANTES de publicar
-- el frontend. No cambia el acceso de nadie ni toca datos existentes.
-- ============================================================

-- ── 1. Tabla ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pqrs_gestiones (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pqrs_id           bigint NOT NULL REFERENCES public.pqrs(id) ON DELETE CASCADE,
  fecha_gestion     date NOT NULL,
  tipo              text NOT NULL CHECK (tipo IN
    ('llamada','correo','whatsapp','visita','reunion','revision_interna','escalamiento','respuesta_cliente','solucion','otra')),
  descripcion       text NOT NULL CHECK (char_length(btrim(descripcion)) BETWEEN 3 AND 2000),
  resultado         text NOT NULL DEFAULT '' CHECK (char_length(resultado) <= 1000),
  creado_por        uuid,
  creado_por_nombre text,
  creado_en         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pqrs_gestiones_pqrs ON public.pqrs_gestiones (pqrs_id, fecha_gestion DESC, id DESC);

COMMENT ON TABLE public.pqrs_gestiones IS
  'Registro de gestión de cada PQRS: una fila por acción realizada por el equipo (llamada, respuesta, escalamiento, solución...). Solo se agrega o se elimina (admin); quién y cuándo lo sella el servidor.';

-- ── 2. Sello del servidor y validación (BEFORE INSERT) ──────
CREATE OR REPLACE FUNCTION public.pqrs_gestiones_antes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_nombre text;
BEGIN
  SELECT COALESCE(NULLIF(nombre, ''), email) INTO v_nombre FROM usuarios_pqrs WHERE id = auth.uid();
  NEW.creado_por        := auth.uid();
  NEW.creado_por_nombre := COALESCE(v_nombre, 'Sistema');
  NEW.creado_en         := now();
  NEW.descripcion       := btrim(NEW.descripcion);
  NEW.resultado         := btrim(COALESCE(NEW.resultado, ''));
  IF NEW.fecha_gestion > (now() AT TIME ZONE 'America/Bogota')::date THEN
    RAISE EXCEPTION 'La fecha de la gestión no puede ser futura';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.pqrs_gestiones_antes() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_pqrs_gestiones_antes ON public.pqrs_gestiones;
CREATE TRIGGER trg_pqrs_gestiones_antes
  BEFORE INSERT ON public.pqrs_gestiones
  FOR EACH ROW EXECUTE FUNCTION public.pqrs_gestiones_antes();

-- ── 3. Rastro en la bitácora de la PQRS ─────────────────────
ALTER TABLE public.pqrs_bitacora DROP CONSTRAINT IF EXISTS pqrs_bitacora_tipo_evento_check;
ALTER TABLE public.pqrs_bitacora ADD CONSTRAINT pqrs_bitacora_tipo_evento_check
  CHECK (tipo_evento IN ('creacion','cambio_estado','asignacion','nota','notificacion_enviada','adjunto_agregado','edicion_datos',
                         'gestion_registrada','gestion_eliminada'));
-- La policy pqrs_bitacora_insert (0010) NO cambia: estos dos tipos solo los escribe el trigger.

CREATE OR REPLACE FUNCTION public.pqrs_gestiones_bitacora()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_nombre text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO pqrs_bitacora (pqrs_id, tipo_evento, usuario_id, usuario_nombre, detalle)
    VALUES (NEW.pqrs_id, 'gestion_registrada', NEW.creado_por, NEW.creado_por_nombre,
            jsonb_build_object('gestion_id', NEW.id, 'tipo', NEW.tipo, 'fecha', NEW.fecha_gestion));
    RETURN NEW;
  END IF;

  -- DELETE. Si la PQRS entera se está borrando (ON DELETE CASCADE) ya no hay a qué colgar el evento.
  IF EXISTS (SELECT 1 FROM pqrs WHERE id = OLD.pqrs_id) THEN
    SELECT COALESCE(NULLIF(nombre, ''), email) INTO v_nombre FROM usuarios_pqrs WHERE id = auth.uid();
    INSERT INTO pqrs_bitacora (pqrs_id, tipo_evento, usuario_id, usuario_nombre, detalle)
    VALUES (OLD.pqrs_id, 'gestion_eliminada', auth.uid(), COALESCE(v_nombre, 'Sistema'),
            jsonb_build_object('gestion_id', OLD.id, 'tipo', OLD.tipo, 'fecha', OLD.fecha_gestion,
                               'descripcion', OLD.descripcion, 'resultado', OLD.resultado));
  END IF;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.pqrs_gestiones_bitacora() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_pqrs_gestiones_bitacora ON public.pqrs_gestiones;
CREATE TRIGGER trg_pqrs_gestiones_bitacora
  AFTER INSERT OR DELETE ON public.pqrs_gestiones
  FOR EACH ROW EXECUTE FUNCTION public.pqrs_gestiones_bitacora();

-- ── 4. RLS ──────────────────────────────────────────────────
ALTER TABLE public.pqrs_gestiones ENABLE ROW LEVEL SECURITY;

-- Solo lo necesario: sin UPDATE, sin TRUNCATE y nada para anon.
REVOKE ALL ON TABLE public.pqrs_gestiones FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.pqrs_gestiones TO authenticated;

-- (select ...) para que el planner evalúe la función una sola vez por consulta (patrón de 0009).
DROP POLICY IF EXISTS "pqrs_gestiones_select" ON public.pqrs_gestiones;
CREATE POLICY "pqrs_gestiones_select" ON public.pqrs_gestiones
  FOR SELECT TO authenticated
  USING ((select public.user_has_module_pqrs('pqrs')));

DROP POLICY IF EXISTS "pqrs_gestiones_insert" ON public.pqrs_gestiones;
CREATE POLICY "pqrs_gestiones_insert" ON public.pqrs_gestiones
  FOR INSERT TO authenticated
  WITH CHECK ((select public.get_user_role_pqrs()) = ANY (ARRAY['admin','gestor']));

DROP POLICY IF EXISTS "pqrs_gestiones_delete" ON public.pqrs_gestiones;
CREATE POLICY "pqrs_gestiones_delete" ON public.pqrs_gestiones
  FOR DELETE TO authenticated
  USING ((select public.get_user_role_pqrs()) = 'admin');

NOTIFY pgrst, 'reload schema';

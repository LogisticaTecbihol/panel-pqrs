-- ============================================================
-- 0045 — Tablero de Mercadeo: solo Laura Sanchez asigna responsables a las tareas
-- ============================================================
-- Hasta ahora cualquiera que pudiera gestionar Mercadeo (admin, rol mercadeo, gestor/sst con el módulo) cambiaba el campo
-- `responsables` de una tarjeta. Ahora SOLO la persona asignadora (hoy Laura Sanchez) puede fijarlo o cambiarlo; el resto del
-- equipo sigue creando, moviendo y editando tareas igual que antes, solo que no toca ese campo.
--
--  1. mercadeo_asignador_id(): el id de quien asigna. Un solo lugar: para cambiar de persona, CREATE OR REPLACE de esta función con
--     otro `usuarios_pqrs.id` (igual que mercadeo_responsable_eventos(), 0037).
--  2. trg_asignacion (BEFORE INSERT OR UPDATE en mercadeo_tareas): con sesión de usuario, si NO es el asignador y el conjunto de
--     responsables cambia (tarea nueva con responsables, o edición que los agrega/quita/cambia), rechaza con 42501. Se compara como
--     CONJUNTO (el orden no cuenta), así reenviar la misma lista no falla.
--     Pasan sin restricción: el puente de Pedidos y el SQL de mantenimiento (service_role, sin auth.uid()) y la tarea que crea el
--     trigger de eventos al aprobar (ya nace asignada por defecto, ver 0037; lleva el GUC mercadeo.creando_tarea_evento).
--     Ni el admin está exento: la regla es «la única persona». Si más adelante debe poder asignar, basta agregarlo a la condición.
--  3. mercadeo_quien_asigna(): RPC para que el Tablero sepa a quién mostrar y si la sesión actual es esa persona (la seguridad real es
--     el trigger; esto es solo para deshabilitar las casillas y avisar quién asigna). Devuelve una fila (id, nombre, yo) a quien tenga
--     acceso a Mercadeo; vacío a los demás. `anon` no puede ejecutarla.
--
-- No cambia nada de lo ya asignado. La bitácora de la tarea ya registra cada asignación (evento `asignacion`). Idempotente.
-- ============================================================

-- ── 1. Quién asigna ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mercadeo_asignador_id()
RETURNS uuid
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT '8472ca51-b16d-4c3c-b7bd-bc1bd9b5e897'::uuid;   -- Laura Sanchez
$$;
REVOKE ALL ON FUNCTION public.mercadeo_asignador_id() FROM PUBLIC, anon, authenticated;

-- ── 2. Trigger: nadie más cambia los responsables ────────────
CREATE OR REPLACE FUNCTION public.mercadeo_tareas_asignacion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_nuevo  uuid[];
  v_viejo  uuid[];
  v_nombre text;
BEGIN
  -- Puente de Pedidos, SQL de mantenimiento y triggers sin sesión.
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  -- La tarea que el trigger de eventos crea al aprobar nace asignada por defecto (mercadeo_responsable_eventos).
  IF COALESCE(current_setting('mercadeo.creando_tarea_evento', true), '') = 'on' THEN RETURN NEW; END IF;
  IF auth.uid() = public.mercadeo_asignador_id() THEN RETURN NEW; END IF;

  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), '{}'::uuid[]) INTO v_nuevo FROM unnest(COALESCE(NEW.responsables, '{}'::uuid[])) AS x;
  IF TG_OP = 'INSERT' THEN
    v_viejo := '{}'::uuid[];
  ELSE
    SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), '{}'::uuid[]) INTO v_viejo FROM unnest(COALESCE(OLD.responsables, '{}'::uuid[])) AS x;
  END IF;

  IF v_nuevo IS DISTINCT FROM v_viejo THEN
    SELECT COALESCE(NULLIF(u.nombre, ''), u.email) INTO v_nombre FROM usuarios_pqrs u WHERE u.id = public.mercadeo_asignador_id();
    RAISE EXCEPTION 'Solo % puede asignar responsables a las tareas del Tablero', COALESCE(v_nombre, 'la persona encargada')
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.mercadeo_tareas_asignacion() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_asignacion ON public.mercadeo_tareas;
CREATE TRIGGER trg_asignacion
  BEFORE INSERT OR UPDATE ON public.mercadeo_tareas
  FOR EACH ROW EXECUTE FUNCTION public.mercadeo_tareas_asignacion();

-- ── 3. RPC para la interfaz ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.mercadeo_quien_asigna()
RETURNS TABLE (id uuid, nombre text, yo boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT u.id, COALESCE(NULLIF(u.nombre, ''), u.email), (u.id = auth.uid())
  FROM usuarios_pqrs u
  WHERE u.id = public.mercadeo_asignador_id()
    AND public.user_has_module_pqrs('mercadeo');
$$;
REVOKE ALL ON FUNCTION public.mercadeo_quien_asigna() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mercadeo_quien_asigna() TO authenticated;

NOTIFY pgrst, 'reload schema';

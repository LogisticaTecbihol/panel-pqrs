-- ============================================================
-- "No contar en indicadores": excluir de los KPI las tareas de prueba (o creadas por error) sin borrarlas.
--
-- 1. Columna mercadeo_tareas.excluir_indicadores (por defecto false). La tarea sigue en el Tablero y conserva
--    su historial; el módulo Indicadores y CRM > Indicadores la ignoran (el filtro lo aplica la interfaz).
-- 2. Solo un administrador pone o quita la marca (trigger trg_excluir_indicadores): ocultar tareas de los KPI
--    no debe poder hacerlo cualquiera del equipo. Los procesos sin sesión (migraciones, service_role/puente de
--    Pedidos) pasan sin restricción; una tarea nueva de un no-admin nace siempre sin marca.
-- 3. Cada cambio de la marca queda en la bitácora de la tarea como 'cambio_datos' ({excluir_indicadores: {de, a}}),
--    con quién lo hizo (trigger trg_bitacora_excluir).
-- 4. Se marcaron las 3 solicitudes de prueba de Diana Marquez / PARCELAR (#47, #51 y #55; todas rechazadas) con un
--    UPDATE aparte (no va aquí: una migración no debe depender de ids concretos).
--
-- Requiere 0014. Idempotente. Aplicar con apply_migration (MCP) ANTES de publicar el frontend.
-- ============================================================

-- ── 1. Columna ───────────────────────────────────────────────
ALTER TABLE public.mercadeo_tareas ADD COLUMN IF NOT EXISTS excluir_indicadores boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.mercadeo_tareas.excluir_indicadores IS
  'true = tarea de prueba o creada por error: no cuenta en los indicadores (módulo Indicadores y CRM > Indicadores). Solo la cambia un administrador.';

-- ── 2. Solo un administrador cambia la marca ─────────────────
CREATE OR REPLACE FUNCTION public.mercadeo_tareas_excluir_indicadores()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND get_user_role_pqrs() IS DISTINCT FROM 'admin' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.excluir_indicadores := false;
    ELSIF NEW.excluir_indicadores IS DISTINCT FROM OLD.excluir_indicadores THEN
      RAISE EXCEPTION 'Solo un administrador puede excluir una tarea de los indicadores';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.mercadeo_tareas_excluir_indicadores() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_excluir_indicadores ON public.mercadeo_tareas;
CREATE TRIGGER trg_excluir_indicadores
  BEFORE INSERT OR UPDATE ON public.mercadeo_tareas
  FOR EACH ROW EXECUTE FUNCTION public.mercadeo_tareas_excluir_indicadores();

-- ── 3. Rastro en la bitácora ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.mercadeo_tareas_bitacora_excluir()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.excluir_indicadores IS DISTINCT FROM OLD.excluir_indicadores THEN
    INSERT INTO mercadeo_tarea_bitacora (tarea_id, tipo_evento, detalle)
    VALUES (NEW.id, 'cambio_datos',
            jsonb_build_object('excluir_indicadores', jsonb_build_object('de', OLD.excluir_indicadores, 'a', NEW.excluir_indicadores)));
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.mercadeo_tareas_bitacora_excluir() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_bitacora_excluir ON public.mercadeo_tareas;
CREATE TRIGGER trg_bitacora_excluir
  AFTER UPDATE OF excluir_indicadores ON public.mercadeo_tareas
  FOR EACH ROW EXECUTE FUNCTION public.mercadeo_tareas_bitacora_excluir();

NOTIFY pgrst, 'reload schema';

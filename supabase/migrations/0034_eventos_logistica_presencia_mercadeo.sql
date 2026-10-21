-- ============================================================
-- Eventos: nueva opción de «Logística y presencialidad» — «Se solicita presencia de Mercadeo»
--
-- Código: presencia_mercadeo. La pide el solicitante en Pedidos (Solicitudes de Eventos, formato MC-ISO-FO01) y llega con el evento.
--  1. mercadeo_eventos.logistica admite el código nuevo (CHECK mercadeo_eventos_logistica_check).
--  2. mercadeo_evento_brief(): el resumen del evento (y el brief de la tarea) muestra la etiqueta legible de la opción nueva.
--
-- La función del brief se reescribe a partir de su definición vigente (solo se amplía la lista c_log), así que no depende de
-- qué migración la dejó como está. Idempotente.
--
-- Orden de despliegue: aplicar esta migración (apply_migration) ANTES de redesplegar solicitud-evento-pedidos y publicar el frontend;
-- si no, un evento con la opción nueva fallaría el CHECK.
-- ============================================================

ALTER TABLE public.mercadeo_eventos DROP CONSTRAINT IF EXISTS mercadeo_eventos_logistica_check;
ALTER TABLE public.mercadeo_eventos ADD CONSTRAINT mercadeo_eventos_logistica_check
  CHECK (logistica <@ ARRAY['registros','coordinacion_logistica','plataforma_virtual','presencia_mercadeo']::text[]);

DO $$
DECLARE
  v_def text;
  v_viejo constant text := '"plataforma_virtual":"Apoyo en la configuración de la plataforma de evento virtual"}';
  v_nuevo constant text := '"plataforma_virtual":"Apoyo en la configuración de la plataforma de evento virtual","presencia_mercadeo":"Se solicita presencia de Mercadeo"}';
BEGIN
  v_def := pg_get_functiondef('public.mercadeo_evento_brief(public.mercadeo_eventos)'::regprocedure);
  IF position('presencia_mercadeo' IN v_def) > 0 THEN
    RETURN;   -- ya aplicada
  END IF;
  IF position(v_viejo IN v_def) = 0 THEN
    RAISE EXCEPTION 'mercadeo_evento_brief: no se encontró la lista c_log esperada; revisa la función antes de aplicar';
  END IF;
  EXECUTE replace(v_def, v_viejo, v_nuevo);
END;
$$;

NOTIFY pgrst, 'reload schema';

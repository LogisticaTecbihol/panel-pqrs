-- ============================================================
-- 0044 — Eventos -> Tablero: al marcar el evento «Realizada», su tarea pasa a «Entregada»
-- ============================================================
-- Hasta ahora el trigger trg_tarea (mercadeo_eventos_tarea) solo sincronizaba dos momentos:
--   * evento -> aprobada   : crea la tarea en «Recibido»;
--   * evento -> cancelada  : cancela la tarea si sigue abierta.
-- Cuando el evento pasaba a En preparación / Realizada / Cerrada la tarea no se movía, así que
-- los eventos ya hechos quedaban para siempre en «Recibido» (y como «vencidos» en los indicadores).
--
-- Ahora, al pasar el evento a «realizada» (OLD.estado <> 'realizada'), su tarea abierta
-- (solicitada / confirmada / en_produccion / en_validacion) pasa a «entregada». El servidor sella
-- entregada_en con la hora del cambio (mercadeo_tareas_reglas) y la bitácora de la tarea deja el
-- cambio_estado (con quién lo hizo: el usuario que marcó el evento).
--
-- Decisiones:
--  * La sincronización NUNCA debe impedir marcar el evento como realizado: si la tarea no se puede
--    mover (p. ej. alguien le borró el brief a una tarea todavía en «Recibido», lo que mercadeo_tareas_reglas
--    rechaza), el cambio del evento se guarda igual, la tarea se queda donde estaba y se emite un WARNING.
--  * Solo avanza: si el evento retrocede de «Realizada» (a Aprobada / En preparación) la tarea NO se
--    devuelve sola; quien corrija el estado del evento mueve la tarjeta a mano. Tampoco se toca una
--    tarea ya entregada, cancelada o rechazada.
--  * No se toca el resto de la función: es la definición vigente (0037) con una rama nueva.
-- ============================================================

CREATE OR REPLACE FUNCTION public.mercadeo_eventos_tarea()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tarea_id bigint;
BEGIN
  IF NEW.estado = 'aprobada' AND OLD.estado IN ('radicada','en_revision') THEN
    PERFORM set_config('mercadeo.creando_tarea_evento', 'on', true);
    INSERT INTO mercadeo_tareas (titulo, descripcion, tipo, prioridad, urgente, empresas, fecha_limite, evento_id, responsables)
    VALUES (left('Evento EV-' || NEW.id || ': ' || NEW.nombre || ' · ' || public.mercadeo_empresa_nombre(NEW.empresa, NEW.empresa_otra), 200),
            public.mercadeo_evento_brief(NEW),
            'evento', 'soporte_ventas', false, ARRAY[NEW.empresa], NEW.fecha_evento - 1, NEW.id, public.mercadeo_responsable_eventos())
    RETURNING id INTO v_tarea_id;
    PERFORM set_config('mercadeo.creando_tarea_evento', 'off', true);
    INSERT INTO mercadeo_evento_bitacora (evento_id, tipo_evento, detalle)
    VALUES (NEW.id, 'tarea_creada', jsonb_build_object('tarea_id', v_tarea_id));
  ELSIF NEW.estado = 'cancelada' AND OLD.estado <> 'cancelada' THEN
    UPDATE mercadeo_tareas SET estado = 'cancelada'
     WHERE evento_id = NEW.id AND estado IN ('solicitada','confirmada','en_produccion','en_validacion');
  ELSIF NEW.estado = 'realizada' AND OLD.estado <> 'realizada' THEN
    BEGIN
      UPDATE mercadeo_tareas SET estado = 'entregada'
       WHERE evento_id = NEW.id AND estado IN ('solicitada','confirmada','en_produccion','en_validacion');
    EXCEPTION WHEN OTHERS THEN
      -- El evento ya quedó como realizado; la tarea se mueve a mano desde el Tablero.
      RAISE WARNING 'No se pudo pasar a Entregada la tarea del evento EV-%: %', NEW.id, SQLERRM;
    END;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.mercadeo_eventos_tarea() FROM PUBLIC, anon, authenticated;

-- ── Corrección de lo que ya estaba hecho ─────────────────────
-- Tareas de eventos ya realizados / cerrados que quedaron abiertas. Idempotente: en una BD donde
-- no haya ninguna, no toca nada. entregada_en queda con la hora de esta migración (lo sella el
-- servidor), no con la fecha del evento.
UPDATE public.mercadeo_tareas t
   SET estado = 'entregada'
  FROM public.mercadeo_eventos e
 WHERE t.evento_id = e.id
   AND e.estado IN ('realizada','cerrada')
   AND t.estado IN ('solicitada','confirmada','en_produccion','en_validacion');

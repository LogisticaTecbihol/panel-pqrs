-- ============================================================
-- OBSERVACIONES del solicitante / aprobador hacia Mercadeo.
-- Mientras una solicitud de Pedidos sigue con Mercadeo (aprobada y aún no entregada ni cancelada),
-- quien la hizo, a nombre de quién se hizo, o un aprobador puede escribirle a Mercadeo una
-- observación o retroalimentación sobre los requisitos o especificaciones (p. ej. después de que
-- Mercadeo actualizó la solicitud). Es el camino inverso de 'respuesta_solicitante'.
--
-- 1. Bitácora: tipo nuevo 'observacion_solicitante' (texto de 5 a 1000 caracteres y quién la envía:
--    'solicitante' o 'aprobador'). El cliente NO puede insertarlo (la política de inserción solo
--    deja comentarios y respuestas): solo el puente de Pedidos (service_role), que ya verificó
--    sesión y permisos. El autor sale de detalle.solicitante_nombre (trigger mercadeo_bitacora_antes).
-- 2. Tipo de aviso 'observacion_solicitante' + trigger que avisa (campanita) a todo el equipo con
--    acceso a Mercadeo, con enlace a la tarjeta (?tarea=).
--
-- Requiere 0014, 0019 y 0022. Idempotente. Aplicar con apply_migration (MCP) ANTES de redesplegar
-- solicitud-mercadeo-pedidos.
-- ============================================================

-- ── 1. Bitácora ──────────────────────────────────────────────
ALTER TABLE public.mercadeo_tarea_bitacora DROP CONSTRAINT IF EXISTS mercadeo_tarea_bitacora_tipo_evento_check;
ALTER TABLE public.mercadeo_tarea_bitacora ADD CONSTRAINT mercadeo_tarea_bitacora_tipo_evento_check
  CHECK (tipo_evento IN
    ('creacion','cambio_estado','asignacion','cambio_datos','aval_registrado','comentario',
     'adjunto_agregado','adjunto_eliminado','respuesta_solicitante','observacion_solicitante'));

ALTER TABLE public.mercadeo_tarea_bitacora DROP CONSTRAINT IF EXISTS mercadeo_bitacora_observacion_check;
ALTER TABLE public.mercadeo_tarea_bitacora ADD CONSTRAINT mercadeo_bitacora_observacion_check
  CHECK (tipo_evento <> 'observacion_solicitante'
         OR (char_length(btrim(COALESCE(detalle->>'texto', ''))) BETWEEN 5 AND 1000
             AND COALESCE(detalle->>'como', '') IN ('solicitante', 'aprobador')));

-- ── 2. Aviso al equipo de Mercadeo ───────────────────────────
ALTER TABLE public.mercadeo_notificaciones DROP CONSTRAINT IF EXISTS mercadeo_notificaciones_tipo_check;
ALTER TABLE public.mercadeo_notificaciones ADD CONSTRAINT mercadeo_notificaciones_tipo_check
  CHECK (tipo IN ('solicitud_aprobada', 'solicitud_modificada', 'observacion_solicitante'));

CREATE OR REPLACE FUNCTION public.mercadeo_notificar_observacion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ref text;
  v_quien text := CASE WHEN NEW.detalle->>'como' = 'aprobador' THEN 'del aprobador' ELSE 'del solicitante' END;
  v_texto text := btrim(NEW.detalle->>'texto');
BEGIN
  SELECT CASE WHEN t.origen_numero IS NOT NULL THEN 'SM-' || t.origen_numero ELSE '#' || t.id END
    INTO v_ref FROM mercadeo_tareas t WHERE t.id = NEW.tarea_id;
  IF v_ref IS NULL THEN RETURN NULL; END IF;
  INSERT INTO mercadeo_notificaciones (para_usuario_id, tipo, tarea_id, titulo, mensaje)
  SELECT u.id, 'observacion_solicitante', NEW.tarea_id,
         '💬 Observación ' || v_quien || ' en la solicitud ' || v_ref,
         COALESCE(NEW.usuario_nombre, 'Sistema') || ': ' ||
           CASE WHEN char_length(v_texto) > 240 THEN left(v_texto, 237) || '…' ELSE v_texto END
  FROM usuarios_pqrs u
  WHERE u.activo = true AND (u.rol = 'admin' OR 'mercadeo' = ANY (u.modulos));
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.mercadeo_notificar_observacion() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_notificar_observacion ON public.mercadeo_tarea_bitacora;
CREATE TRIGGER trg_notificar_observacion
  AFTER INSERT ON public.mercadeo_tarea_bitacora
  FOR EACH ROW
  WHEN (NEW.tipo_evento = 'observacion_solicitante')
  EXECUTE FUNCTION public.mercadeo_notificar_observacion();

NOTIFY pgrst, 'reload schema';

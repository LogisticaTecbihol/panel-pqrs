-- ============================================================
-- El solicitante puede EDITAR su solicitud de Pedidos mientras no esté entregada ni cancelada.
-- Si ya estaba aprobada y en el Tablero, la tarjeta se RETIRA (estado 'rechazada', con el motivo) y
-- la solicitud vuelve a aprobación en Pedidos; al aprobarse de nuevo llega como tarea NUEVA (la
-- unicidad parcial de origen_ref de 0022 ya lo permite; los datos de origen de una tarea siguen
-- siendo inmutables, por eso no se edita la tarjeta en el sitio).
--
-- 1. mercadeo_tareas_rechazo: cuando el cambio lo hace el puente (service_role, sin auth.uid())
--    se respeta el nombre que manda (el solicitante). Con sesión de usuario sigue saliendo del
--    perfil, nunca del navegador.
-- 2. Tipo de aviso 'solicitud_modificada' + trigger que avisa (campanita) a todo el equipo con
--    acceso a Mercadeo cuando el puente retira una tarea. Si Mercadeo rechaza desde el Tablero
--    (hay auth.uid()) no se avisa: ya lo sabe.
--
-- Requiere 0022. Idempotente. Aplicar con apply_migration (MCP) ANTES de redesplegar
-- solicitud-mercadeo-pedidos.
-- ============================================================

-- ── 1. Quién rechaza: el puente puede indicar el nombre ──────
CREATE OR REPLACE FUNCTION public.mercadeo_tareas_rechazo()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_nombre text;
BEGIN
  IF OLD.estado = 'rechazada' THEN
    -- Estado final: no se reabre ni se reescribe el rechazo.
    NEW.estado := 'rechazada';
    NEW.motivo_rechazo := OLD.motivo_rechazo;
    NEW.rechazada_por_nombre := OLD.rechazada_por_nombre;
    NEW.rechazada_en := OLD.rechazada_en;
  ELSIF NEW.estado = 'rechazada' THEN
    IF OLD.origen <> 'panel_pedidos' THEN
      RAISE EXCEPTION 'Solo se rechazan solicitudes que llegan de Pedidos; una tarea propia se cancela';
    END IF;
    IF OLD.estado NOT IN ('solicitada','confirmada','en_produccion','en_validacion') THEN
      RAISE EXCEPTION 'Una solicitud entregada o cancelada ya no se puede rechazar';
    END IF;
    IF char_length(btrim(COALESCE(NEW.motivo_rechazo, ''))) < 3 THEN
      RAISE EXCEPTION 'Escribe el motivo del rechazo (mínimo 3 caracteres)';
    END IF;
    IF char_length(btrim(NEW.motivo_rechazo)) > 500 THEN
      RAISE EXCEPTION 'El motivo del rechazo no puede superar 500 caracteres';
    END IF;
    IF auth.uid() IS NULL THEN
      -- Puente de Pedidos (service_role): el solicitante modificó la solicitud y la tarea se retira.
      v_nombre := left(NULLIF(btrim(COALESCE(NEW.rechazada_por_nombre, '')), ''), 120);
    ELSE
      SELECT COALESCE(NULLIF(nombre, ''), email) INTO v_nombre FROM usuarios_pqrs WHERE id = auth.uid();
    END IF;
    NEW.motivo_rechazo := btrim(NEW.motivo_rechazo);
    NEW.rechazada_por_nombre := COALESCE(v_nombre, 'Sistema');
    NEW.rechazada_en := now();
  ELSE
    -- Sin rechazo: estos datos no se tocan desde el cliente.
    NEW.motivo_rechazo := OLD.motivo_rechazo;
    NEW.rechazada_por_nombre := OLD.rechazada_por_nombre;
    NEW.rechazada_en := OLD.rechazada_en;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.mercadeo_tareas_rechazo() FROM PUBLIC, anon, authenticated;

-- ── 2. Aviso al equipo cuando el solicitante retira la tarea ─
ALTER TABLE public.mercadeo_notificaciones DROP CONSTRAINT IF EXISTS mercadeo_notificaciones_tipo_check;
ALTER TABLE public.mercadeo_notificaciones ADD CONSTRAINT mercadeo_notificaciones_tipo_check
  CHECK (tipo IN ('solicitud_aprobada', 'solicitud_modificada'));

CREATE OR REPLACE FUNCTION public.mercadeo_notificar_retiro()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ref text := CASE WHEN NEW.origen_numero IS NOT NULL THEN 'SM-' || NEW.origen_numero ELSE '#' || NEW.id END;
  v_antes text := CASE OLD.estado
                    WHEN 'solicitada' THEN 'Recibido'
                    WHEN 'confirmada' THEN 'Confirmada'
                    WHEN 'en_produccion' THEN 'En producción'
                    WHEN 'en_validacion' THEN 'En validación'
                    ELSE OLD.estado END;
BEGIN
  -- Con sesión de usuario es Mercadeo rechazando desde el Tablero: ya lo sabe.
  IF auth.uid() IS NOT NULL THEN RETURN NULL; END IF;
  INSERT INTO mercadeo_notificaciones (para_usuario_id, tipo, tarea_id, titulo, mensaje)
  SELECT u.id, 'solicitud_modificada', NEW.id,
         '↩ Solicitud retirada del Tablero: ' || v_ref || ' (estaba en ' || v_antes || ')',
         NEW.motivo_rechazo
  FROM usuarios_pqrs u
  WHERE u.activo = true AND (u.rol = 'admin' OR 'mercadeo' = ANY (u.modulos));
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.mercadeo_notificar_retiro() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_notificar_retiro ON public.mercadeo_tareas;
CREATE TRIGGER trg_notificar_retiro
  AFTER UPDATE ON public.mercadeo_tareas
  FOR EACH ROW
  WHEN (NEW.origen = 'panel_pedidos' AND OLD.estado <> 'rechazada' AND NEW.estado = 'rechazada')
  EXECUTE FUNCTION public.mercadeo_notificar_retiro();

NOTIFY pgrst, 'reload schema';

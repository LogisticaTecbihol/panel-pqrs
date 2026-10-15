-- ============================================================
-- Aprobación previa en panel-pedidos: la solicitud llega aquí YA APROBADA.
--
-- Desde ahora una solicitud de Pedidos queda "Por aprobar" en panel-pedidos y
-- solo cuando un aprobador la aprueba la Edge Function del puente la crea en el
-- Tablero. Esto agrega a mercadeo_tareas:
--   - origen_numero    : N° que tiene la solicitud en Pedidos (para encontrarla
--                        desde los dos lados);
--   - aprobada_por_nombre / aprobada_en : quién y cuándo la aprobó allá.
--
-- Además se quita la validación "fecha tentativa >= hoy" del trigger de origen:
-- ahora una solicitud puede aprobarse días después de enviada y esa fecha es
-- solo informativa. La validación sigue en el formulario/funciones al ENVIAR.
--
-- Requiere 0019 y 0020. Idempotente. Aplicar con apply_migration (MCP) ANTES
-- de redesplegar la función solicitud-mercadeo-pedidos.
-- ============================================================

ALTER TABLE public.mercadeo_tareas
  ADD COLUMN IF NOT EXISTS origen_numero        integer,
  ADD COLUMN IF NOT EXISTS aprobada_por_nombre  text,
  ADD COLUMN IF NOT EXISTS aprobada_en          timestamptz;

COMMENT ON COLUMN public.mercadeo_tareas.origen_numero IS
  'N° de la solicitud en panel-pedidos (solicitudes_mercadeo.numero).';
COMMENT ON COLUMN public.mercadeo_tareas.aprobada_por_nombre IS
  'Quién aprobó la solicitud en panel-pedidos (o quien la envió si se aprobó sola).';

-- Misma función de 0020 sin la validación de fecha y con las columnas nuevas
-- (anuladas en tareas del Tablero; inmutables tras el INSERT).
CREATE OR REPLACE FUNCTION public.mercadeo_tareas_origen()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.origen = 'panel_pedidos' THEN
      -- Con sesión de usuario no se puede fingir una solicitud externa: solo el puente (service_role, sin auth.uid()).
      IF auth.uid() IS NOT NULL THEN
        RAISE EXCEPTION 'Las solicitudes de origen panel_pedidos solo las registra el puente de Pedidos';
      END IF;
      NEW.creado_por_nombre := NEW.solicitante_nombre;
      NEW.modificado_por_nombre := NEW.solicitante_nombre;
    ELSE
      -- Tarea creada desde el Tablero: nunca lleva datos de origen externo.
      NEW.origen_ref := NULL;
      NEW.origen_numero := NULL;
      NEW.solicitante_id := NULL;
      NEW.solicitante_nombre := NULL;
      NEW.solicitante_email := NULL;
      NEW.solicitante_rol := NULL;
      NEW.a_nombre_de_id := NULL;
      NEW.a_nombre_de_nombre := NULL;
      NEW.asunto := NULL;
      NEW.asunto_otro := NULL;
      NEW.fecha_tentativa := NULL;
      NEW.aprobada_por_nombre := NULL;
      NEW.aprobada_en := NULL;
    END IF;
  ELSE
    -- Lo que dijo el solicitante (y su aprobación) no se reescribe.
    NEW.origen := OLD.origen;
    NEW.origen_ref := OLD.origen_ref;
    NEW.origen_numero := OLD.origen_numero;
    NEW.solicitante_id := OLD.solicitante_id;
    NEW.solicitante_nombre := OLD.solicitante_nombre;
    NEW.solicitante_email := OLD.solicitante_email;
    NEW.solicitante_rol := OLD.solicitante_rol;
    NEW.a_nombre_de_id := OLD.a_nombre_de_id;
    NEW.a_nombre_de_nombre := OLD.a_nombre_de_nombre;
    NEW.asunto := OLD.asunto;
    NEW.asunto_otro := OLD.asunto_otro;
    NEW.fecha_tentativa := OLD.fecha_tentativa;
    NEW.aprobada_por_nombre := OLD.aprobada_por_nombre;
    NEW.aprobada_en := OLD.aprobada_en;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.mercadeo_tareas_origen() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- Asunto libre cuando la solicitud de Pedidos es de asunto "Otros".
--
-- El formulario de panel-pedidos muestra, solo si el asunto es "Otros", un campo
-- para escribir el asunto. Se guarda en mercadeo_tareas.asunto_otro:
--   - solo tiene sentido con asunto = 'otros' (CHECK), 3 a 100 caracteres;
--   - lo fija únicamente el puente y, como el resto de lo que dijo el
--     solicitante, queda inmutable después del INSERT (trigger trg_origen);
--   - las tareas creadas en el Tablero nunca lo traen (se anula).
-- Que sea obligatorio con "Otros" lo exigen las dos Edge Functions (no la BD),
-- para que un despliegue a medias nunca deje una solicitud sin guardar.
--
-- Requiere 0019. Idempotente. Aplicar con apply_migration (MCP) ANTES de
-- redesplegar la función solicitud-mercadeo-pedidos.
-- ============================================================

ALTER TABLE public.mercadeo_tareas
  ADD COLUMN IF NOT EXISTS asunto_otro text;

ALTER TABLE public.mercadeo_tareas DROP CONSTRAINT IF EXISTS mercadeo_tareas_asunto_otro_check;
ALTER TABLE public.mercadeo_tareas ADD CONSTRAINT mercadeo_tareas_asunto_otro_check
  CHECK (asunto_otro IS NULL
         OR (asunto = 'otros' AND char_length(btrim(asunto_otro)) BETWEEN 3 AND 100));

COMMENT ON COLUMN public.mercadeo_tareas.asunto_otro IS
  'Asunto escrito por el solicitante cuando asunto = ''otros'' (formulario de Pedidos).';

-- Misma función de 0019 con asunto_otro en las dos ramas (anulado en tareas del
-- Tablero; inmutable tras el INSERT).
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
      IF NEW.fecha_tentativa < (now() AT TIME ZONE 'America/Bogota')::date THEN
        RAISE EXCEPTION 'La fecha tentativa no puede ser anterior a hoy';
      END IF;
      NEW.creado_por_nombre := NEW.solicitante_nombre;
      NEW.modificado_por_nombre := NEW.solicitante_nombre;
    ELSE
      -- Tarea creada desde el Tablero: nunca lleva datos de origen externo.
      NEW.origen_ref := NULL;
      NEW.solicitante_id := NULL;
      NEW.solicitante_nombre := NULL;
      NEW.solicitante_email := NULL;
      NEW.solicitante_rol := NULL;
      NEW.a_nombre_de_id := NULL;
      NEW.a_nombre_de_nombre := NULL;
      NEW.asunto := NULL;
      NEW.asunto_otro := NULL;
      NEW.fecha_tentativa := NULL;
    END IF;
  ELSE
    -- Lo que dijo el solicitante no se reescribe (Mercadeo ajusta tipo, titulo, descripcion... como siempre).
    NEW.origen := OLD.origen;
    NEW.origen_ref := OLD.origen_ref;
    NEW.solicitante_id := OLD.solicitante_id;
    NEW.solicitante_nombre := OLD.solicitante_nombre;
    NEW.solicitante_email := OLD.solicitante_email;
    NEW.solicitante_rol := OLD.solicitante_rol;
    NEW.a_nombre_de_id := OLD.a_nombre_de_id;
    NEW.a_nombre_de_nombre := OLD.a_nombre_de_nombre;
    NEW.asunto := OLD.asunto;
    NEW.asunto_otro := OLD.asunto_otro;
    NEW.fecha_tentativa := OLD.fecha_tentativa;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.mercadeo_tareas_origen() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';

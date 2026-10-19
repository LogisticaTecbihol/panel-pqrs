-- ============================================================
-- Edición de respuestas de la Encuesta de Satisfacción (solo ADMIN).
--
-- Hasta ahora la tabla era inmutable (solo SELECT y DELETE para authenticated).
-- Ahora un admin puede corregir los DATOS y el COMENTARIO de una respuesta:
--   editable   : empresa_sigla, municipio, asesor_nombre, canal_adquisicion,
--                canal_adquisicion_otro, comentarios_adicionales
--   inmutable  : las 6 calificaciones y creado_en (lo que respondió el cliente
--                y cuándo llegó); un RAISE lo impide aunque la policy lo deje pasar.
--
-- Auditoría: modificado_por / modificado_por_nombre / modificado_en en la fila
-- (los pone el trigger, el navegador no los puede falsificar) y una fila por
-- edición en encuestas_satisfaccion_historial con los valores antes/después
-- (solo la lee un admin; solo la escribe el trigger).
--
-- Sin sesión (service_role: ingest-formulario, importación histórica, SQL de
-- mantenimiento) el trigger no interviene: esas rutas no son la edición del panel.
-- ============================================================

ALTER TABLE encuestas_satisfaccion
  ADD COLUMN IF NOT EXISTS modificado_por        uuid,
  ADD COLUMN IF NOT EXISTS modificado_por_nombre text,
  ADD COLUMN IF NOT EXISTS modificado_en         timestamptz;

-- ── Historial de ediciones ──
CREATE TABLE IF NOT EXISTS encuestas_satisfaccion_historial (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  encuesta_id           bigint NOT NULL REFERENCES encuestas_satisfaccion(id) ON DELETE CASCADE,
  modificado_por        uuid,
  modificado_por_nombre text NOT NULL,
  modificado_en         timestamptz NOT NULL DEFAULT now(),
  -- { "<campo>": { "antes": <valor>, "despues": <valor> }, ... } solo con los campos que cambiaron
  cambios               jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_encuestas_historial_encuesta
  ON encuestas_satisfaccion_historial (encuesta_id, modificado_en DESC);

ALTER TABLE encuestas_satisfaccion_historial ENABLE ROW LEVEL SECURITY;

CREATE POLICY "encuestas_historial_select" ON encuestas_satisfaccion_historial
  FOR SELECT TO authenticated
  USING (get_user_role_pqrs() = 'admin');

-- Sin policies de INSERT/UPDATE/DELETE: solo escribe el trigger (SECURITY DEFINER).
REVOKE ALL ON encuestas_satisfaccion_historial FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON encuestas_satisfaccion_historial FROM authenticated;

-- ── Quién puede editar: solo admin activo ──
CREATE POLICY "encuestas_satisfaccion_update" ON encuestas_satisfaccion
  FOR UPDATE TO authenticated
  USING (get_user_role_pqrs() = 'admin')
  WITH CHECK (get_user_role_pqrs() = 'admin');

-- ── Reglas de la edición + auditoría ──
CREATE OR REPLACE FUNCTION public.encuestas_satisfaccion_edicion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_nombre  text;
  v_cambios jsonb := '{}'::jsonb;
  v_campo   text;
BEGIN
  -- service_role / SQL de mantenimiento: sin sesión no hay a quién auditar.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- La policy ya limita el UPDATE a admins; se repite aquí por si algún día cambia.
  IF get_user_role_pqrs() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Solo un administrador puede editar las respuestas de la encuesta.';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.creado_en IS DISTINCT FROM OLD.creado_en THEN
    RAISE EXCEPTION 'La fecha de recepción de una respuesta no se puede modificar.';
  END IF;

  IF ROW(NEW.calificacion_calidad_producto, NEW.calificacion_atencion_asesor_tecnico,
         NEW.calificacion_atencion_servicio_logistica, NEW.calificacion_tiempos_respuesta,
         NEW.calificacion_relacion_calidad_precio, NEW.calificacion_satisfaccion_general)
     IS DISTINCT FROM
     ROW(OLD.calificacion_calidad_producto, OLD.calificacion_atencion_asesor_tecnico,
         OLD.calificacion_atencion_servicio_logistica, OLD.calificacion_tiempos_respuesta,
         OLD.calificacion_relacion_calidad_precio, OLD.calificacion_satisfaccion_general)
  THEN
    RAISE EXCEPTION 'Las calificaciones de una respuesta no se pueden modificar.';
  END IF;

  -- Normaliza solo lo que cambió: el dato histórico trae espacios sobrantes y un
  -- recorte masivo aparecería como "cambios" que el admin no hizo.
  IF NEW.municipio IS DISTINCT FROM OLD.municipio THEN
    NEW.municipio := btrim(NEW.municipio);
  END IF;
  IF NEW.asesor_nombre IS DISTINCT FROM OLD.asesor_nombre THEN
    NEW.asesor_nombre := NULLIF(btrim(COALESCE(NEW.asesor_nombre, '')), '');
  END IF;
  IF NEW.canal_adquisicion_otro IS DISTINCT FROM OLD.canal_adquisicion_otro THEN
    NEW.canal_adquisicion_otro := NULLIF(btrim(COALESCE(NEW.canal_adquisicion_otro, '')), '');
  END IF;
  IF NEW.comentarios_adicionales IS DISTINCT FROM OLD.comentarios_adicionales THEN
    NEW.comentarios_adicionales := NULLIF(btrim(COALESCE(NEW.comentarios_adicionales, '')), '');
  END IF;

  -- El texto de "Otro" solo tiene sentido con el canal 'Otro'.
  IF NEW.canal_adquisicion <> 'Otro' AND NEW.canal_adquisicion_otro IS NOT NULL THEN
    NEW.canal_adquisicion_otro := NULL;
  END IF;

  IF btrim(NEW.municipio) = '' THEN
    RAISE EXCEPTION 'El municipio es obligatorio.';
  END IF;
  IF length(NEW.municipio) > 100 OR length(COALESCE(NEW.asesor_nombre, '')) > 100
     OR length(COALESCE(NEW.canal_adquisicion_otro, '')) > 100 THEN
    RAISE EXCEPTION 'Municipio, asesor y canal "Otro" admiten máximo 100 caracteres.';
  END IF;
  IF length(COALESCE(NEW.comentarios_adicionales, '')) > 2000 THEN
    RAISE EXCEPTION 'Los comentarios admiten máximo 2000 caracteres.';
  END IF;

  -- Qué cambió de verdad.
  FOREACH v_campo IN ARRAY ARRAY['empresa_sigla', 'municipio', 'asesor_nombre',
                                 'canal_adquisicion', 'canal_adquisicion_otro', 'comentarios_adicionales']
  LOOP
    IF (to_jsonb(NEW) -> v_campo) IS DISTINCT FROM (to_jsonb(OLD) -> v_campo) THEN
      v_cambios := v_cambios || jsonb_build_object(v_campo,
        jsonb_build_object('antes', to_jsonb(OLD) -> v_campo, 'despues', to_jsonb(NEW) -> v_campo));
    END IF;
  END LOOP;

  IF v_cambios = '{}'::jsonb THEN
    -- Nada cambió: no se sella ni se registra (y se descarta lo que mande el navegador).
    NEW.modificado_por        := OLD.modificado_por;
    NEW.modificado_por_nombre := OLD.modificado_por_nombre;
    NEW.modificado_en         := OLD.modificado_en;
    RETURN NEW;
  END IF;

  SELECT COALESCE(NULLIF(nombre, ''), email) INTO v_nombre FROM usuarios_pqrs WHERE id = auth.uid();
  v_nombre := COALESCE(v_nombre, 'Administrador');

  NEW.modificado_por        := auth.uid();
  NEW.modificado_por_nombre := v_nombre;
  NEW.modificado_en         := now();

  INSERT INTO encuestas_satisfaccion_historial (encuesta_id, modificado_por, modificado_por_nombre, modificado_en, cambios)
  VALUES (OLD.id, NEW.modificado_por, v_nombre, NEW.modificado_en, v_cambios);

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.encuestas_satisfaccion_edicion() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_encuestas_satisfaccion_edicion ON encuestas_satisfaccion;
CREATE TRIGGER trg_encuestas_satisfaccion_edicion
  BEFORE UPDATE ON encuestas_satisfaccion
  FOR EACH ROW EXECUTE FUNCTION public.encuestas_satisfaccion_edicion();

NOTIFY pgrst, 'reload schema';

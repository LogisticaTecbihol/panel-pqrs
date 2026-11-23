-- ============================================================
-- Eventos: REGISTRO DE ASISTENTES (digitaliza la «Planilla de asistencia» en papel)
--
-- En cada evento los asistentes firman una planilla en papel (IASO «Registro de asistencia»): nombre completo, cédula, cultivo
-- principal, vereda o ubicación, hectáreas, teléfono, correo y si ya usó productos orgánicos / biorracionales (Sí/No). Mercadeo la
-- digita en el panel para tener la base de datos de asistentes que el manual pide entregar a los comerciales en 3 días hábiles.
--
--  1. Tabla mercadeo_evento_asistentes (una fila por persona; NO es mercadeo_evento_adjuntos ni el checklist).
--  2. Reglas (trigger): solo se escribe mientras el evento está Aprobada, En preparación o Realizada; normaliza el texto; la misma
--     cédula no se repite dentro de un evento; hasta 2000 por evento; quién y cuándo registró / modificó lo sella la BD.
--  3. Bitácora del evento: nuevo tipo 'asistente' (solo cuando se ELIMINA a alguien; el alta no se registra una por una para no
--     llenar la bitácora de ruido, y no se copia la cédula al registro: la bitácora sobrevive a la fila).
--  4. RPC mercadeo_evento_asistentes_conteo(): cuántos asistentes tiene cada evento (para el botón de la lista, sin leer toda la tabla).
--  5. RLS: solo el módulo `mercadeo` lee y escribe (admin siempre pasa); anon no entra.
--
-- DATOS PERSONALES (cédula, teléfono, correo): internos de Mercadeo. NO salen hacia panel-pedidos (la función puente
-- `solicitud-evento-pedidos` no los lee) ni al PDF de la solicitud (solo muestra el avance del checklist).
-- Idempotente. Aplicar con apply_migration (MCP) ANTES de publicar el frontend.
-- ============================================================

-- ── 1. Tabla ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mercadeo_evento_asistentes (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  evento_id            bigint NOT NULL REFERENCES public.mercadeo_eventos(id) ON DELETE CASCADE,
  nombre               text NOT NULL,                    -- «Nombre completo»
  cedula               text,                             -- «Número de cédula» (tal como se escribió; también admite CE / pasaporte)
  cedula_clave         text,                             -- cédula sin puntos, guiones ni espacios y en minúsculas: la fija el trigger (evita repetidos)
  cultivo              text,                             -- «Cultivo principal»
  vereda               text,                             -- «Vereda o ubicación»
  hectareas            numeric(10,2),                    -- «Número de hectáreas»
  telefono             text,
  correo               text,
  usa_organicos        boolean,                          -- «¿Ha usado productos orgánicos/biorracionales?»  true = Sí, false = No, NULL = sin dato
  creado_por           uuid,
  creado_por_nombre    text,
  creado_en            timestamptz NOT NULL DEFAULT now(),
  modificado_por       uuid,
  modificado_por_nombre text,
  modificado_en        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mercadeo_evento_asis_nombre_check   CHECK (char_length(nombre) BETWEEN 3 AND 120),
  CONSTRAINT mercadeo_evento_asis_cedula_check   CHECK (cedula IS NULL OR char_length(cedula) BETWEEN 4 AND 20),
  CONSTRAINT mercadeo_evento_asis_cultivo_check  CHECK (cultivo IS NULL OR char_length(cultivo) <= 100),
  CONSTRAINT mercadeo_evento_asis_vereda_check   CHECK (vereda IS NULL OR char_length(vereda) <= 120),
  CONSTRAINT mercadeo_evento_asis_ha_check       CHECK (hectareas IS NULL OR (hectareas >= 0 AND hectareas <= 100000)),
  CONSTRAINT mercadeo_evento_asis_telefono_check CHECK (telefono IS NULL OR char_length(telefono) <= 40),
  CONSTRAINT mercadeo_evento_asis_correo_check   CHECK (correo IS NULL OR (char_length(correo) <= 160 AND correo ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'))
);
CREATE INDEX IF NOT EXISTS mercadeo_evento_asistentes_evento ON public.mercadeo_evento_asistentes (evento_id);
-- Respaldo de la regla del trigger (dos personas digitando la misma cédula a la vez).
CREATE UNIQUE INDEX IF NOT EXISTS mercadeo_evento_asistentes_cedula_uq
  ON public.mercadeo_evento_asistentes (evento_id, cedula_clave) WHERE cedula_clave IS NOT NULL;
COMMENT ON TABLE public.mercadeo_evento_asistentes IS
  'Asistentes de un evento (planilla de asistencia digitada). Datos personales: internos de Mercadeo, no se exponen a Pedidos ni al PDF.';

-- ── 2. Reglas ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mercadeo_evento_asistentes_reglas()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_evento bigint;
  v_estado text;
  v_nombre text;
  v_dup    text;
BEGIN
  -- El evento de un asistente no cambia nunca. Se fija ANTES de comprobar nada: si no, un UPDATE con el evento_id de otro evento
  -- pasaría la regla de estado y la de cédula repetida contra ESE evento y no contra al que el asistente pertenece de verdad.
  IF TG_OP = 'UPDATE' THEN NEW.evento_id := OLD.evento_id; END IF;
  v_evento := CASE WHEN TG_OP = 'DELETE' THEN OLD.evento_id ELSE NEW.evento_id END;
  SELECT estado INTO v_estado FROM mercadeo_eventos WHERE id = v_evento;

  -- Si el evento ya no existe, el borrado viene en cascada: se deja pasar.
  IF TG_OP = 'DELETE' AND v_estado IS NULL THEN
    RETURN OLD;
  END IF;
  IF v_estado IS NULL OR v_estado NOT IN ('aprobada', 'en_preparacion', 'realizada') THEN
    RAISE EXCEPTION 'Los asistentes solo se registran o modifican mientras el evento está Aprobada, En preparación o Realizada';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  SELECT COALESCE(NULLIF(nombre, ''), email) INTO v_nombre FROM usuarios_pqrs WHERE id = auth.uid();
  v_nombre := COALESCE(v_nombre, 'Sistema');

  -- Normaliza: espacios repetidos fuera, vacío = sin dato, correo en minúsculas.
  NEW.nombre    := btrim(regexp_replace(COALESCE(NEW.nombre, ''), '\s+', ' ', 'g'));
  NEW.cedula    := NULLIF(btrim(regexp_replace(COALESCE(NEW.cedula, ''), '\s+', ' ', 'g')), '');
  NEW.cultivo   := NULLIF(btrim(regexp_replace(COALESCE(NEW.cultivo, ''), '\s+', ' ', 'g')), '');
  NEW.vereda    := NULLIF(btrim(regexp_replace(COALESCE(NEW.vereda, ''), '\s+', ' ', 'g')), '');
  NEW.telefono  := NULLIF(btrim(regexp_replace(COALESCE(NEW.telefono, ''), '\s+', ' ', 'g')), '');
  NEW.correo    := NULLIF(lower(btrim(COALESCE(NEW.correo, ''))), '');
  NEW.cedula_clave := CASE WHEN NEW.cedula IS NULL THEN NULL
                           ELSE NULLIF(regexp_replace(lower(NEW.cedula), '[^a-z0-9]', '', 'g'), '') END;

  -- La misma cédula no se registra dos veces en el mismo evento (dos planillas, dos personas digitando…).
  IF NEW.cedula_clave IS NOT NULL THEN
    SELECT a.nombre INTO v_dup
      FROM mercadeo_evento_asistentes a
     WHERE a.evento_id = NEW.evento_id
       AND a.cedula_clave = NEW.cedula_clave
       AND (TG_OP = 'INSERT' OR a.id <> NEW.id)
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'La cédula % ya está registrada en este evento (%)', NEW.cedula, v_dup;
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF (SELECT count(*) FROM mercadeo_evento_asistentes a WHERE a.evento_id = NEW.evento_id) >= 2000 THEN
      RAISE EXCEPTION 'Un evento admite hasta 2000 asistentes registrados';
    END IF;
    NEW.creado_por := auth.uid();
    NEW.creado_por_nombre := v_nombre;
    NEW.creado_en := now();
    NEW.modificado_por := auth.uid();
    NEW.modificado_por_nombre := v_nombre;
    NEW.modificado_en := now();
  ELSE
    -- Inmutables (evento_id ya quedó fijado al inicio)
    NEW.creado_por := OLD.creado_por;
    NEW.creado_por_nombre := OLD.creado_por_nombre;
    NEW.creado_en := OLD.creado_en;
    -- «Modificado por» solo cambia si algo cambió de verdad.
    IF (NEW.nombre, NEW.cedula, NEW.cultivo, NEW.vereda, NEW.hectareas, NEW.telefono, NEW.correo, NEW.usa_organicos)
         IS NOT DISTINCT FROM
       (OLD.nombre, OLD.cedula, OLD.cultivo, OLD.vereda, OLD.hectareas, OLD.telefono, OLD.correo, OLD.usa_organicos) THEN
      NEW.modificado_por := OLD.modificado_por;
      NEW.modificado_por_nombre := OLD.modificado_por_nombre;
      NEW.modificado_en := OLD.modificado_en;
    ELSE
      NEW.modificado_por := auth.uid();
      NEW.modificado_por_nombre := v_nombre;
      NEW.modificado_en := now();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.mercadeo_evento_asistentes_reglas() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_asistentes_reglas ON public.mercadeo_evento_asistentes;
CREATE TRIGGER trg_asistentes_reglas
  BEFORE INSERT OR UPDATE OR DELETE ON public.mercadeo_evento_asistentes
  FOR EACH ROW EXECUTE FUNCTION public.mercadeo_evento_asistentes_reglas();

-- ── 3. Bitácora ──────────────────────────────────────────────
ALTER TABLE public.mercadeo_evento_bitacora DROP CONSTRAINT IF EXISTS mercadeo_evento_bitacora_tipo_evento_check;
ALTER TABLE public.mercadeo_evento_bitacora ADD CONSTRAINT mercadeo_evento_bitacora_tipo_evento_check CHECK (tipo_evento IN
  ('creacion','cambio_estado','cambio_datos','comentario','respuesta_solicitante','observacion_solicitante',
   'adjunto_agregado','adjunto_eliminado','tarea_creada','actividad','asistente'));

-- Solo se deja constancia de quién ELIMINÓ a una persona (sin su cédula: la bitácora sobrevive a la fila). Si se está borrando el evento
-- entero (cascada) no se registra: la bitácora también se borra.
CREATE OR REPLACE FUNCTION public.mercadeo_evento_asistentes_bitacora()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM mercadeo_eventos WHERE id = OLD.evento_id) THEN
    INSERT INTO mercadeo_evento_bitacora (evento_id, tipo_evento, detalle)
    VALUES (OLD.evento_id, 'asistente', jsonb_build_object('accion', 'eliminado', 'nombre', OLD.nombre));
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.mercadeo_evento_asistentes_bitacora() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_asistentes_bitacora ON public.mercadeo_evento_asistentes;
CREATE TRIGGER trg_asistentes_bitacora
  AFTER DELETE ON public.mercadeo_evento_asistentes
  FOR EACH ROW EXECUTE FUNCTION public.mercadeo_evento_asistentes_bitacora();

-- ── 4. Conteo por evento ─────────────────────────────────────
-- SECURITY INVOKER: pasa por la RLS de la tabla, así que quien no tiene el módulo `mercadeo` recibe 0 filas.
CREATE OR REPLACE FUNCTION public.mercadeo_evento_asistentes_conteo()
RETURNS TABLE (evento_id bigint, total bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT a.evento_id, count(*)::bigint FROM mercadeo_evento_asistentes a GROUP BY a.evento_id
$$;
REVOKE ALL ON FUNCTION public.mercadeo_evento_asistentes_conteo() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mercadeo_evento_asistentes_conteo() TO authenticated;

-- ── 5. RLS ───────────────────────────────────────────────────
ALTER TABLE public.mercadeo_evento_asistentes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mercadeo_evento_asistentes FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.mercadeo_evento_asistentes TO authenticated;

DROP POLICY IF EXISTS "mercadeo_evento_asistentes_select" ON public.mercadeo_evento_asistentes;
CREATE POLICY "mercadeo_evento_asistentes_select" ON public.mercadeo_evento_asistentes FOR SELECT TO authenticated
  USING ((select public.user_has_module_pqrs('mercadeo')));
DROP POLICY IF EXISTS "mercadeo_evento_asistentes_insert" ON public.mercadeo_evento_asistentes;
CREATE POLICY "mercadeo_evento_asistentes_insert" ON public.mercadeo_evento_asistentes FOR INSERT TO authenticated
  WITH CHECK ((select public.user_has_module_pqrs('mercadeo')));
DROP POLICY IF EXISTS "mercadeo_evento_asistentes_update" ON public.mercadeo_evento_asistentes;
CREATE POLICY "mercadeo_evento_asistentes_update" ON public.mercadeo_evento_asistentes FOR UPDATE TO authenticated
  USING ((select public.user_has_module_pqrs('mercadeo')))
  WITH CHECK ((select public.user_has_module_pqrs('mercadeo')));
DROP POLICY IF EXISTS "mercadeo_evento_asistentes_delete" ON public.mercadeo_evento_asistentes;
CREATE POLICY "mercadeo_evento_asistentes_delete" ON public.mercadeo_evento_asistentes FOR DELETE TO authenticated
  USING ((select public.user_has_module_pqrs('mercadeo')));

NOTIFY pgrst, 'reload schema';

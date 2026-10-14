-- ============================================================
-- Solicitudes a Mercadeo que llegan desde panel-pedidos.
--
-- Un usuario de panel-pedidos diligencia un formulario allá (Solicitante,
-- Empresa, Asunto, Fecha tentativa, Descripción, Adjuntos; estado inicial
-- "Recibido") y la solicitud nace como una tarea del Tablero de Mercadeo en
-- la primera columna (estado 'solicitada', cuya ETIQUETA pasa a "Recibido";
-- el código no cambia). Mercadeo la gestiona aquí con las reglas de siempre.
--
-- El puente es la Edge Function `solicitud-mercadeo-pedidos` (service_role +
-- secreto compartido): ninguna policy RLS abre escritura a anon. Esta
-- migración solo agrega lo que la función necesita y endurece lo que el
-- navegador no debe poder falsificar.
--
--  1. mercadeo_tareas: origen, origen_ref (idempotencia), solicitante,
--     "a nombre de" (comercial), asunto y fecha tentativa.
--  2. Trigger BEFORE mercadeo_tareas_origen: el origen externo solo lo puede
--     fijar el puente (sin sesión); esas columnas son inmutables después;
--     el creador se muestra con el nombre del solicitante.
--  3. Bitácora: tipo 'respuesta_solicitante' (lo único que ve el solicitante
--     además de los cambios de estado) y nombre del solicitante en los
--     eventos escritos por el puente.
--  4. Adjuntos: subido_por_nombre (los archivos los sube el solicitante,
--     que no tiene cuenta en este proyecto).
--
-- Requiere 0012-0014. Idempotente. Aplicar con apply_migration (MCP) ANTES
-- de desplegar la Edge Function y de publicar el frontend.
-- ============================================================

-- ── 1. Columnas nuevas en mercadeo_tareas ────────────────────
ALTER TABLE public.mercadeo_tareas
  ADD COLUMN IF NOT EXISTS origen             text NOT NULL DEFAULT 'panel_mercadeo',
  ADD COLUMN IF NOT EXISTS origen_ref         uuid,
  ADD COLUMN IF NOT EXISTS solicitante_id     text,
  ADD COLUMN IF NOT EXISTS solicitante_nombre text,
  ADD COLUMN IF NOT EXISTS solicitante_email  text,
  ADD COLUMN IF NOT EXISTS solicitante_rol    text,
  ADD COLUMN IF NOT EXISTS a_nombre_de_id     text,
  ADD COLUMN IF NOT EXISTS a_nombre_de_nombre text,
  ADD COLUMN IF NOT EXISTS asunto             text,
  ADD COLUMN IF NOT EXISTS fecha_tentativa    date;

ALTER TABLE public.mercadeo_tareas DROP CONSTRAINT IF EXISTS mercadeo_tareas_origen_check;
ALTER TABLE public.mercadeo_tareas ADD CONSTRAINT mercadeo_tareas_origen_check
  CHECK (origen IN ('panel_mercadeo', 'panel_pedidos'));

ALTER TABLE public.mercadeo_tareas DROP CONSTRAINT IF EXISTS mercadeo_tareas_asunto_check;
ALTER TABLE public.mercadeo_tareas ADD CONSTRAINT mercadeo_tareas_asunto_check
  CHECK (asunto IS NULL OR asunto IN (
    'material_pop', 'material_impreso', 'piezas_graficas', 'piezas_audiovisuales',
    'diseno_nuevo_producto', 'diseno_ajuste_portafolios', 'diseno_ajuste_institucional',
    'desarrollo_marca', 'otros'));

-- "A nombre de": o ambos datos o ninguno.
ALTER TABLE public.mercadeo_tareas DROP CONSTRAINT IF EXISTS mercadeo_tareas_a_nombre_check;
ALTER TABLE public.mercadeo_tareas ADD CONSTRAINT mercadeo_tareas_a_nombre_check
  CHECK ((a_nombre_de_id IS NULL) = (a_nombre_de_nombre IS NULL));

-- Una solicitud que viene de Pedidos llega completa (lo exige la BD, no solo la función).
ALTER TABLE public.mercadeo_tareas DROP CONSTRAINT IF EXISTS mercadeo_tareas_pedidos_completa_check;
ALTER TABLE public.mercadeo_tareas ADD CONSTRAINT mercadeo_tareas_pedidos_completa_check
  CHECK (origen = 'panel_mercadeo' OR (
    origen_ref IS NOT NULL
    AND solicitante_id IS NOT NULL
    AND btrim(COALESCE(solicitante_nombre, '')) <> ''
    AND asunto IS NOT NULL
    AND fecha_tentativa IS NOT NULL
    AND cardinality(empresas) = 1
    AND char_length(btrim(descripcion)) >= 10));

CREATE UNIQUE INDEX IF NOT EXISTS mercadeo_tareas_origen_ref_uk
  ON public.mercadeo_tareas (origen_ref) WHERE origen_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS mercadeo_tareas_solicitante
  ON public.mercadeo_tareas (solicitante_id) WHERE solicitante_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mercadeo_tareas_a_nombre_de
  ON public.mercadeo_tareas (a_nombre_de_id) WHERE a_nombre_de_id IS NOT NULL;

COMMENT ON COLUMN public.mercadeo_tareas.origen IS
  'panel_mercadeo = creada en este tablero; panel_pedidos = solicitud enviada desde panel-pedidos por el puente.';
COMMENT ON COLUMN public.mercadeo_tareas.origen_ref IS
  'UUID que genera el formulario de Pedidos en cada envio: un doble clic o un reintento no duplica la solicitud.';
COMMENT ON COLUMN public.mercadeo_tareas.fecha_tentativa IS
  'Fecha que el solicitante dice necesitar. NO es compromiso: la fecha comprometida es fecha_limite (la fija Mercadeo).';

-- ── 2. Origen: solo el puente lo fija; inmutable después ─────
-- Dispara DESPUES de trg_auditoria (orden alfabético) para poder sustituir el
-- nombre "Sistema" por el del solicitante, y antes de trg_reglas.
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
    NEW.fecha_tentativa := OLD.fecha_tentativa;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.mercadeo_tareas_origen() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_origen ON public.mercadeo_tareas;
CREATE TRIGGER trg_origen
  BEFORE INSERT OR UPDATE ON public.mercadeo_tareas
  FOR EACH ROW EXECUTE FUNCTION public.mercadeo_tareas_origen();

-- ── 3. Bitácora ──────────────────────────────────────────────
-- 3a. Tipo nuevo 'respuesta_solicitante' (mensaje de Mercadeo visible al solicitante).
ALTER TABLE public.mercadeo_tarea_bitacora DROP CONSTRAINT IF EXISTS mercadeo_tarea_bitacora_tipo_evento_check;
ALTER TABLE public.mercadeo_tarea_bitacora ADD CONSTRAINT mercadeo_tarea_bitacora_tipo_evento_check
  CHECK (tipo_evento IN
    ('creacion','cambio_estado','asignacion','cambio_datos','aval_registrado','comentario',
     'adjunto_agregado','adjunto_eliminado','respuesta_solicitante'));

ALTER TABLE public.mercadeo_tarea_bitacora DROP CONSTRAINT IF EXISTS mercadeo_bitacora_respuesta_check;
ALTER TABLE public.mercadeo_tarea_bitacora ADD CONSTRAINT mercadeo_bitacora_respuesta_check
  CHECK (tipo_evento <> 'respuesta_solicitante'
         OR char_length(btrim(COALESCE(detalle->>'texto', ''))) BETWEEN 1 AND 2000);

-- 3b. El cliente solo inserta comentarios y respuestas (estas, solo en tareas de Pedidos).
DROP POLICY IF EXISTS "mercadeo_tarea_bitacora_insert" ON public.mercadeo_tarea_bitacora;
CREATE POLICY "mercadeo_tarea_bitacora_insert" ON public.mercadeo_tarea_bitacora FOR INSERT TO authenticated
  WITH CHECK (
    (select public.user_has_module_pqrs('mercadeo'))
    AND (
      tipo_evento = 'comentario'
      OR (tipo_evento = 'respuesta_solicitante'
          AND EXISTS (SELECT 1 FROM public.mercadeo_tareas t
                      WHERE t.id = tarea_id AND t.origen = 'panel_pedidos'))
    )
  );

-- 3c. Autor del evento: la sesión; sin sesión (puente/cron), el solicitante si el evento lo declara.
CREATE OR REPLACE FUNCTION public.mercadeo_bitacora_antes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.usuario_id := auth.uid();
  IF NEW.usuario_id IS NULL THEN
    NEW.usuario_nombre := COALESCE(NULLIF(btrim(NEW.detalle->>'solicitante_nombre'), ''), 'Sistema');
  ELSE
    SELECT COALESCE(NULLIF(nombre, ''), email) INTO NEW.usuario_nombre FROM usuarios_pqrs WHERE id = auth.uid();
    NEW.usuario_nombre := COALESCE(NEW.usuario_nombre, 'Sistema');
  END IF;
  NEW.creado_en := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.mercadeo_bitacora_antes() FROM PUBLIC, anon, authenticated;

-- 3d. Evento 'creacion' con el origen (resto de la función idéntico a 0014).
CREATE OR REPLACE FUNCTION public.mercadeo_tareas_bitacora()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cambios jsonb := '{}'::jsonb;
  v_de text[];
  v_a text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO mercadeo_tarea_bitacora (tarea_id, tipo_evento, detalle)
    VALUES (NEW.id, 'creacion',
            jsonb_build_object('titulo', NEW.titulo, 'estado', NEW.estado)
            || CASE WHEN NEW.origen = 'panel_pedidos'
                    THEN jsonb_build_object('origen', 'panel_pedidos',
                                            'solicitante_nombre', NEW.solicitante_nombre,
                                            'a_nombre_de', NEW.a_nombre_de_nombre,
                                            'asunto', NEW.asunto)
                    ELSE '{}'::jsonb END);
    IF NEW.aval_registrado_en IS NOT NULL THEN
      INSERT INTO mercadeo_tarea_bitacora (tarea_id, tipo_evento, detalle)
      VALUES (NEW.id, 'aval_registrado', jsonb_build_object('por', NEW.aval_por, 'referencia', NEW.aval_referencia, 'motivo', NEW.aval_motivo));
    END IF;
    RETURN NULL;
  END IF;

  IF NEW.estado IS DISTINCT FROM OLD.estado THEN
    INSERT INTO mercadeo_tarea_bitacora (tarea_id, tipo_evento, detalle)
    VALUES (NEW.id, 'cambio_estado', jsonb_build_object('de', OLD.estado, 'a', NEW.estado));
  END IF;

  IF NEW.responsables IS DISTINCT FROM OLD.responsables THEN
    SELECT COALESCE(array_agg(COALESCE(NULLIF(u.nombre, ''), u.email) ORDER BY u.nombre), '{}') INTO v_de
      FROM usuarios_pqrs u WHERE u.id = ANY (OLD.responsables);
    SELECT COALESCE(array_agg(COALESCE(NULLIF(u.nombre, ''), u.email) ORDER BY u.nombre), '{}') INTO v_a
      FROM usuarios_pqrs u WHERE u.id = ANY (NEW.responsables);
    INSERT INTO mercadeo_tarea_bitacora (tarea_id, tipo_evento, detalle)
    VALUES (NEW.id, 'asignacion', jsonb_build_object('de', to_jsonb(v_de), 'a', to_jsonb(v_a)));
  END IF;

  IF NEW.aval_registrado_en IS NOT NULL AND NEW.aval_registrado_en IS DISTINCT FROM OLD.aval_registrado_en THEN
    INSERT INTO mercadeo_tarea_bitacora (tarea_id, tipo_evento, detalle)
    VALUES (NEW.id, 'aval_registrado', jsonb_build_object('por', NEW.aval_por, 'referencia', NEW.aval_referencia, 'motivo', NEW.aval_motivo));
  END IF;

  IF NEW.titulo IS DISTINCT FROM OLD.titulo THEN
    v_cambios := v_cambios || jsonb_build_object('titulo', jsonb_build_object('de', OLD.titulo, 'a', NEW.titulo));
  END IF;
  IF NEW.descripcion IS DISTINCT FROM OLD.descripcion THEN
    v_cambios := v_cambios || jsonb_build_object('descripcion', true);
  END IF;
  IF NEW.tipo IS DISTINCT FROM OLD.tipo THEN
    v_cambios := v_cambios || jsonb_build_object('tipo', jsonb_build_object('de', OLD.tipo, 'a', NEW.tipo));
  END IF;
  IF NEW.prioridad IS DISTINCT FROM OLD.prioridad THEN
    v_cambios := v_cambios || jsonb_build_object('prioridad', jsonb_build_object('de', OLD.prioridad, 'a', NEW.prioridad));
  END IF;
  IF NEW.urgente IS DISTINCT FROM OLD.urgente THEN
    v_cambios := v_cambios || jsonb_build_object('urgente', jsonb_build_object('de', OLD.urgente, 'a', NEW.urgente));
  END IF;
  IF NEW.actividad_id IS DISTINCT FROM OLD.actividad_id THEN
    v_cambios := v_cambios || jsonb_build_object('actividad_id', jsonb_build_object('de', OLD.actividad_id, 'a', NEW.actividad_id));
  END IF;
  IF NEW.empresas IS DISTINCT FROM OLD.empresas THEN
    v_cambios := v_cambios || jsonb_build_object('empresas', jsonb_build_object('de', to_jsonb(OLD.empresas), 'a', to_jsonb(NEW.empresas)));
  END IF;
  IF NEW.fecha_limite IS DISTINCT FROM OLD.fecha_limite THEN
    v_cambios := v_cambios || jsonb_build_object('fecha_limite', jsonb_build_object('de', OLD.fecha_limite, 'a', NEW.fecha_limite));
  END IF;
  IF v_cambios <> '{}'::jsonb THEN
    INSERT INTO mercadeo_tarea_bitacora (tarea_id, tipo_evento, detalle)
    VALUES (NEW.id, 'cambio_datos', v_cambios);
  END IF;

  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.mercadeo_tareas_bitacora() FROM PUBLIC, anon, authenticated;

-- ── 4. Adjuntos subidos por el solicitante ───────────────────
-- subido_por ya admite NULL (sin cuenta aquí); el nombre queda desnormalizado.
ALTER TABLE public.mercadeo_tarea_adjuntos
  ADD COLUMN IF NOT EXISTS subido_por_nombre text;

CREATE OR REPLACE FUNCTION public.mercadeo_adjuntos_bitacora()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO mercadeo_tarea_bitacora (tarea_id, tipo_evento, detalle)
    VALUES (NEW.tarea_id, 'adjunto_agregado',
            jsonb_build_object('nombre', NEW.nombre_original)
            || CASE WHEN NEW.subido_por IS NULL AND NEW.subido_por_nombre IS NOT NULL
                    THEN jsonb_build_object('solicitante_nombre', NEW.subido_por_nombre)
                    ELSE '{}'::jsonb END);
  ELSIF EXISTS (SELECT 1 FROM mercadeo_tareas WHERE id = OLD.tarea_id) THEN
    -- Si la tarea se está borrando (cascada) no se registra: la bitácora también se borra.
    INSERT INTO mercadeo_tarea_bitacora (tarea_id, tipo_evento, detalle)
    VALUES (OLD.tarea_id, 'adjunto_eliminado', jsonb_build_object('nombre', OLD.nombre_original));
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.mercadeo_adjuntos_bitacora() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';

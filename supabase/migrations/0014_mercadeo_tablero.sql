-- ============================================================
-- Tablero de tareas de Mercadeo (kanban) + reglas de "urgente fuera de calendario"
--
-- Flujo del manual MKT-P-01: solicitada -> confirmada -> en_produccion ->
-- en_validacion -> entregada (+ cancelada, fuera de columnas).
--
-- Reglas de priorización (MKT-DOC-00 §B.5, MKT-P-04 §4), aplicadas en la BD
-- para que no se puedan saltar desde el navegador:
--  1. Clase de prioridad: calendario (1) > soporte_ventas (2) > mejora (3) >
--     exploratorio (4). Una tarea vinculada a una actividad APROBADA en el
--     calendario maestro (mercadeo_actividades.en_calendario) es siempre clase
--     'calendario'; sin esa vinculación no se permite la clase 'calendario'.
--  2. fuera_calendario = no vinculada a una actividad aprobada (foto al guardar;
--     solo se recalcula si cambia la actividad, la clase, la urgencia o el aval,
--     para que mover una tarjeta de columna nunca falle por un cambio posterior
--     de la actividad).
--  3. Urgente + fuera de calendario EXIGE aval del Comité de Mercadeo o de
--     Gerencia General, con referencia (acta/correo) y motivo; se sella quién y
--     cuándo lo registró y queda en la bitácora (alimenta el KPI de excepciones).
--  4. "Sin brief no hay fecha comprometida": para salir de 'solicitada' hacia el
--     flujo de trabajo se exige descripción (brief) y fecha límite.
--  confirmada_en / entregada_en las sella el servidor (KPI de oportunidad de
--  confirmación 12-24 h y de entrega a tiempo).
--
-- La bitácora de sistema (creación, estado, asignación, datos, aval, adjuntos)
-- la escriben triggers SECURITY DEFINER: es atómica y no falsificable. El cliente
-- solo puede insertar comentarios.
--
-- Requiere 0012 y 0013. Idempotente. Aplicar con apply_migration (MCP) ANTES
-- de publicar el frontend.
-- ============================================================

-- ── 1. Tareas ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mercadeo_tareas (
  id                         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  titulo                     text NOT NULL CHECK (char_length(btrim(titulo)) BETWEEN 3 AND 200),
  descripcion                text NOT NULL DEFAULT '',
  estado                     text NOT NULL DEFAULT 'solicitada'
                               CHECK (estado IN ('solicitada','confirmada','en_produccion','en_validacion','entregada','cancelada')),
  tipo                       text NOT NULL CHECK (tipo IN ('diseno','redes','evento','pop','campana','pauta','otro')),
  prioridad                  text NOT NULL DEFAULT 'mejora' CHECK (prioridad IN ('calendario','soporte_ventas','mejora','exploratorio')),
  urgente                    boolean NOT NULL DEFAULT false,
  actividad_id               bigint REFERENCES public.mercadeo_actividades(id),
  fuera_calendario           boolean NOT NULL DEFAULT true,
  empresas                   text[] NOT NULL CHECK (cardinality(empresas) >= 1
                                                    AND empresas <@ ARRAY['PARCELAR','GREEN','RESO','IASO','IAS']::text[]),
  responsables               uuid[] NOT NULL DEFAULT '{}',
  fecha_limite               date,
  aval_por                   text CHECK (aval_por IS NULL OR aval_por IN ('comite','gerencia_general')),
  aval_referencia            text NOT NULL DEFAULT '',
  aval_motivo                text NOT NULL DEFAULT '',
  aval_registrado_por        uuid,
  aval_registrado_por_nombre text,
  aval_registrado_en         timestamptz,
  confirmada_en              timestamptz,
  entregada_en               timestamptz,
  creado_por                 uuid,
  creado_por_nombre          text,
  creado_en                  timestamptz,
  modificado_por             uuid,
  modificado_por_nombre      text,
  modificado_en              timestamptz
);
CREATE INDEX IF NOT EXISTS mercadeo_tareas_estado ON public.mercadeo_tareas (estado);
CREATE INDEX IF NOT EXISTS mercadeo_tareas_actividad ON public.mercadeo_tareas (actividad_id);
CREATE INDEX IF NOT EXISTS mercadeo_tareas_fecha_limite ON public.mercadeo_tareas (fecha_limite);
COMMENT ON TABLE public.mercadeo_tareas IS
  'Tablero de Mercadeo. Tareas del área para las empresas del holding, con reglas de prioridad y de urgente fuera de calendario aplicadas por trigger.';

-- ── 2. Reglas (BEFORE INSERT/UPDATE) ─────────────────────────
CREATE OR REPLACE FUNCTION public.mercadeo_tareas_reglas()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_en_cal boolean;
  v_recalcular boolean;
  v_nombre text;
  v_aval_cambio boolean;
BEGIN
  SELECT COALESCE(NULLIF(nombre, ''), email) INTO v_nombre FROM usuarios_pqrs WHERE id = auth.uid();
  v_nombre := COALESCE(v_nombre, 'Sistema');

  IF TG_OP = 'INSERT' THEN
    IF NEW.estado <> 'solicitada' THEN
      RAISE EXCEPTION 'Una tarea nueva se crea en estado "solicitada"';
    END IF;
    NEW.confirmada_en := NULL;
    NEW.entregada_en := NULL;
    NEW.aval_registrado_por := NULL;
    NEW.aval_registrado_por_nombre := NULL;
    NEW.aval_registrado_en := NULL;
    v_recalcular := true;
    v_aval_cambio := true;
  ELSE
    -- El cliente no fija sellos del servidor.
    NEW.confirmada_en := OLD.confirmada_en;
    NEW.entregada_en := OLD.entregada_en;
    NEW.aval_registrado_por := OLD.aval_registrado_por;
    NEW.aval_registrado_por_nombre := OLD.aval_registrado_por_nombre;
    NEW.aval_registrado_en := OLD.aval_registrado_en;
    v_recalcular := NEW.actividad_id IS DISTINCT FROM OLD.actividad_id
                 OR NEW.prioridad IS DISTINCT FROM OLD.prioridad
                 OR NEW.urgente IS DISTINCT FROM OLD.urgente
                 OR NEW.aval_por IS DISTINCT FROM OLD.aval_por
                 OR NEW.aval_referencia IS DISTINCT FROM OLD.aval_referencia
                 OR NEW.aval_motivo IS DISTINCT FROM OLD.aval_motivo;
    v_aval_cambio := NEW.aval_por IS DISTINCT FROM OLD.aval_por
                  OR NEW.aval_referencia IS DISTINCT FROM OLD.aval_referencia
                  OR NEW.aval_motivo IS DISTINCT FROM OLD.aval_motivo;
  END IF;

  -- Regla 1-3: calendario, clase de prioridad y aval.
  IF v_recalcular THEN
    v_en_cal := false;
    IF NEW.actividad_id IS NOT NULL THEN
      SELECT COALESCE(a.en_calendario, false) INTO v_en_cal FROM mercadeo_actividades a WHERE a.id = NEW.actividad_id;
      v_en_cal := COALESCE(v_en_cal, false);
    END IF;
    NEW.fuera_calendario := NOT v_en_cal;

    IF v_en_cal THEN
      NEW.prioridad := 'calendario';
    ELSIF NEW.prioridad = 'calendario' THEN
      IF TG_OP = 'UPDATE' AND OLD.prioridad = 'calendario' THEN
        -- La actividad dejó de estar aprobada (o se desvinculó) y el usuario no eligió otra clase:
        -- se reclasifica sola; el cambio queda en la bitácora ('cambio_datos').
        NEW.prioridad := 'mejora';
      ELSE
        RAISE EXCEPTION 'La clase "Calendario aprobado" exige vincular la tarea a una actividad aprobada en el calendario maestro';
      END IF;
    END IF;

    IF NEW.urgente AND NEW.fuera_calendario THEN
      IF NEW.aval_por IS NULL OR btrim(NEW.aval_referencia) = '' OR btrim(NEW.aval_motivo) = '' THEN
        RAISE EXCEPTION 'Una tarea urgente fuera de calendario requiere el aval del Comité de Mercadeo o de Gerencia General (quién avala, referencia y motivo)';
      END IF;
      IF v_aval_cambio OR NEW.aval_registrado_en IS NULL THEN
        NEW.aval_registrado_por := auth.uid();
        NEW.aval_registrado_por_nombre := v_nombre;
        NEW.aval_registrado_en := now();
      END IF;
    ELSE
      -- Sin excepción vigente no se conservan datos de aval (la evidencia queda en la bitácora).
      NEW.aval_por := NULL;
      NEW.aval_referencia := '';
      NEW.aval_motivo := '';
      NEW.aval_registrado_por := NULL;
      NEW.aval_registrado_por_nombre := NULL;
      NEW.aval_registrado_en := NULL;
    END IF;
  END IF;

  -- Regla 4: sin brief no hay fecha comprometida; sellos de confirmación y entrega.
  IF TG_OP = 'UPDATE' THEN
    IF OLD.estado = 'solicitada' AND NEW.estado NOT IN ('solicitada','cancelada') THEN
      IF btrim(NEW.descripcion) = '' OR NEW.fecha_limite IS NULL THEN
        RAISE EXCEPTION 'Sin brief no hay fecha comprometida: para confirmar la tarea escribe la descripción (brief) y la fecha límite';
      END IF;
      IF NEW.confirmada_en IS NULL THEN NEW.confirmada_en := now(); END IF;
    END IF;
    IF NEW.estado = 'entregada' AND OLD.estado <> 'entregada' THEN
      NEW.entregada_en := now();
    ELSIF NEW.estado <> 'entregada' THEN
      NEW.entregada_en := NULL;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.mercadeo_tareas_reglas() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_reglas ON public.mercadeo_tareas;
CREATE TRIGGER trg_reglas
  BEFORE INSERT OR UPDATE ON public.mercadeo_tareas
  FOR EACH ROW EXECUTE FUNCTION public.mercadeo_tareas_reglas();

-- ── 3. Bitácora ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mercadeo_tarea_bitacora (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tarea_id       bigint NOT NULL REFERENCES public.mercadeo_tareas(id) ON DELETE CASCADE,
  tipo_evento    text NOT NULL CHECK (tipo_evento IN
    ('creacion','cambio_estado','asignacion','cambio_datos','aval_registrado','comentario','adjunto_agregado','adjunto_eliminado')),
  usuario_id     uuid,
  usuario_nombre text,
  detalle        jsonb,
  creado_en      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mercadeo_bitacora_comentario_check CHECK (
    tipo_evento <> 'comentario' OR char_length(btrim(COALESCE(detalle->>'texto', ''))) BETWEEN 1 AND 2000)
);
CREATE INDEX IF NOT EXISTS mercadeo_tarea_bitacora_tarea ON public.mercadeo_tarea_bitacora (tarea_id);

-- Autor y hora siempre del servidor (el cliente no puede atribuir eventos a otra persona).
CREATE OR REPLACE FUNCTION public.mercadeo_bitacora_antes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.usuario_id := auth.uid();
  SELECT COALESCE(NULLIF(nombre, ''), email) INTO NEW.usuario_nombre FROM usuarios_pqrs WHERE id = auth.uid();
  NEW.usuario_nombre := COALESCE(NEW.usuario_nombre, 'Sistema');
  NEW.creado_en := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.mercadeo_bitacora_antes() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_bitacora_antes ON public.mercadeo_tarea_bitacora;
CREATE TRIGGER trg_bitacora_antes
  BEFORE INSERT ON public.mercadeo_tarea_bitacora
  FOR EACH ROW EXECUTE FUNCTION public.mercadeo_bitacora_antes();

-- Eventos de sistema de la tarea (atómicos con el cambio).
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
    VALUES (NEW.id, 'creacion', jsonb_build_object('titulo', NEW.titulo, 'estado', NEW.estado));
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

DROP TRIGGER IF EXISTS trg_bitacora ON public.mercadeo_tareas;
CREATE TRIGGER trg_bitacora
  AFTER INSERT OR UPDATE ON public.mercadeo_tareas
  FOR EACH ROW EXECUTE FUNCTION public.mercadeo_tareas_bitacora();

-- ── 4. Adjuntos ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mercadeo_tarea_adjuntos (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tarea_id        bigint NOT NULL REFERENCES public.mercadeo_tareas(id) ON DELETE CASCADE,
  storage_path    text NOT NULL,
  nombre_original text,
  tipo_mime       text,
  tamano_bytes    bigint,
  subido_por      uuid REFERENCES public.usuarios_pqrs(id),
  creado_en       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mercadeo_tarea_adjuntos_tarea ON public.mercadeo_tarea_adjuntos (tarea_id);
CREATE INDEX IF NOT EXISTS mercadeo_tarea_adjuntos_subido_por ON public.mercadeo_tarea_adjuntos (subido_por);

CREATE OR REPLACE FUNCTION public.mercadeo_adjuntos_bitacora()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO mercadeo_tarea_bitacora (tarea_id, tipo_evento, detalle)
    VALUES (NEW.tarea_id, 'adjunto_agregado', jsonb_build_object('nombre', NEW.nombre_original));
  ELSIF EXISTS (SELECT 1 FROM mercadeo_tareas WHERE id = OLD.tarea_id) THEN
    -- Si la tarea se está borrando (cascada) no se registra: la bitácora también se borra.
    INSERT INTO mercadeo_tarea_bitacora (tarea_id, tipo_evento, detalle)
    VALUES (OLD.tarea_id, 'adjunto_eliminado', jsonb_build_object('nombre', OLD.nombre_original));
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.mercadeo_adjuntos_bitacora() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_adjuntos_bitacora ON public.mercadeo_tarea_adjuntos;
CREATE TRIGGER trg_adjuntos_bitacora
  AFTER INSERT OR DELETE ON public.mercadeo_tarea_adjuntos
  FOR EACH ROW EXECUTE FUNCTION public.mercadeo_adjuntos_bitacora();

-- ── 5. Auditoría + RLS ───────────────────────────────────────
DROP TRIGGER IF EXISTS trg_auditoria ON public.mercadeo_tareas;
CREATE TRIGGER trg_auditoria
  BEFORE INSERT OR UPDATE ON public.mercadeo_tareas
  FOR EACH ROW EXECUTE FUNCTION public.mercadeo_set_auditoria();

ALTER TABLE public.mercadeo_tareas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mercadeo_tarea_bitacora ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mercadeo_tarea_adjuntos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mercadeo_tareas FROM anon;
REVOKE ALL ON public.mercadeo_tarea_bitacora FROM anon;
REVOKE ALL ON public.mercadeo_tarea_adjuntos FROM anon;

-- Tareas: el módulo lee/crea/edita; borrar solo admin (se cancelan; conservan evidencia para los KPI).
DROP POLICY IF EXISTS "mercadeo_tareas_select" ON public.mercadeo_tareas;
CREATE POLICY "mercadeo_tareas_select" ON public.mercadeo_tareas FOR SELECT TO authenticated
  USING ((select public.user_has_module_pqrs('mercadeo')));
DROP POLICY IF EXISTS "mercadeo_tareas_insert" ON public.mercadeo_tareas;
CREATE POLICY "mercadeo_tareas_insert" ON public.mercadeo_tareas FOR INSERT TO authenticated
  WITH CHECK ((select public.user_has_module_pqrs('mercadeo')));
DROP POLICY IF EXISTS "mercadeo_tareas_update" ON public.mercadeo_tareas;
CREATE POLICY "mercadeo_tareas_update" ON public.mercadeo_tareas FOR UPDATE TO authenticated
  USING ((select public.user_has_module_pqrs('mercadeo')))
  WITH CHECK ((select public.user_has_module_pqrs('mercadeo')));
DROP POLICY IF EXISTS "mercadeo_tareas_delete" ON public.mercadeo_tareas;
CREATE POLICY "mercadeo_tareas_delete" ON public.mercadeo_tareas FOR DELETE TO authenticated
  USING (get_user_role_pqrs() = 'admin');

-- Bitácora: el módulo lee; el cliente solo inserta comentarios (el resto lo escriben los triggers).
DROP POLICY IF EXISTS "mercadeo_tarea_bitacora_select" ON public.mercadeo_tarea_bitacora;
CREATE POLICY "mercadeo_tarea_bitacora_select" ON public.mercadeo_tarea_bitacora FOR SELECT TO authenticated
  USING ((select public.user_has_module_pqrs('mercadeo')));
DROP POLICY IF EXISTS "mercadeo_tarea_bitacora_insert" ON public.mercadeo_tarea_bitacora;
CREATE POLICY "mercadeo_tarea_bitacora_insert" ON public.mercadeo_tarea_bitacora FOR INSERT TO authenticated
  WITH CHECK ((select public.user_has_module_pqrs('mercadeo')) AND tipo_evento = 'comentario');

-- Adjuntos: el módulo lee, sube (como sí mismo) y borra.
DROP POLICY IF EXISTS "mercadeo_tarea_adjuntos_select" ON public.mercadeo_tarea_adjuntos;
CREATE POLICY "mercadeo_tarea_adjuntos_select" ON public.mercadeo_tarea_adjuntos FOR SELECT TO authenticated
  USING ((select public.user_has_module_pqrs('mercadeo')));
DROP POLICY IF EXISTS "mercadeo_tarea_adjuntos_insert" ON public.mercadeo_tarea_adjuntos;
CREATE POLICY "mercadeo_tarea_adjuntos_insert" ON public.mercadeo_tarea_adjuntos FOR INSERT TO authenticated
  WITH CHECK ((select public.user_has_module_pqrs('mercadeo')) AND subido_por = (select auth.uid()));
DROP POLICY IF EXISTS "mercadeo_tarea_adjuntos_delete" ON public.mercadeo_tarea_adjuntos;
CREATE POLICY "mercadeo_tarea_adjuntos_delete" ON public.mercadeo_tarea_adjuntos FOR DELETE TO authenticated
  USING ((select public.user_has_module_pqrs('mercadeo')));

-- ── 6. Storage: bucket privado de adjuntos de tareas ─────────
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('mercadeo-adjuntos', 'mercadeo-adjuntos', false, 26214400) -- 25 MB
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "mercadeo_adjuntos_select" ON storage.objects;
CREATE POLICY "mercadeo_adjuntos_select" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'mercadeo-adjuntos' AND (select public.user_has_module_pqrs('mercadeo')));
DROP POLICY IF EXISTS "mercadeo_adjuntos_insert" ON storage.objects;
CREATE POLICY "mercadeo_adjuntos_insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'mercadeo-adjuntos' AND (select public.user_has_module_pqrs('mercadeo')));
DROP POLICY IF EXISTS "mercadeo_adjuntos_delete" ON storage.objects;
CREATE POLICY "mercadeo_adjuntos_delete" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'mercadeo-adjuntos' AND (select public.user_has_module_pqrs('mercadeo')));

-- ── 7. Realtime: el tablero se actualiza solo entre los usuarios ──
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                  WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'mercadeo_tareas') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.mercadeo_tareas;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

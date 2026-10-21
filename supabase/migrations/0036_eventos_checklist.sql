-- ============================================================
-- Eventos: CHECKLIST DE ACTIVIDADES para gestionar una solicitud de evento
--
-- El gestor de Mercadeo agrega varias actividades para cumplir los requerimientos del evento (canales, materiales,
-- logística…): texto libre, casilla de «hecha», responsable del equipo, fecha límite opcional y notas.
--
--  1. Tabla mercadeo_evento_checklist (nombre distinto de mercadeo_actividades, que es el calendario del CRM).
--  2. Reglas (trigger): solo se escribe mientras el evento está En revisión, Aprobada, En preparación o Realizada;
--     quién y cuándo marcó «hecha», y quién creó la actividad, los sella la BD (no el navegador).
--  3. Bitácora del evento: nuevo tipo 'actividad' (agregada a mano / completada / reabierta / eliminada).
--  4. RLS: el módulo `mercadeo` lee y escribe (como los adjuntos); anon no entra.
--
-- El avance (actividades hechas / total) lo lee la función puente `solicitud-evento-pedidos` para mostrárselo al solicitante en
-- Pedidos; las notas y los responsables NO salen de aquí.
-- Idempotente. Aplicar con apply_migration (MCP) ANTES de redesplegar solicitud-evento-pedidos y publicar el frontend.
-- ============================================================

-- ── 1. Tabla ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mercadeo_evento_checklist (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  evento_id        bigint NOT NULL REFERENCES public.mercadeo_eventos(id) ON DELETE CASCADE,
  descripcion      text NOT NULL,
  responsable_id   uuid REFERENCES public.usuarios_pqrs(id) ON DELETE SET NULL,
  fecha_limite     date,
  notas            text NOT NULL DEFAULT '',
  hecha            boolean NOT NULL DEFAULT false,
  hecha_por        uuid,
  hecha_por_nombre text,
  hecha_en         timestamptz,
  origen_clave     text,                      -- actividad sugerida desde lo solicitado (p. ej. 'material:flyers'); no se repite
  creado_por       uuid,
  creado_por_nombre text,
  creado_en        timestamptz NOT NULL DEFAULT now(),
  modificado_en    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mercadeo_evento_checklist_desc_check CHECK (char_length(btrim(descripcion)) BETWEEN 3 AND 300),
  CONSTRAINT mercadeo_evento_checklist_notas_check CHECK (char_length(notas) <= 1000),
  CONSTRAINT mercadeo_evento_checklist_clave_check CHECK (origen_clave IS NULL OR char_length(origen_clave) <= 60)
);
CREATE INDEX IF NOT EXISTS mercadeo_evento_checklist_evento ON public.mercadeo_evento_checklist (evento_id);
CREATE INDEX IF NOT EXISTS mercadeo_evento_checklist_responsable ON public.mercadeo_evento_checklist (responsable_id);
CREATE UNIQUE INDEX IF NOT EXISTS mercadeo_evento_checklist_clave_uq
  ON public.mercadeo_evento_checklist (evento_id, origen_clave) WHERE origen_clave IS NOT NULL;
COMMENT ON TABLE public.mercadeo_evento_checklist IS
  'Checklist de actividades con las que Mercadeo cumple los requerimientos de un evento (distinta de mercadeo_actividades, el calendario del CRM).';

-- ── 2. Reglas ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mercadeo_evento_checklist_reglas()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_evento  bigint;
  v_estado  text;
  v_nombre  text;
BEGIN
  v_evento := CASE WHEN TG_OP = 'DELETE' THEN OLD.evento_id ELSE NEW.evento_id END;
  SELECT estado INTO v_estado FROM mercadeo_eventos WHERE id = v_evento;

  -- Si el evento ya no existe, el borrado viene en cascada: se deja pasar.
  IF TG_OP = 'DELETE' AND v_estado IS NULL THEN
    RETURN OLD;
  END IF;
  IF v_estado IS NULL OR v_estado NOT IN ('en_revision', 'aprobada', 'en_preparacion', 'realizada') THEN
    RAISE EXCEPTION 'El checklist solo se modifica mientras el evento está En revisión, Aprobada, En preparación o Realizada';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  SELECT COALESCE(NULLIF(nombre, ''), email) INTO v_nombre FROM usuarios_pqrs WHERE id = auth.uid();
  v_nombre := COALESCE(v_nombre, 'Sistema');

  NEW.descripcion := btrim(regexp_replace(COALESCE(NEW.descripcion, ''), '\s+', ' ', 'g'));
  NEW.notas := btrim(COALESCE(NEW.notas, ''));

  IF TG_OP = 'INSERT' THEN
    NEW.creado_por := auth.uid();
    NEW.creado_por_nombre := v_nombre;
    NEW.creado_en := now();
    NEW.modificado_en := now();
    IF NEW.hecha THEN
      NEW.hecha_por := auth.uid(); NEW.hecha_por_nombre := v_nombre; NEW.hecha_en := now();
    ELSE
      NEW.hecha_por := NULL; NEW.hecha_por_nombre := NULL; NEW.hecha_en := NULL;
    END IF;
  ELSE
    -- Inmutables
    NEW.evento_id := OLD.evento_id;
    NEW.origen_clave := OLD.origen_clave;
    NEW.creado_por := OLD.creado_por;
    NEW.creado_por_nombre := OLD.creado_por_nombre;
    NEW.creado_en := OLD.creado_en;
    NEW.modificado_en := now();
    -- Sello de «hecha»: solo cambia al marcar o desmarcar
    IF NEW.hecha AND NOT OLD.hecha THEN
      NEW.hecha_por := auth.uid(); NEW.hecha_por_nombre := v_nombre; NEW.hecha_en := now();
    ELSIF NOT NEW.hecha THEN
      NEW.hecha_por := NULL; NEW.hecha_por_nombre := NULL; NEW.hecha_en := NULL;
    ELSE
      NEW.hecha_por := OLD.hecha_por; NEW.hecha_por_nombre := OLD.hecha_por_nombre; NEW.hecha_en := OLD.hecha_en;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.mercadeo_evento_checklist_reglas() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_checklist_reglas ON public.mercadeo_evento_checklist;
CREATE TRIGGER trg_checklist_reglas
  BEFORE INSERT OR UPDATE OR DELETE ON public.mercadeo_evento_checklist
  FOR EACH ROW EXECUTE FUNCTION public.mercadeo_evento_checklist_reglas();

-- ── 3. Bitácora ──────────────────────────────────────────────
ALTER TABLE public.mercadeo_evento_bitacora DROP CONSTRAINT IF EXISTS mercadeo_evento_bitacora_tipo_evento_check;
ALTER TABLE public.mercadeo_evento_bitacora ADD CONSTRAINT mercadeo_evento_bitacora_tipo_evento_check CHECK (tipo_evento IN
  ('creacion','cambio_estado','cambio_datos','comentario','respuesta_solicitante','observacion_solicitante',
   'adjunto_agregado','adjunto_eliminado','tarea_creada','actividad'));

-- Deja constancia de lo que importa: actividad agregada a mano, completada, reabierta y eliminada. Las sugeridas desde lo solicitado
-- no se registran una por una al crearse (serían decenas de líneas de ruido), pero sí cuando se completan.
CREATE OR REPLACE FUNCTION public.mercadeo_evento_checklist_bitacora()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.origen_clave IS NULL THEN
      INSERT INTO mercadeo_evento_bitacora (evento_id, tipo_evento, detalle)
      VALUES (NEW.evento_id, 'actividad', jsonb_build_object('accion', 'agregada', 'texto', NEW.descripcion));
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.hecha IS DISTINCT FROM OLD.hecha THEN
      INSERT INTO mercadeo_evento_bitacora (evento_id, tipo_evento, detalle)
      VALUES (NEW.evento_id, 'actividad',
              jsonb_build_object('accion', CASE WHEN NEW.hecha THEN 'completada' ELSE 'reabierta' END, 'texto', NEW.descripcion));
    END IF;
  ELSIF EXISTS (SELECT 1 FROM mercadeo_eventos WHERE id = OLD.evento_id) THEN
    -- Si el evento se está borrando (cascada) no se registra: la bitácora también se borra.
    INSERT INTO mercadeo_evento_bitacora (evento_id, tipo_evento, detalle)
    VALUES (OLD.evento_id, 'actividad', jsonb_build_object('accion', 'eliminada', 'texto', OLD.descripcion));
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.mercadeo_evento_checklist_bitacora() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_checklist_bitacora ON public.mercadeo_evento_checklist;
CREATE TRIGGER trg_checklist_bitacora
  AFTER INSERT OR UPDATE OR DELETE ON public.mercadeo_evento_checklist
  FOR EACH ROW EXECUTE FUNCTION public.mercadeo_evento_checklist_bitacora();

-- ── 4. RLS ───────────────────────────────────────────────────
ALTER TABLE public.mercadeo_evento_checklist ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mercadeo_evento_checklist FROM anon;

DROP POLICY IF EXISTS "mercadeo_evento_checklist_select" ON public.mercadeo_evento_checklist;
CREATE POLICY "mercadeo_evento_checklist_select" ON public.mercadeo_evento_checklist FOR SELECT TO authenticated
  USING ((select public.user_has_module_pqrs('mercadeo')));
DROP POLICY IF EXISTS "mercadeo_evento_checklist_insert" ON public.mercadeo_evento_checklist;
CREATE POLICY "mercadeo_evento_checklist_insert" ON public.mercadeo_evento_checklist FOR INSERT TO authenticated
  WITH CHECK ((select public.user_has_module_pqrs('mercadeo')));
DROP POLICY IF EXISTS "mercadeo_evento_checklist_update" ON public.mercadeo_evento_checklist;
CREATE POLICY "mercadeo_evento_checklist_update" ON public.mercadeo_evento_checklist FOR UPDATE TO authenticated
  USING ((select public.user_has_module_pqrs('mercadeo')))
  WITH CHECK ((select public.user_has_module_pqrs('mercadeo')));
DROP POLICY IF EXISTS "mercadeo_evento_checklist_delete" ON public.mercadeo_evento_checklist;
CREATE POLICY "mercadeo_evento_checklist_delete" ON public.mercadeo_evento_checklist FOR DELETE TO authenticated
  USING ((select public.user_has_module_pqrs('mercadeo')));

NOTIFY pgrst, 'reload schema';

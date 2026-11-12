-- ============================================================
-- Eventos: ADJUNTOS POR ACTIVIDAD del checklist (evidencia de lo que Mercadeo hizo)
--
-- Cada actividad del checklist (mercadeo_evento_checklist, migración 0036) puede llevar archivos: el flyer diseñado, la foto del
-- montaje, la cotización, el listado de asistentes… Es una tabla APARTE de mercadeo_evento_adjuntos a propósito: esa la lee la función
-- puente `solicitud-evento-pedidos` (acción `listar`) y la imprime el PDF de la solicitud, y la evidencia interna de una actividad
-- no debe llegarle al solicitante de Pedidos. Aquí nada sale del panel de Mercadeo.
--
--  1. Tabla mercadeo_evento_checklist_adjuntos (mismo bucket privado `mercadeo-adjuntos`; ruta evento_<id>/actividad_<id>/…).
--  2. Reglas (trigger): solo se sube o se borra mientras el evento está En revisión, Aprobada, En preparación o Realizada (igual que
--     el checklist); `evento_id`, quién subió y cuándo los sella la BD (el navegador no los falsifica); la ruta debe pertenecer al
--     evento; máximo 20 archivos por actividad; 25 MB por archivo (el bucket ya lo impone, aquí queda también en la fila).
--  3. Bitácora del evento: 'adjunto_agregado' / 'adjunto_eliminado' con el nombre del archivo y la actividad.
--  4. RLS: el módulo `mercadeo` lee, sube y borra; no hay UPDATE (es evidencia: se borra y se vuelve a subir); anon no entra.
--
-- Los archivos del Storage no los toca la BD: al eliminar una actividad o un evento la interfaz borra primero los objetos del
-- bucket (la fila se va en cascada). Idempotente. Aplicar con apply_migration (MCP) ANTES de publicar el frontend.
-- ============================================================

-- ── 1. Tabla ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mercadeo_evento_checklist_adjuntos (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actividad_id      bigint NOT NULL REFERENCES public.mercadeo_evento_checklist(id) ON DELETE CASCADE,
  evento_id         bigint NOT NULL REFERENCES public.mercadeo_eventos(id) ON DELETE CASCADE,   -- lo fija el trigger desde la actividad
  storage_path      text NOT NULL,
  nombre_original   text NOT NULL,
  tipo_mime         text,
  tamano_bytes      bigint,
  subido_por        uuid REFERENCES public.usuarios_pqrs(id) ON DELETE SET NULL,
  subido_por_nombre text,
  creado_en         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mercadeo_evento_chk_adj_nombre_check CHECK (char_length(btrim(nombre_original)) BETWEEN 1 AND 255),
  CONSTRAINT mercadeo_evento_chk_adj_ruta_check CHECK (char_length(storage_path) BETWEEN 1 AND 500),
  CONSTRAINT mercadeo_evento_chk_adj_tamano_check CHECK (tamano_bytes IS NULL OR (tamano_bytes >= 0 AND tamano_bytes <= 26214400))
);
CREATE INDEX IF NOT EXISTS mercadeo_evento_chk_adj_actividad ON public.mercadeo_evento_checklist_adjuntos (actividad_id);
CREATE INDEX IF NOT EXISTS mercadeo_evento_chk_adj_evento ON public.mercadeo_evento_checklist_adjuntos (evento_id);
CREATE INDEX IF NOT EXISTS mercadeo_evento_chk_adj_subido_por ON public.mercadeo_evento_checklist_adjuntos (subido_por);
COMMENT ON TABLE public.mercadeo_evento_checklist_adjuntos IS
  'Archivos (evidencia) de cada actividad del checklist de un evento. Internos de Mercadeo: no se exponen a Pedidos ni al PDF.';

-- ── 2. Reglas ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mercadeo_evento_chk_adj_reglas()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_evento  bigint;
  v_estado  text;
  v_nombre  text;
  v_prefijo text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT c.evento_id INTO v_evento FROM mercadeo_evento_checklist c WHERE c.id = OLD.actividad_id;
    -- Sin actividad o sin evento, el borrado viene en cascada (se eliminó la actividad o el evento): se deja pasar.
    IF v_evento IS NULL THEN RETURN OLD; END IF;
    SELECT estado INTO v_estado FROM mercadeo_eventos WHERE id = v_evento;
    IF v_estado IS NULL THEN RETURN OLD; END IF;
    IF v_estado NOT IN ('en_revision', 'aprobada', 'en_preparacion', 'realizada') THEN
      RAISE EXCEPTION 'Los adjuntos del checklist solo se modifican mientras el evento está En revisión, Aprobada, En preparación o Realizada';
    END IF;
    RETURN OLD;
  END IF;

  -- INSERT: el evento sale de la actividad (el navegador no decide a cuál evento pertenece).
  SELECT c.evento_id INTO v_evento FROM mercadeo_evento_checklist c WHERE c.id = NEW.actividad_id;
  IF v_evento IS NULL THEN
    RAISE EXCEPTION 'La actividad no existe';
  END IF;
  SELECT estado INTO v_estado FROM mercadeo_eventos WHERE id = v_evento;
  IF v_estado IS NULL OR v_estado NOT IN ('en_revision', 'aprobada', 'en_preparacion', 'realizada') THEN
    RAISE EXCEPTION 'Los adjuntos del checklist solo se modifican mientras el evento está En revisión, Aprobada, En preparación o Realizada';
  END IF;

  -- La ruta debe estar dentro de la carpeta del evento (nunca apuntar al archivo de otro evento ni salirse con «..»).
  v_prefijo := 'evento_' || v_evento || '/';
  IF left(COALESCE(NEW.storage_path, ''), length(v_prefijo)) <> v_prefijo OR position('..' IN NEW.storage_path) > 0 THEN
    RAISE EXCEPTION 'La ruta del archivo no corresponde al evento';
  END IF;

  IF (SELECT count(*) FROM mercadeo_evento_checklist_adjuntos a WHERE a.actividad_id = NEW.actividad_id) >= 20 THEN
    RAISE EXCEPTION 'Una actividad admite hasta 20 archivos';
  END IF;

  SELECT COALESCE(NULLIF(nombre, ''), email) INTO v_nombre FROM usuarios_pqrs WHERE id = auth.uid();
  NEW.evento_id := v_evento;
  NEW.nombre_original := btrim(COALESCE(NEW.nombre_original, ''));
  NEW.subido_por := auth.uid();
  NEW.subido_por_nombre := COALESCE(v_nombre, 'Sistema');
  NEW.creado_en := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.mercadeo_evento_chk_adj_reglas() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_chk_adj_reglas ON public.mercadeo_evento_checklist_adjuntos;
CREATE TRIGGER trg_chk_adj_reglas
  BEFORE INSERT OR DELETE ON public.mercadeo_evento_checklist_adjuntos
  FOR EACH ROW EXECUTE FUNCTION public.mercadeo_evento_chk_adj_reglas();

-- ── 3. Bitácora ──────────────────────────────────────────────
-- Constancia en la bitácora del evento (los tipos 'adjunto_agregado' / 'adjunto_eliminado' ya existen; aquí llevan además la actividad).
CREATE OR REPLACE FUNCTION public.mercadeo_evento_chk_adj_bitacora()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_texto text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT descripcion INTO v_texto FROM mercadeo_evento_checklist WHERE id = NEW.actividad_id;
    INSERT INTO mercadeo_evento_bitacora (evento_id, tipo_evento, detalle)
    VALUES (NEW.evento_id, 'adjunto_agregado', jsonb_build_object('nombre', NEW.nombre_original, 'actividad', v_texto));
  ELSE
    -- Si se está eliminando la actividad o el evento (cascada) no se registra: ya queda «actividad eliminada» o se borra la bitácora.
    SELECT descripcion INTO v_texto FROM mercadeo_evento_checklist WHERE id = OLD.actividad_id;
    IF v_texto IS NOT NULL AND EXISTS (SELECT 1 FROM mercadeo_eventos WHERE id = OLD.evento_id) THEN
      INSERT INTO mercadeo_evento_bitacora (evento_id, tipo_evento, detalle)
      VALUES (OLD.evento_id, 'adjunto_eliminado', jsonb_build_object('nombre', OLD.nombre_original, 'actividad', v_texto));
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.mercadeo_evento_chk_adj_bitacora() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_chk_adj_bitacora ON public.mercadeo_evento_checklist_adjuntos;
CREATE TRIGGER trg_chk_adj_bitacora
  AFTER INSERT OR DELETE ON public.mercadeo_evento_checklist_adjuntos
  FOR EACH ROW EXECUTE FUNCTION public.mercadeo_evento_chk_adj_bitacora();

-- ── 4. RLS ───────────────────────────────────────────────────
ALTER TABLE public.mercadeo_evento_checklist_adjuntos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mercadeo_evento_checklist_adjuntos FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.mercadeo_evento_checklist_adjuntos TO authenticated;   -- sin UPDATE: es evidencia

DROP POLICY IF EXISTS "mercadeo_evento_chk_adj_select" ON public.mercadeo_evento_checklist_adjuntos;
CREATE POLICY "mercadeo_evento_chk_adj_select" ON public.mercadeo_evento_checklist_adjuntos FOR SELECT TO authenticated
  USING ((select public.user_has_module_pqrs('mercadeo')));
DROP POLICY IF EXISTS "mercadeo_evento_chk_adj_insert" ON public.mercadeo_evento_checklist_adjuntos;
CREATE POLICY "mercadeo_evento_chk_adj_insert" ON public.mercadeo_evento_checklist_adjuntos FOR INSERT TO authenticated
  WITH CHECK ((select public.user_has_module_pqrs('mercadeo')));
DROP POLICY IF EXISTS "mercadeo_evento_chk_adj_delete" ON public.mercadeo_evento_checklist_adjuntos;
CREATE POLICY "mercadeo_evento_chk_adj_delete" ON public.mercadeo_evento_checklist_adjuntos FOR DELETE TO authenticated
  USING ((select public.user_has_module_pqrs('mercadeo')));

NOTIFY pgrst, 'reload schema';

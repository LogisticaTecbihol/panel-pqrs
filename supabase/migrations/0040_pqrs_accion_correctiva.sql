-- ============================================================
-- Análisis y acción correctiva de una PQRS (ISO 9001:2015, cláusula 10.2 «No conformidad y acción correctiva»).
--
-- 0039 dejó el «Registro de gestión» (lo que se HACE con la PQRS: llamadas, respuestas, correcciones...). Esto agrega
-- el otro lado del procedimiento: decidir si la PQRS revela una no conformidad que exija eliminar su causa, y
-- si es así llevar el caso hasta verificar que la acción fue eficaz. Sigue los literales de 10.2.1 y 10.2.2:
--   a) reaccionar ante la no conformidad: controlarla, corregirla y tratar sus consecuencias
--        -> el Registro de gestión (0039; aquí se le suma el tipo «Corrección inmediata»);
--   b) evaluar la necesidad de acciones para eliminar la causa: revisar y analizar, determinar las causas y si existen
--      o podrían existir casos similares            -> evaluación + análisis de causa de esta tabla;
--   c) implementar las acciones necesarias         -> plan de acción (pqrs_accion_plan);
--   d) revisar la eficacia de la acción correctiva -> verificación de eficacia;
--   e) actualizar los riesgos y oportunidades y   f) cambiar el sistema de gestión, si fuera necesario
--                                                  -> dos respuestas explícitas al cerrar;
--   10.2.2 conservar información documentada de la naturaleza de la no conformidad, las acciones tomadas y sus resultados
--                                                  -> todo queda sellado por el servidor y en la bitácora de la PQRS.
--
-- Una fila por PQRS (pqrs_acciones_correctivas, visible como AC-<id>). Si NO hay fila, la PQRS está «pendiente de
-- evaluar». Estados: no_requiere | en_analisis | en_ejecucion | en_verificacion | cerrada.
--   no_requiere     <-> en_analisis      (se puede reevaluar; con plan ya registrado no se vuelve a «no requiere»)
--   en_analisis      -> en_ejecucion     (método, análisis, causa raíz, casos similares, >= 1 acción en el plan y la fecha
--                                          de verificación programada después de la última acción)
--   en_ejecucion     -> en_verificacion  (todas las acciones del plan hechas, con su evidencia) | -> en_analisis
--   en_verificacion  -> cerrada          (verificación «eficaz» + fecha + cómo se verificó + las dos respuestas de 10.2.1 e/f)
--   en_verificacion  -> en_analisis      (verificación «no eficaz»: se reabre el análisis; lo verificado queda en la bitácora)
--   cerrada          -> en_analisis      (solo admin; queda en la bitácora). Cerrada es FINAL: no se edita.
-- Al cambiar de estado solo cambia el estado (los demás campos se guardan antes), y cada campo solo se edita en el estado
-- que le corresponde. NO se borra una acción correctiva desde la aplicación (es evidencia); solo se va con la PQRS.
--
-- Permisos (RLS): lee quien tiene el módulo 'pqrs'; escriben admin y gestor. Quién y cuándo (creó, verificó, cerró, marcó
-- una acción como hecha) lo sella el servidor. Los eventos de la bitácora (tipo 'accion_correctiva') los escribe un trigger:
-- el tipo NO se agrega a la policy de INSERT de pqrs_bitacora, así que el navegador no puede inventarlos.
--
-- Requiere 0003, 0004, 0009, 0010, 0029 y 0039. Idempotente. Aplicar con apply_migration (MCP) ANTES de publicar el
-- frontend. Solo agrega: no cambia el acceso de nadie ni toca datos existentes (el CHECK de pqrs_gestiones solo se amplía).
-- ============================================================

-- ── 1. Registro de gestión: tipo «Corrección inmediata» (10.2.1 a) ──
ALTER TABLE public.pqrs_gestiones DROP CONSTRAINT IF EXISTS pqrs_gestiones_tipo_check;
ALTER TABLE public.pqrs_gestiones ADD CONSTRAINT pqrs_gestiones_tipo_check CHECK (tipo IN
  ('llamada','correo','whatsapp','visita','reunion','revision_interna','escalamiento','respuesta_cliente','correccion','solucion','otra'));

-- ── 2. Bitácora: evento nuevo (lo escribe solo el trigger) ──
ALTER TABLE public.pqrs_bitacora DROP CONSTRAINT IF EXISTS pqrs_bitacora_tipo_evento_check;
ALTER TABLE public.pqrs_bitacora ADD CONSTRAINT pqrs_bitacora_tipo_evento_check
  CHECK (tipo_evento IN ('creacion','cambio_estado','asignacion','nota','notificacion_enviada','adjunto_agregado','edicion_datos',
                         'gestion_registrada','gestion_eliminada','accion_correctiva'));

-- ── 3. Acción correctiva (una por PQRS) ─────────────────────
CREATE TABLE IF NOT EXISTS public.pqrs_acciones_correctivas (
  id                         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pqrs_id                    bigint NOT NULL UNIQUE REFERENCES public.pqrs(id) ON DELETE CASCADE,
  estado                     text NOT NULL CHECK (estado IN ('no_requiere','en_analisis','en_ejecucion','en_verificacion','cerrada')),
  -- 10.2.1 b) evaluación de la necesidad: por qué sí o por qué no
  criterio_evaluacion        text NOT NULL CHECK (char_length(btrim(criterio_evaluacion)) BETWEEN 3 AND 1000),
  -- 10.2.1 b) análisis de causa
  metodo_analisis            text CHECK (metodo_analisis IN ('cinco_porques','ishikawa','arbol_causas','otro')),
  analisis_causa             text NOT NULL DEFAULT '' CHECK (char_length(analisis_causa) <= 3000),
  causa_raiz                 text NOT NULL DEFAULT '' CHECK (char_length(causa_raiz) <= 1000),
  casos_similares            text NOT NULL DEFAULT '' CHECK (char_length(casos_similares) <= 1000),
  fecha_verificacion_prevista date,
  -- 10.2.1 d) verificación de eficacia
  verificacion_fecha         date,
  verificacion_resultado     text CHECK (verificacion_resultado IN ('eficaz','no_eficaz')),
  verificacion_observaciones text NOT NULL DEFAULT '' CHECK (char_length(verificacion_observaciones) <= 2000),
  verificado_por_nombre      text,
  -- 10.2.1 e) y f)
  actualiza_riesgos          text CHECK (actualiza_riesgos IN ('si','no')),
  cambios_sgc                text CHECK (cambios_sgc IN ('si','no')),
  detalle_sgc                text NOT NULL DEFAULT '' CHECK (char_length(detalle_sgc) <= 1000),
  -- cierre
  cerrada_en                 timestamptz,
  cerrada_por                uuid,
  cerrada_por_nombre         text,
  -- auditoría (la sella el servidor; creado_en es la fecha de la evaluación)
  creado_por                 uuid,
  creado_por_nombre          text,
  creado_en                  timestamptz NOT NULL DEFAULT now(),
  modificado_por             uuid,
  modificado_por_nombre      text,
  modificado_en              timestamptz
);

COMMENT ON TABLE public.pqrs_acciones_correctivas IS
  'ISO 9001:2015 10.2. Evaluación, análisis de causa, verificación de eficacia y cierre de la acción correctiva de una PQRS (una por PQRS; sin fila = pendiente de evaluar). Sellos del servidor; no se borra desde la aplicación.';

-- ── 4. Plan de acción (10.2.1 c) ────────────────────────────
CREATE TABLE IF NOT EXISTS public.pqrs_accion_plan (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  accion_id          bigint NOT NULL REFERENCES public.pqrs_acciones_correctivas(id) ON DELETE CASCADE,
  descripcion        text NOT NULL CHECK (char_length(btrim(descripcion)) BETWEEN 3 AND 500),
  responsable_id     uuid NOT NULL,
  responsable_nombre text,
  fecha_compromiso   date NOT NULL,
  hecha              boolean NOT NULL DEFAULT false,
  hecha_en           timestamptz,
  hecha_por_nombre   text,
  evidencia          text NOT NULL DEFAULT '' CHECK (char_length(evidencia) <= 1000),
  creado_por         uuid,
  creado_por_nombre  text,
  creado_en          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pqrs_accion_plan_accion ON public.pqrs_accion_plan (accion_id, fecha_compromiso, id);

COMMENT ON TABLE public.pqrs_accion_plan IS
  'Plan de acción de una acción correctiva de PQRS: qué, quién y cuándo, y la evidencia de que se hizo. Solo se edita en análisis/ejecución.';

-- ── 5. Reglas de la acción correctiva (BEFORE INSERT OR UPDATE) ──
CREATE OR REPLACE FUNCTION public.pqrs_ac_reglas()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_nombre   text;
  v_es_admin boolean := (get_user_role_pqrs() IS NOT DISTINCT FROM 'admin');
  v_hoy      date := (now() AT TIME ZONE 'America/Bogota')::date;
  v_total    int;
  v_pend     int;
  v_ultima   date;
  v_reabre   boolean := false;
BEGIN
  SELECT COALESCE(NULLIF(nombre, ''), email) INTO v_nombre FROM usuarios_pqrs WHERE id = auth.uid();
  v_nombre := COALESCE(v_nombre, 'Sistema');

  NEW.criterio_evaluacion       := btrim(NEW.criterio_evaluacion);
  NEW.analisis_causa            := COALESCE(btrim(NEW.analisis_causa), '');
  NEW.causa_raiz                := COALESCE(btrim(NEW.causa_raiz), '');
  NEW.casos_similares           := COALESCE(btrim(NEW.casos_similares), '');
  NEW.verificacion_observaciones := COALESCE(btrim(NEW.verificacion_observaciones), '');
  NEW.detalle_sgc               := COALESCE(btrim(NEW.detalle_sgc), '');

  IF TG_OP = 'INSERT' THEN
    IF NEW.estado NOT IN ('no_requiere', 'en_analisis') THEN
      RAISE EXCEPTION 'La evaluación inicial solo puede concluir «no requiere acción» o «en análisis»';
    END IF;
    -- Al evaluar solo se fija la decisión y su criterio; lo demás nace vacío (no se puede sembrar un cierre falso).
    NEW.metodo_analisis := NULL; NEW.analisis_causa := ''; NEW.causa_raiz := ''; NEW.casos_similares := '';
    NEW.fecha_verificacion_prevista := NULL;
    NEW.verificacion_fecha := NULL; NEW.verificacion_resultado := NULL; NEW.verificacion_observaciones := '';
    NEW.verificado_por_nombre := NULL; NEW.actualiza_riesgos := NULL; NEW.cambios_sgc := NULL; NEW.detalle_sgc := '';
    NEW.cerrada_en := NULL; NEW.cerrada_por := NULL; NEW.cerrada_por_nombre := NULL;
    NEW.creado_por := auth.uid(); NEW.creado_por_nombre := v_nombre; NEW.creado_en := now();
    NEW.modificado_por := NULL; NEW.modificado_por_nombre := NULL; NEW.modificado_en := NULL;
    RETURN NEW;
  END IF;

  -- UPDATE ------------------------------------------------------------------
  NEW.id := OLD.id; NEW.pqrs_id := OLD.pqrs_id;
  NEW.creado_por := OLD.creado_por; NEW.creado_por_nombre := OLD.creado_por_nombre; NEW.creado_en := OLD.creado_en;
  NEW.verificado_por_nombre := OLD.verificado_por_nombre;
  NEW.cerrada_en := OLD.cerrada_en; NEW.cerrada_por := OLD.cerrada_por; NEW.cerrada_por_nombre := OLD.cerrada_por_nombre;

  IF OLD.estado = 'cerrada' AND NEW.estado = 'cerrada' THEN
    RAISE EXCEPTION 'La acción correctiva está cerrada y no se puede modificar';
  END IF;

  IF NEW.verificacion_fecha IS NOT NULL AND NEW.verificacion_fecha > v_hoy THEN
    RAISE EXCEPTION 'La fecha de la verificación de eficacia no puede ser futura';
  END IF;

  IF NEW.estado = OLD.estado THEN
    -- Edición dentro del mismo estado: cada bloque de campos solo en el estado que le toca.
    IF NEW.criterio_evaluacion IS DISTINCT FROM OLD.criterio_evaluacion AND OLD.estado NOT IN ('no_requiere', 'en_analisis') THEN
      RAISE EXCEPTION 'El criterio de la evaluación ya no se puede modificar en este estado';
    END IF;
    IF (NEW.metodo_analisis, NEW.analisis_causa, NEW.causa_raiz, NEW.casos_similares, NEW.fecha_verificacion_prevista)
         IS DISTINCT FROM (OLD.metodo_analisis, OLD.analisis_causa, OLD.causa_raiz, OLD.casos_similares, OLD.fecha_verificacion_prevista)
       AND OLD.estado NOT IN ('en_analisis', 'en_ejecucion') THEN
      RAISE EXCEPTION 'El análisis de causas solo se modifica mientras la acción está en análisis o en ejecución';
    END IF;
    IF (NEW.verificacion_fecha, NEW.verificacion_resultado, NEW.verificacion_observaciones, NEW.actualiza_riesgos, NEW.cambios_sgc, NEW.detalle_sgc)
         IS DISTINCT FROM (OLD.verificacion_fecha, OLD.verificacion_resultado, OLD.verificacion_observaciones, OLD.actualiza_riesgos, OLD.cambios_sgc, OLD.detalle_sgc) THEN
      IF OLD.estado <> 'en_verificacion' THEN
        RAISE EXCEPTION 'La verificación de eficacia solo se registra cuando la acción está en verificación';
      END IF;
      NEW.verificado_por_nombre := v_nombre;
    END IF;
  ELSE
    -- Cambio de estado: solo cambia el estado (y el criterio al reevaluar); lo demás se guarda antes.
    IF (NEW.metodo_analisis, NEW.analisis_causa, NEW.causa_raiz, NEW.casos_similares, NEW.fecha_verificacion_prevista)
         IS DISTINCT FROM (OLD.metodo_analisis, OLD.analisis_causa, OLD.causa_raiz, OLD.casos_similares, OLD.fecha_verificacion_prevista)
       OR (NEW.verificacion_fecha, NEW.verificacion_resultado, NEW.verificacion_observaciones, NEW.actualiza_riesgos, NEW.cambios_sgc, NEW.detalle_sgc)
         IS DISTINCT FROM (OLD.verificacion_fecha, OLD.verificacion_resultado, OLD.verificacion_observaciones, OLD.actualiza_riesgos, OLD.cambios_sgc, OLD.detalle_sgc) THEN
      RAISE EXCEPTION 'Guarda primero los cambios y luego cambia el estado';
    END IF;
    IF NEW.criterio_evaluacion IS DISTINCT FROM OLD.criterio_evaluacion
       AND NOT (OLD.estado = 'no_requiere' AND NEW.estado = 'en_analisis')
       AND NOT (OLD.estado = 'en_analisis' AND NEW.estado = 'no_requiere') THEN
      RAISE EXCEPTION 'El criterio de la evaluación solo se modifica al reevaluar la necesidad de acción';
    END IF;

    IF OLD.estado = 'no_requiere' AND NEW.estado = 'en_analisis' THEN
      NULL;
    ELSIF OLD.estado = 'en_analisis' AND NEW.estado = 'no_requiere' THEN
      IF EXISTS (SELECT 1 FROM pqrs_accion_plan WHERE accion_id = OLD.id) THEN
        RAISE EXCEPTION 'Elimina primero las acciones del plan para concluir que no se requiere acción correctiva';
      END IF;
    ELSIF OLD.estado = 'en_analisis' AND NEW.estado = 'en_ejecucion' THEN
      IF NEW.metodo_analisis IS NULL THEN RAISE EXCEPTION 'Indica el método de análisis de causas'; END IF;
      IF char_length(NEW.analisis_causa) < 3 THEN RAISE EXCEPTION 'Describe el análisis de causas'; END IF;
      IF char_length(NEW.causa_raiz) < 3 THEN RAISE EXCEPTION 'Indica la causa raíz'; END IF;
      IF char_length(NEW.casos_similares) < 3 THEN
        RAISE EXCEPTION 'Indica si existen o podrían presentarse casos similares (si no, escribe «No se identificaron»)';
      END IF;
      SELECT count(*), max(fecha_compromiso) INTO v_total, v_ultima FROM pqrs_accion_plan WHERE accion_id = OLD.id;
      IF v_total = 0 THEN RAISE EXCEPTION 'Registra al menos una acción en el plan'; END IF;
      IF NEW.fecha_verificacion_prevista IS NULL THEN RAISE EXCEPTION 'Programa la fecha de verificación de la eficacia'; END IF;
      IF NEW.fecha_verificacion_prevista < v_ultima THEN
        RAISE EXCEPTION 'La verificación de la eficacia debe programarse después de la última acción del plan';
      END IF;
    ELSIF OLD.estado = 'en_ejecucion' AND NEW.estado = 'en_analisis' THEN
      NULL;
    ELSIF OLD.estado = 'en_ejecucion' AND NEW.estado = 'en_verificacion' THEN
      SELECT count(*), count(*) FILTER (WHERE NOT hecha) INTO v_total, v_pend FROM pqrs_accion_plan WHERE accion_id = OLD.id;
      IF v_total = 0 OR v_pend > 0 THEN
        RAISE EXCEPTION 'Todas las acciones del plan deben estar hechas, con su evidencia, para pasar a verificación';
      END IF;
    ELSIF OLD.estado = 'en_verificacion' AND NEW.estado = 'cerrada' THEN
      IF NEW.verificacion_resultado IS DISTINCT FROM 'eficaz' THEN
        RAISE EXCEPTION 'Para cerrar, la verificación debe resultar «eficaz»; si no lo fue, reabre el análisis';
      END IF;
      IF NEW.verificacion_fecha IS NULL THEN RAISE EXCEPTION 'Indica la fecha de la verificación de eficacia'; END IF;
      IF char_length(NEW.verificacion_observaciones) < 3 THEN
        RAISE EXCEPTION 'Describe cómo se verificó la eficacia y con qué evidencia';
      END IF;
      IF NEW.actualiza_riesgos IS NULL OR NEW.cambios_sgc IS NULL THEN
        RAISE EXCEPTION 'Indica si se actualizan los riesgos y oportunidades y si se requieren cambios al sistema de gestión';
      END IF;
      IF (NEW.actualiza_riesgos = 'si' OR NEW.cambios_sgc = 'si') AND char_length(NEW.detalle_sgc) < 3 THEN
        RAISE EXCEPTION 'Describe qué riesgos o cambios al sistema de gestión se actualizan';
      END IF;
      NEW.cerrada_en := now(); NEW.cerrada_por := auth.uid(); NEW.cerrada_por_nombre := v_nombre;
    ELSIF OLD.estado = 'en_verificacion' AND NEW.estado = 'en_analisis' THEN
      IF OLD.verificacion_resultado IS DISTINCT FROM 'no_eficaz' OR char_length(OLD.verificacion_observaciones) < 3 THEN
        RAISE EXCEPTION 'Para reabrir el análisis registra antes la verificación como «no eficaz», con sus observaciones';
      END IF;
      v_reabre := true;
    ELSIF OLD.estado = 'cerrada' AND NEW.estado = 'en_analisis' THEN
      IF NOT v_es_admin THEN RAISE EXCEPTION 'Solo un administrador puede reabrir una acción correctiva cerrada'; END IF;
      v_reabre := true;
    ELSE
      RAISE EXCEPTION 'Cambio de estado no permitido: de % a %', OLD.estado, NEW.estado;
    END IF;

    -- Reabrir: la verificación anterior queda en la bitácora (trigger AFTER) y la acción vuelve a empezar la verificación.
    IF v_reabre THEN
      NEW.verificacion_fecha := NULL; NEW.verificacion_resultado := NULL; NEW.verificacion_observaciones := '';
      NEW.verificado_por_nombre := NULL; NEW.actualiza_riesgos := NULL; NEW.cambios_sgc := NULL; NEW.detalle_sgc := '';
      NEW.fecha_verificacion_prevista := NULL;
      NEW.cerrada_en := NULL; NEW.cerrada_por := NULL; NEW.cerrada_por_nombre := NULL;
    END IF;
  END IF;

  NEW.modificado_por := auth.uid(); NEW.modificado_por_nombre := v_nombre; NEW.modificado_en := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.pqrs_ac_reglas() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_pqrs_ac_reglas ON public.pqrs_acciones_correctivas;
CREATE TRIGGER trg_pqrs_ac_reglas
  BEFORE INSERT OR UPDATE ON public.pqrs_acciones_correctivas
  FOR EACH ROW EXECUTE FUNCTION public.pqrs_ac_reglas();

-- ── 6. Reglas del plan de acción (BEFORE INSERT OR UPDATE OR DELETE) ──
CREATE OR REPLACE FUNCTION public.pqrs_accion_plan_reglas()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_estado       text;
  v_nombre       text;
  v_resp_nombre  text;
  v_resp_activo  boolean;
  v_hoy          date := (now() AT TIME ZONE 'America/Bogota')::date;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT estado INTO v_estado FROM pqrs_acciones_correctivas WHERE id = OLD.accion_id;
    IF v_estado IS NULL THEN RETURN OLD; END IF;  -- la acción correctiva (o la PQRS) entera se está borrando: cascada
    IF v_estado NOT IN ('en_analisis', 'en_ejecucion') THEN
      RAISE EXCEPTION 'El plan solo se modifica mientras la acción correctiva está en análisis o en ejecución';
    END IF;
    IF OLD.hecha THEN RAISE EXCEPTION 'Una acción hecha no se elimina: desmárcala primero'; END IF;
    RETURN OLD;
  END IF;

  SELECT estado INTO v_estado FROM pqrs_acciones_correctivas WHERE id = NEW.accion_id;
  IF v_estado IS NULL THEN RAISE EXCEPTION 'La acción correctiva no existe'; END IF;
  SELECT COALESCE(NULLIF(nombre, ''), email) INTO v_nombre FROM usuarios_pqrs WHERE id = auth.uid();
  v_nombre := COALESCE(v_nombre, 'Sistema');
  NEW.descripcion := btrim(NEW.descripcion);
  NEW.evidencia := COALESCE(btrim(NEW.evidencia), '');

  IF TG_OP = 'INSERT' THEN
    IF v_estado NOT IN ('en_analisis', 'en_ejecucion') THEN
      RAISE EXCEPTION 'El plan solo se modifica mientras la acción correctiva está en análisis o en ejecución';
    END IF;
    SELECT COALESCE(NULLIF(nombre, ''), email), activo INTO v_resp_nombre, v_resp_activo FROM usuarios_pqrs WHERE id = NEW.responsable_id;
    IF v_resp_activo IS NOT TRUE THEN RAISE EXCEPTION 'El responsable no existe o está inactivo'; END IF;
    IF NEW.fecha_compromiso < v_hoy THEN RAISE EXCEPTION 'La fecha de compromiso no puede ser anterior a hoy'; END IF;
    NEW.responsable_nombre := v_resp_nombre;
    NEW.hecha := false; NEW.hecha_en := NULL; NEW.hecha_por_nombre := NULL; NEW.evidencia := '';
    NEW.creado_por := auth.uid(); NEW.creado_por_nombre := v_nombre; NEW.creado_en := now();
    RETURN NEW;
  END IF;

  -- UPDATE: solo se marca o desmarca como hecha (con su evidencia)
  NEW.id := OLD.id;
  NEW.responsable_nombre := OLD.responsable_nombre;
  NEW.creado_por := OLD.creado_por; NEW.creado_por_nombre := OLD.creado_por_nombre; NEW.creado_en := OLD.creado_en;
  IF (NEW.accion_id, NEW.descripcion, NEW.responsable_id, NEW.fecha_compromiso)
       IS DISTINCT FROM (OLD.accion_id, OLD.descripcion, OLD.responsable_id, OLD.fecha_compromiso) THEN
    RAISE EXCEPTION 'Para cambiar una acción del plan elimínala y regístrala de nuevo';
  END IF;
  IF v_estado <> 'en_ejecucion' THEN
    RAISE EXCEPTION 'Las acciones se marcan como hechas mientras la acción correctiva está en ejecución';
  END IF;

  IF NEW.hecha AND NOT OLD.hecha THEN
    IF char_length(NEW.evidencia) < 3 THEN RAISE EXCEPTION 'Describe la evidencia de que la acción se realizó'; END IF;
    NEW.hecha_en := now(); NEW.hecha_por_nombre := v_nombre;
  ELSIF NEW.hecha AND OLD.hecha THEN
    IF NEW.evidencia IS DISTINCT FROM OLD.evidencia THEN
      RAISE EXCEPTION 'La evidencia de una acción hecha no se modifica: desmárcala primero';
    END IF;
    NEW.hecha_en := OLD.hecha_en; NEW.hecha_por_nombre := OLD.hecha_por_nombre;
  ELSE
    NEW.hecha_en := NULL; NEW.hecha_por_nombre := NULL;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.pqrs_accion_plan_reglas() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_pqrs_accion_plan_reglas ON public.pqrs_accion_plan;
CREATE TRIGGER trg_pqrs_accion_plan_reglas
  BEFORE INSERT OR UPDATE OR DELETE ON public.pqrs_accion_plan
  FOR EACH ROW EXECUTE FUNCTION public.pqrs_accion_plan_reglas();

-- ── 7. Rastro en la bitácora de la PQRS (AFTER) ─────────────
CREATE OR REPLACE FUNCTION public.pqrs_ac_bitacora()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO pqrs_bitacora (pqrs_id, tipo_evento, usuario_id, usuario_nombre, detalle)
    VALUES (NEW.pqrs_id, 'accion_correctiva', NEW.creado_por, NEW.creado_por_nombre,
            jsonb_build_object('evento', 'evaluada', 'accion_id', NEW.id, 'a', NEW.estado));
  ELSIF NEW.estado IS DISTINCT FROM OLD.estado THEN
    INSERT INTO pqrs_bitacora (pqrs_id, tipo_evento, usuario_id, usuario_nombre, detalle)
    VALUES (NEW.pqrs_id, 'accion_correctiva', NEW.modificado_por, NEW.modificado_por_nombre,
            jsonb_build_object('evento', 'estado', 'accion_id', NEW.id, 'de', OLD.estado, 'a', NEW.estado)
            || CASE WHEN OLD.estado IN ('en_verificacion', 'cerrada') AND NEW.estado = 'en_analisis'
                    THEN jsonb_build_object('verificacion_resultado', OLD.verificacion_resultado,
                                            'observaciones', OLD.verificacion_observaciones)
                    ELSE '{}'::jsonb END);
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.pqrs_ac_bitacora() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_pqrs_ac_bitacora ON public.pqrs_acciones_correctivas;
CREATE TRIGGER trg_pqrs_ac_bitacora
  AFTER INSERT OR UPDATE ON public.pqrs_acciones_correctivas
  FOR EACH ROW EXECUTE FUNCTION public.pqrs_ac_bitacora();

-- ── 8. RLS ──────────────────────────────────────────────────
ALTER TABLE public.pqrs_acciones_correctivas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pqrs_accion_plan ENABLE ROW LEVEL SECURITY;

-- Solo lo necesario: nada para anon, sin TRUNCATE y sin DELETE sobre la acción correctiva (es evidencia).
REVOKE ALL ON TABLE public.pqrs_acciones_correctivas FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.pqrs_acciones_correctivas TO authenticated;
REVOKE ALL ON TABLE public.pqrs_accion_plan FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.pqrs_accion_plan TO authenticated;

-- (select ...) para que el planner evalúe la función una sola vez por consulta (patrón de 0009).
DROP POLICY IF EXISTS "pqrs_ac_select" ON public.pqrs_acciones_correctivas;
CREATE POLICY "pqrs_ac_select" ON public.pqrs_acciones_correctivas
  FOR SELECT TO authenticated
  USING ((select public.user_has_module_pqrs('pqrs')));

DROP POLICY IF EXISTS "pqrs_ac_insert" ON public.pqrs_acciones_correctivas;
CREATE POLICY "pqrs_ac_insert" ON public.pqrs_acciones_correctivas
  FOR INSERT TO authenticated
  WITH CHECK ((select public.get_user_role_pqrs()) = ANY (ARRAY['admin','gestor']));

DROP POLICY IF EXISTS "pqrs_ac_update" ON public.pqrs_acciones_correctivas;
CREATE POLICY "pqrs_ac_update" ON public.pqrs_acciones_correctivas
  FOR UPDATE TO authenticated
  USING ((select public.get_user_role_pqrs()) = ANY (ARRAY['admin','gestor']))
  WITH CHECK ((select public.get_user_role_pqrs()) = ANY (ARRAY['admin','gestor']));

DROP POLICY IF EXISTS "pqrs_accion_plan_select" ON public.pqrs_accion_plan;
CREATE POLICY "pqrs_accion_plan_select" ON public.pqrs_accion_plan
  FOR SELECT TO authenticated
  USING ((select public.user_has_module_pqrs('pqrs')));

DROP POLICY IF EXISTS "pqrs_accion_plan_insert" ON public.pqrs_accion_plan;
CREATE POLICY "pqrs_accion_plan_insert" ON public.pqrs_accion_plan
  FOR INSERT TO authenticated
  WITH CHECK ((select public.get_user_role_pqrs()) = ANY (ARRAY['admin','gestor']));

DROP POLICY IF EXISTS "pqrs_accion_plan_update" ON public.pqrs_accion_plan;
CREATE POLICY "pqrs_accion_plan_update" ON public.pqrs_accion_plan
  FOR UPDATE TO authenticated
  USING ((select public.get_user_role_pqrs()) = ANY (ARRAY['admin','gestor']))
  WITH CHECK ((select public.get_user_role_pqrs()) = ANY (ARRAY['admin','gestor']));

DROP POLICY IF EXISTS "pqrs_accion_plan_delete" ON public.pqrs_accion_plan;
CREATE POLICY "pqrs_accion_plan_delete" ON public.pqrs_accion_plan
  FOR DELETE TO authenticated
  USING ((select public.get_user_role_pqrs()) = ANY (ARRAY['admin','gestor']));

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- SG-SST (Res. 312 de 2019) en panel-pqrs — FASE 2: plan anual de trabajo + capacitaciones
--
-- Plan anual de trabajo por empresa y vigencia (actividades ponderadas por ciclo PHVA con
-- cronograma mensual programado/ejecutado) y programa de capacitación (temas, sesiones y
-- asistencia de los trabajadores). Requiere 0015 y 0016.
--
-- Fuente normativa (Res. 312/2019, art. 3, estándar 4): el Plan Anual de Trabajo debe estar firmado
-- por el empleador e identificar como mínimo objetivos, metas, responsabilidades, recursos y
-- cronograma anual. Estándar 3: programa de capacitación con planillas donde conste la firma de los
-- trabajadores (las planillas firmadas se escanean y se enlazan desde Drive como evidencia).
--
-- Decisiones de diseño:
--   - El avance NO se guarda: lo calculan vistas a partir de los meses marcados (una sola fuente
--     de verdad). Avance de una actividad = meses ejecutados / meses programados (tope 100 %); sin
--     programación, 100 % si hay algún mes ejecutado. Cumplimiento del plan = suma ponderada del
--     avance de las actividades que APLICAN / suma de sus pesos (el peso es relativo, no hace falta
--     que sume 100).
--   - Semáforo (todo en hora de Bogotá): «vencida» si hay menos meses ejecutados que meses
--     programados ANTES del mes en curso; «este mes» si faltan los del mes en curso; «al día»
--     si no; «sin programar» si no tiene meses. Vigencia pasada: todo el año cuenta como vencido;
--     vigencia futura: nada vence. Los avisos son solo en pantalla (sin correos ni tareas).
--   - Los meses ejecutados de una capacitación salen de sus SESIONES realizadas (no se digitan dos
--     veces). Una sesión puede estar programada (se imprime la planilla de asistencia para firmar),
--     realizada (exige al menos un asistente y fecha no futura) o cancelada.
--   - Nada se borra desde el cliente (DELETE solo admin): una actividad se marca «no aplica» con su
--     motivo, una capacitación se inactiva, una sesión se cancela. Única excepción: quitar un
--     convocado de una sesión que todavía está programada.
--   - Evidencias (enlaces a Drive) pueden respaldar el plan firmado, una actividad o una sesión.
--
-- Idempotente. Aplicar con apply_migration (MCP) ANTES de publicar el frontend. Los datos de
-- Tecbihol (plan 2026 y temas de formación) se cargan aparte (no van en el repo).
-- ============================================================

-- ── 0. Utilidades ────────────────────────────────────────────
-- Normaliza una lista de meses (1-12): sin repetidos y ordenada. Falla con meses fuera de rango.
CREATE OR REPLACE FUNCTION public.sst_meses_norm(p smallint[])
RETURNS smallint[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  r smallint[];
BEGIN
  IF p IS NULL THEN RETURN '{}'::smallint[]; END IF;
  IF EXISTS (SELECT 1 FROM unnest(p) AS m WHERE m IS NULL OR m < 1 OR m > 12) THEN
    RAISE EXCEPTION 'Los meses deben ser números de 1 (enero) a 12 (diciembre)';
  END IF;
  SELECT COALESCE(array_agg(x.m ORDER BY x.m), '{}'::smallint[]) INTO r
  FROM (SELECT DISTINCT m FROM unnest(p) AS m) x;
  RETURN r;
END;
$$;
REVOKE ALL ON FUNCTION public.sst_meses_norm(smallint[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sst_meses_norm(smallint[]) TO authenticated;

-- Mes de referencia (hora de Bogotá) para una vigencia: 13 = vigencia pasada (todos los meses ya
-- transcurrieron), 0 = vigencia futura (ninguno), 1-12 = mes en curso de la vigencia actual.
CREATE OR REPLACE FUNCTION public.sst_mes_ref(p_vigencia integer)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT CASE WHEN p_vigencia < t.y THEN 13 WHEN p_vigencia > t.y THEN 0 ELSE t.m END
  FROM (SELECT extract(year FROM (now() AT TIME ZONE 'America/Bogota'))::int AS y,
               extract(month FROM (now() AT TIME ZONE 'America/Bogota'))::int AS m) t;
$$;
REVOKE ALL ON FUNCTION public.sst_mes_ref(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sst_mes_ref(integer) TO authenticated;

-- ── 1. Plan anual de trabajo ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sst_planes (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa_id            bigint NOT NULL REFERENCES public.sst_empresas(id),
  vigencia              integer NOT NULL CHECK (vigencia BETWEEN 2019 AND 2100),
  -- Documento del plan en el sistema documental de la empresa (p. ej. SST-TEC-MT0001, versión 1).
  codigo_documento      text NOT NULL DEFAULT '',
  version               text NOT NULL DEFAULT '',
  fecha_documento       date,
  -- Contenido mínimo exigido (art. 3, estándar 4): objetivos, metas y recursos; las responsabilidades
  -- y el cronograma salen de las actividades.
  objetivo              text NOT NULL DEFAULT '',
  metas                 text NOT NULL DEFAULT '',
  recursos              text NOT NULL DEFAULT '',
  empleador_nombre      text NOT NULL DEFAULT '',
  responsable_nombre    text NOT NULL DEFAULT '',
  -- Fecha en que el empleador firmó el plan (el escaneo firmado se enlaza como evidencia 'plan').
  firmado_en            date,
  observaciones         text NOT NULL DEFAULT '',
  creado_por            uuid,
  creado_por_nombre     text,
  creado_en             timestamptz,
  modificado_por        uuid,
  modificado_por_nombre text,
  modificado_en         timestamptz,
  CONSTRAINT sst_planes_vigencia_uq UNIQUE (empresa_id, vigencia)
);
COMMENT ON TABLE public.sst_planes IS
  'SG-SST. Plan anual de trabajo por empresa y vigencia (Res. 312/2019, art. 3, estándar 4). Avance: vista sst_planes_resumen.';

CREATE TABLE IF NOT EXISTS public.sst_plan_actividades (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plan_id               bigint NOT NULL REFERENCES public.sst_planes(id) ON DELETE CASCADE,
  orden                 integer NOT NULL DEFAULT 0 CHECK (orden >= 0),
  ciclo                 text NOT NULL CHECK (ciclo IN ('planear','hacer','verificar','actuar')),
  grupo                 text NOT NULL DEFAULT '',
  item_codigo           text NOT NULL DEFAULT '',
  item_nombre           text NOT NULL DEFAULT '',
  actividad             text NOT NULL CHECK (char_length(btrim(actividad)) BETWEEN 3 AND 3000),
  responsable           text NOT NULL DEFAULT '',
  -- Peso RELATIVO dentro del plan (no necesita sumar 100): el cumplimiento se normaliza.
  peso                  numeric(7,3) NOT NULL DEFAULT 1 CHECK (peso >= 0 AND peso <= 100),
  aplica                boolean NOT NULL DEFAULT true,
  motivo_no_aplica      text NOT NULL DEFAULT '',
  -- Meses (1-12) en que está programada y en que se ejecutó.
  meses_programados     smallint[] NOT NULL DEFAULT '{}'::smallint[]
                          CHECK (meses_programados <@ ARRAY[1,2,3,4,5,6,7,8,9,10,11,12]::smallint[]),
  meses_ejecutados      smallint[] NOT NULL DEFAULT '{}'::smallint[]
                          CHECK (meses_ejecutados <@ ARRAY[1,2,3,4,5,6,7,8,9,10,11,12]::smallint[]),
  observaciones         text NOT NULL DEFAULT '',
  creado_por            uuid,
  creado_por_nombre     text,
  creado_en             timestamptz,
  modificado_por        uuid,
  modificado_por_nombre text,
  modificado_en         timestamptz,
  CONSTRAINT sst_plan_actividades_motivo_check CHECK (aplica OR char_length(btrim(motivo_no_aplica)) >= 3)
);
CREATE INDEX IF NOT EXISTS sst_plan_actividades_plan ON public.sst_plan_actividades (plan_id, orden);
COMMENT ON TABLE public.sst_plan_actividades IS
  'SG-SST. Actividades del plan anual: ciclo PHVA, ítem, responsable, peso relativo y meses programados/ejecutados. No aplica = con motivo.';

-- ── 2. Programa de capacitación ──────────────────────────────
CREATE TABLE IF NOT EXISTS public.sst_capacitaciones (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa_id            bigint NOT NULL REFERENCES public.sst_empresas(id),
  vigencia              integer NOT NULL CHECK (vigencia BETWEEN 2019 AND 2100),
  tema                  text NOT NULL CHECK (char_length(btrim(tema)) BETWEEN 3 AND 500),
  dirigido_a            text NOT NULL DEFAULT '',
  responsable           text NOT NULL DEFAULT '',
  entregable            text NOT NULL DEFAULT '',
  horas_previstas       numeric(5,2) CHECK (horas_previstas IS NULL OR (horas_previstas > 0 AND horas_previstas <= 99)),
  meses_programados     smallint[] NOT NULL DEFAULT '{}'::smallint[]
                          CHECK (meses_programados <@ ARRAY[1,2,3,4,5,6,7,8,9,10,11,12]::smallint[]),
  activa                boolean NOT NULL DEFAULT true,
  observaciones         text NOT NULL DEFAULT '',
  creado_por            uuid,
  creado_por_nombre     text,
  creado_en             timestamptz,
  modificado_por        uuid,
  modificado_por_nombre text,
  modificado_en         timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS sst_capacitaciones_tema_uq
  ON public.sst_capacitaciones (empresa_id, vigencia, lower(btrim(tema)));
COMMENT ON TABLE public.sst_capacitaciones IS
  'SG-SST. Programa anual de capacitación (un registro por tema y vigencia) con los meses programados. Los meses ejecutados salen de las sesiones realizadas.';

CREATE TABLE IF NOT EXISTS public.sst_cap_sesiones (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  capacitacion_id       bigint NOT NULL REFERENCES public.sst_capacitaciones(id),
  fecha                 date NOT NULL,
  estado                text NOT NULL DEFAULT 'programada' CHECK (estado IN ('programada','realizada','cancelada')),
  horas                 numeric(5,2) CHECK (horas IS NULL OR (horas > 0 AND horas <= 99)),
  instructor            text NOT NULL DEFAULT '',
  modalidad             text NOT NULL DEFAULT 'presencial' CHECK (modalidad IN ('presencial','virtual','mixta')),
  lugar                 text NOT NULL DEFAULT '',
  observaciones         text NOT NULL DEFAULT '',
  creado_por            uuid,
  creado_por_nombre     text,
  creado_en             timestamptz,
  modificado_por        uuid,
  modificado_por_nombre text,
  modificado_en         timestamptz
);
CREATE INDEX IF NOT EXISTS sst_cap_sesiones_cap ON public.sst_cap_sesiones (capacitacion_id, fecha);
COMMENT ON TABLE public.sst_cap_sesiones IS
  'SG-SST. Sesiones de una capacitación (programada / realizada / cancelada). La planilla firmada se enlaza como evidencia (cap_sesion).';

CREATE TABLE IF NOT EXISTS public.sst_cap_asistentes (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sesion_id             bigint NOT NULL REFERENCES public.sst_cap_sesiones(id) ON DELETE CASCADE,
  trabajador_id         bigint NOT NULL REFERENCES public.sst_trabajadores(id),
  -- Una fila = un CONVOCADO; asistio indica si estuvo. Cobertura = asistentes / convocados.
  asistio               boolean NOT NULL DEFAULT false,
  observaciones         text NOT NULL DEFAULT '',
  creado_por            uuid,
  creado_por_nombre     text,
  creado_en             timestamptz,
  modificado_por        uuid,
  modificado_por_nombre text,
  modificado_en         timestamptz,
  CONSTRAINT sst_cap_asistentes_uq UNIQUE (sesion_id, trabajador_id)
);
CREATE INDEX IF NOT EXISTS sst_cap_asistentes_trabajador ON public.sst_cap_asistentes (trabajador_id);
COMMENT ON TABLE public.sst_cap_asistentes IS
  'SG-SST. Convocados a una sesión de capacitación y si asistieron (el equipo SST marca la lista; la firma queda en la planilla escaneada en Drive).';

-- ── 3. Reglas del servidor ───────────────────────────────────
-- 3a. Plan
CREATE OR REPLACE FUNCTION public.sst_planes_reglas()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_activa boolean;
BEGIN
  NEW.codigo_documento := btrim(NEW.codigo_documento);
  NEW.version := btrim(NEW.version);
  NEW.objetivo := btrim(NEW.objetivo);
  NEW.metas := btrim(NEW.metas);
  NEW.recursos := btrim(NEW.recursos);
  NEW.empleador_nombre := btrim(NEW.empleador_nombre);
  NEW.responsable_nombre := btrim(NEW.responsable_nombre);
  IF TG_OP = 'INSERT' THEN
    SELECT activa INTO v_activa FROM sst_empresas WHERE id = NEW.empresa_id;
    IF v_activa IS NULL THEN RAISE EXCEPTION 'La empresa no existe'; END IF;
    IF NOT v_activa THEN RAISE EXCEPTION 'La empresa está inactiva: no se puede crear un plan'; END IF;
  ELSE
    NEW.empresa_id := OLD.empresa_id;
    NEW.vigencia := OLD.vigencia;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.sst_planes_reglas() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_reglas ON public.sst_planes;
CREATE TRIGGER trg_reglas BEFORE INSERT OR UPDATE ON public.sst_planes
  FOR EACH ROW EXECUTE FUNCTION public.sst_planes_reglas();
DROP TRIGGER IF EXISTS trg_auditoria ON public.sst_planes;
CREATE TRIGGER trg_auditoria BEFORE INSERT OR UPDATE ON public.sst_planes
  FOR EACH ROW EXECUTE FUNCTION public.sst_set_auditoria();

-- 3b. Actividades del plan
CREATE OR REPLACE FUNCTION public.sst_plan_actividades_reglas()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.grupo := btrim(NEW.grupo);
  NEW.item_codigo := btrim(NEW.item_codigo);
  NEW.item_nombre := btrim(NEW.item_nombre);
  NEW.actividad := btrim(NEW.actividad);
  NEW.responsable := btrim(NEW.responsable);
  NEW.motivo_no_aplica := btrim(NEW.motivo_no_aplica);
  NEW.meses_programados := sst_meses_norm(NEW.meses_programados);
  NEW.meses_ejecutados := sst_meses_norm(NEW.meses_ejecutados);
  IF NEW.aplica THEN NEW.motivo_no_aplica := ''; END IF;
  IF NOT NEW.aplica AND char_length(NEW.motivo_no_aplica) < 3 THEN
    RAISE EXCEPTION 'Indica el motivo por el que la actividad no aplica';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    NEW.plan_id := OLD.plan_id;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM sst_planes WHERE id = NEW.plan_id) THEN RAISE EXCEPTION 'El plan no existe'; END IF;
    IF NEW.orden = 0 THEN
      SELECT COALESCE(max(orden), 0) + 1 INTO NEW.orden FROM sst_plan_actividades WHERE plan_id = NEW.plan_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.sst_plan_actividades_reglas() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_reglas ON public.sst_plan_actividades;
CREATE TRIGGER trg_reglas BEFORE INSERT OR UPDATE ON public.sst_plan_actividades
  FOR EACH ROW EXECUTE FUNCTION public.sst_plan_actividades_reglas();
DROP TRIGGER IF EXISTS trg_auditoria ON public.sst_plan_actividades;
CREATE TRIGGER trg_auditoria BEFORE INSERT OR UPDATE ON public.sst_plan_actividades
  FOR EACH ROW EXECUTE FUNCTION public.sst_set_auditoria();

-- 3c. Capacitaciones (temas)
CREATE OR REPLACE FUNCTION public.sst_capacitaciones_reglas()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_activa boolean;
BEGIN
  NEW.tema := btrim(NEW.tema);
  NEW.dirigido_a := btrim(NEW.dirigido_a);
  NEW.responsable := btrim(NEW.responsable);
  NEW.entregable := btrim(NEW.entregable);
  NEW.meses_programados := sst_meses_norm(NEW.meses_programados);
  IF TG_OP = 'INSERT' THEN
    SELECT activa INTO v_activa FROM sst_empresas WHERE id = NEW.empresa_id;
    IF v_activa IS NULL THEN RAISE EXCEPTION 'La empresa no existe'; END IF;
    IF NOT v_activa THEN RAISE EXCEPTION 'La empresa está inactiva: no se puede crear una capacitación'; END IF;
  ELSE
    NEW.empresa_id := OLD.empresa_id;
    NEW.vigencia := OLD.vigencia;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.sst_capacitaciones_reglas() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_reglas ON public.sst_capacitaciones;
CREATE TRIGGER trg_reglas BEFORE INSERT OR UPDATE ON public.sst_capacitaciones
  FOR EACH ROW EXECUTE FUNCTION public.sst_capacitaciones_reglas();
DROP TRIGGER IF EXISTS trg_auditoria ON public.sst_capacitaciones;
CREATE TRIGGER trg_auditoria BEFORE INSERT OR UPDATE ON public.sst_capacitaciones
  FOR EACH ROW EXECUTE FUNCTION public.sst_set_auditoria();

-- 3d. Sesiones
CREATE OR REPLACE FUNCTION public.sst_cap_sesiones_reglas()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_vig integer;
  v_activa boolean;
BEGIN
  NEW.instructor := btrim(NEW.instructor);
  NEW.lugar := btrim(NEW.lugar);
  IF TG_OP = 'UPDATE' THEN NEW.capacitacion_id := OLD.capacitacion_id; END IF;
  SELECT vigencia, activa INTO v_vig, v_activa FROM sst_capacitaciones WHERE id = NEW.capacitacion_id;
  IF v_vig IS NULL THEN RAISE EXCEPTION 'La capacitación no existe'; END IF;
  IF TG_OP = 'INSERT' AND NOT v_activa THEN
    RAISE EXCEPTION 'La capacitación está inactiva: no se pueden registrar sesiones';
  END IF;
  IF extract(year FROM NEW.fecha)::int <> v_vig THEN
    RAISE EXCEPTION 'La fecha de la sesión debe estar dentro de la vigencia % de la capacitación', v_vig;
  END IF;
  IF NEW.estado = 'realizada' THEN
    IF NEW.fecha > (now() AT TIME ZONE 'America/Bogota')::date THEN
      RAISE EXCEPTION 'No se puede marcar como realizada una sesión con fecha futura';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.estado IS DISTINCT FROM 'realizada'
       AND NOT EXISTS (SELECT 1 FROM sst_cap_asistentes WHERE sesion_id = OLD.id AND asistio) THEN
      RAISE EXCEPTION 'Para marcar la sesión como realizada registra al menos un asistente';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.sst_cap_sesiones_reglas() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_reglas ON public.sst_cap_sesiones;
CREATE TRIGGER trg_reglas BEFORE INSERT OR UPDATE ON public.sst_cap_sesiones
  FOR EACH ROW EXECUTE FUNCTION public.sst_cap_sesiones_reglas();
DROP TRIGGER IF EXISTS trg_auditoria ON public.sst_cap_sesiones;
CREATE TRIGGER trg_auditoria BEFORE INSERT OR UPDATE ON public.sst_cap_sesiones
  FOR EACH ROW EXECUTE FUNCTION public.sst_set_auditoria();

-- 3e. Asistentes: el trabajador debe ser de la misma empresa; sesión cancelada = lista congelada;
-- un convocado solo se quita mientras la sesión esté programada (salvo admin).
CREATE OR REPLACE FUNCTION public.sst_cap_asistentes_reglas()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_emp bigint;
  v_estado text;
  v_trab_emp bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT estado INTO v_estado FROM sst_cap_sesiones WHERE id = OLD.sesion_id;
    IF v_estado IS DISTINCT FROM 'programada' AND get_user_role_pqrs() IS DISTINCT FROM 'admin' THEN
      RAISE EXCEPTION 'Solo se puede quitar un convocado mientras la sesión está programada';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    NEW.sesion_id := OLD.sesion_id;
    NEW.trabajador_id := OLD.trabajador_id;
  END IF;
  NEW.observaciones := btrim(NEW.observaciones);
  SELECT c.empresa_id, s.estado INTO v_emp, v_estado
  FROM sst_cap_sesiones s JOIN sst_capacitaciones c ON c.id = s.capacitacion_id
  WHERE s.id = NEW.sesion_id;
  IF v_emp IS NULL THEN RAISE EXCEPTION 'La sesión no existe'; END IF;
  IF v_estado = 'cancelada' THEN RAISE EXCEPTION 'La sesión está cancelada: no se puede modificar la asistencia'; END IF;
  SELECT empresa_id INTO v_trab_emp FROM sst_trabajadores WHERE id = NEW.trabajador_id;
  IF v_trab_emp IS DISTINCT FROM v_emp THEN
    RAISE EXCEPTION 'El trabajador no pertenece a la empresa de la capacitación';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.sst_cap_asistentes_reglas() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_reglas ON public.sst_cap_asistentes;
CREATE TRIGGER trg_reglas BEFORE INSERT OR UPDATE OR DELETE ON public.sst_cap_asistentes
  FOR EACH ROW EXECUTE FUNCTION public.sst_cap_asistentes_reglas();
DROP TRIGGER IF EXISTS trg_auditoria ON public.sst_cap_asistentes;
CREATE TRIGGER trg_auditoria BEFORE INSERT OR UPDATE ON public.sst_cap_asistentes
  FOR EACH ROW EXECUTE FUNCTION public.sst_set_auditoria();

-- ── 4. Evidencias: ahora también respaldan el plan firmado, una actividad o una sesión ──
ALTER TABLE public.sst_evidencias DROP CONSTRAINT IF EXISTS sst_evidencias_entidad_tipo_check;
ALTER TABLE public.sst_evidencias ADD CONSTRAINT sst_evidencias_entidad_tipo_check
  CHECK (entidad_tipo IN ('general','autoeval_item','plan_mejora','plan','plan_actividad','cap_sesion'));

CREATE OR REPLACE FUNCTION public.sst_evidencias_reglas()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.titulo := btrim(NEW.titulo);
  NEW.url := btrim(NEW.url);
  IF NEW.entidad_tipo <> 'general' AND NEW.entidad_id IS NULL THEN
    RAISE EXCEPTION 'La evidencia debe indicar el registro que respalda';
  END IF;
  IF NEW.entidad_tipo = 'autoeval_item' THEN
    IF NOT EXISTS (SELECT 1 FROM sst_autoeval_items i JOIN sst_autoevaluaciones a ON a.id = i.autoeval_id
                    WHERE i.id = NEW.entidad_id AND a.empresa_id = NEW.empresa_id) THEN
      RAISE EXCEPTION 'La evidencia debe pertenecer a la misma empresa del estándar que respalda';
    END IF;
  ELSIF NEW.entidad_tipo = 'plan_mejora' THEN
    IF NOT EXISTS (SELECT 1 FROM sst_plan_mejora p JOIN sst_autoevaluaciones a ON a.id = p.autoeval_id
                    WHERE p.id = NEW.entidad_id AND a.empresa_id = NEW.empresa_id) THEN
      RAISE EXCEPTION 'La evidencia debe pertenecer a la misma empresa de la actividad que respalda';
    END IF;
  ELSIF NEW.entidad_tipo = 'plan' THEN
    IF NOT EXISTS (SELECT 1 FROM sst_planes p WHERE p.id = NEW.entidad_id AND p.empresa_id = NEW.empresa_id) THEN
      RAISE EXCEPTION 'La evidencia debe pertenecer a la misma empresa del plan que respalda';
    END IF;
  ELSIF NEW.entidad_tipo = 'plan_actividad' THEN
    IF NOT EXISTS (SELECT 1 FROM sst_plan_actividades x JOIN sst_planes p ON p.id = x.plan_id
                    WHERE x.id = NEW.entidad_id AND p.empresa_id = NEW.empresa_id) THEN
      RAISE EXCEPTION 'La evidencia debe pertenecer a la misma empresa de la actividad que respalda';
    END IF;
  ELSIF NEW.entidad_tipo = 'cap_sesion' THEN
    IF NOT EXISTS (SELECT 1 FROM sst_cap_sesiones s JOIN sst_capacitaciones c ON c.id = s.capacitacion_id
                    WHERE s.id = NEW.entidad_id AND c.empresa_id = NEW.empresa_id) THEN
      RAISE EXCEPTION 'La evidencia debe pertenecer a la misma empresa de la sesión que respalda';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.sst_evidencias_reglas() FROM PUBLIC, anon, authenticated;

-- ── 5. Vistas de avance (security_invoker: respetan la RLS; solo el módulo SST las ve) ──
-- 5a. Cada actividad con su avance, lo esperado a la fecha y el semáforo.
CREATE OR REPLACE VIEW public.sst_plan_actividades_calc
WITH (security_invoker = true) AS
SELECT a.*,
  p.empresa_id,
  p.vigencia,
  c.n_prog,
  c.n_ejec,
  CASE WHEN NOT a.aplica THEN NULL
       WHEN c.n_prog = 0 THEN (CASE WHEN c.n_ejec > 0 THEN 1 ELSE 0 END)
       ELSE LEAST(1, c.n_ejec::numeric / c.n_prog) END AS avance,
  CASE WHEN NOT a.aplica THEN NULL
       WHEN c.n_prog = 0 THEN 0
       ELSE LEAST(1, c.esp_hasta::numeric / c.n_prog) END AS esperado,
  CASE WHEN NOT a.aplica THEN 'no_aplica'
       WHEN (c.n_prog = 0 AND c.n_ejec > 0) OR (c.n_prog > 0 AND c.n_ejec >= c.n_prog) THEN 'ejecutada'
       WHEN c.n_ejec < c.esp_antes THEN 'vencida'
       WHEN c.n_ejec < c.esp_hasta THEN 'este_mes'
       WHEN c.n_prog = 0 THEN 'sin_programar'
       ELSE 'al_dia' END AS semaforo
FROM public.sst_plan_actividades a
JOIN public.sst_planes p ON p.id = a.plan_id
CROSS JOIN LATERAL (SELECT public.sst_mes_ref(p.vigencia) AS mes_ref) r
CROSS JOIN LATERAL (
  SELECT cardinality(a.meses_programados) AS n_prog,
         cardinality(a.meses_ejecutados) AS n_ejec,
         (SELECT count(*) FROM unnest(a.meses_programados) AS mm WHERE mm < r.mes_ref)::int AS esp_antes,
         (SELECT count(*) FROM unnest(a.meses_programados) AS mm WHERE mm <= r.mes_ref)::int AS esp_hasta
) c;
COMMENT ON VIEW public.sst_plan_actividades_calc IS
  'SG-SST. Actividad del plan + avance (meses ejecutados / programados), esperado a la fecha y semáforo (ejecutada / vencida / este_mes / al_dia / sin_programar / no_aplica).';
REVOKE ALL ON public.sst_plan_actividades_calc FROM anon;

-- 5b. Resumen por plan: cumplimiento ponderado y cuántas actividades requieren atención.
CREATE OR REPLACE VIEW public.sst_planes_resumen
WITH (security_invoker = true) AS
SELECT p.*,
  s.n_actividades, s.n_aplica, s.n_no_aplica, s.n_ejecutadas, s.n_vencidas, s.n_este_mes, s.n_sin_programar,
  s.peso_total, s.peso_ejecutado, s.peso_esperado,
  CASE WHEN s.peso_total > 0 THEN round(100 * s.peso_ejecutado / s.peso_total, 2) END AS cumplimiento,
  CASE WHEN s.peso_total > 0 THEN round(100 * s.peso_esperado / s.peso_total, 2) END AS esperado
FROM public.sst_planes p
LEFT JOIN LATERAL (
  SELECT count(*)::int AS n_actividades,
         (count(*) FILTER (WHERE c.aplica))::int AS n_aplica,
         (count(*) FILTER (WHERE NOT c.aplica))::int AS n_no_aplica,
         (count(*) FILTER (WHERE c.semaforo = 'ejecutada'))::int AS n_ejecutadas,
         (count(*) FILTER (WHERE c.semaforo = 'vencida'))::int AS n_vencidas,
         (count(*) FILTER (WHERE c.semaforo = 'este_mes'))::int AS n_este_mes,
         (count(*) FILTER (WHERE c.semaforo = 'sin_programar'))::int AS n_sin_programar,
         COALESCE(sum(c.peso) FILTER (WHERE c.aplica), 0) AS peso_total,
         COALESCE(sum(c.peso * c.avance) FILTER (WHERE c.aplica), 0) AS peso_ejecutado,
         COALESCE(sum(c.peso * c.esperado) FILTER (WHERE c.aplica), 0) AS peso_esperado
  FROM public.sst_plan_actividades_calc c
  WHERE c.plan_id = p.id
) s ON true;
COMMENT ON VIEW public.sst_planes_resumen IS
  'SG-SST. Plan anual + cumplimiento ponderado (suma peso x avance / suma pesos de lo que aplica) y esperado a la fecha según los meses programados.';
REVOKE ALL ON public.sst_planes_resumen FROM anon;

-- 5c. Sumas por ciclo y grupo (el cliente las suma para mostrar el avance por ciclo PHVA).
CREATE OR REPLACE VIEW public.sst_plan_grupo_resumen
WITH (security_invoker = true) AS
SELECT c.plan_id, c.ciclo, c.grupo,
  (count(*) FILTER (WHERE c.aplica))::int AS n_aplica,
  (count(*) FILTER (WHERE c.semaforo = 'vencida'))::int AS n_vencidas,
  (count(*) FILTER (WHERE c.semaforo = 'este_mes'))::int AS n_este_mes,
  COALESCE(sum(c.peso) FILTER (WHERE c.aplica), 0) AS peso_total,
  COALESCE(sum(c.peso * c.avance) FILTER (WHERE c.aplica), 0) AS peso_ejecutado,
  COALESCE(sum(c.peso * c.esperado) FILTER (WHERE c.aplica), 0) AS peso_esperado
FROM public.sst_plan_actividades_calc c
GROUP BY c.plan_id, c.ciclo, c.grupo;
REVOKE ALL ON public.sst_plan_grupo_resumen FROM anon;

-- 5d. Capacitaciones: meses ejecutados (de las sesiones realizadas), cobertura y semáforo.
CREATE OR REPLACE VIEW public.sst_capacitaciones_resumen
WITH (security_invoker = true) AS
SELECT c.*,
  cardinality(c.meses_programados) AS n_prog,
  x.meses_ejecutados,
  cardinality(x.meses_ejecutados) AS n_ejec,
  x.sesiones_realizadas, x.sesiones_programadas, x.horas_realizadas, x.convocados, x.asistentes,
  CASE WHEN x.convocados > 0 THEN round(100.0 * x.asistentes / x.convocados, 2) END AS cobertura,
  CASE WHEN NOT c.activa THEN 'inactiva'
       WHEN (cardinality(c.meses_programados) = 0 AND cardinality(x.meses_ejecutados) > 0)
         OR (cardinality(c.meses_programados) > 0 AND cardinality(x.meses_ejecutados) >= cardinality(c.meses_programados)) THEN 'ejecutada'
       WHEN cardinality(x.meses_ejecutados) < y.esp_antes THEN 'vencida'
       WHEN cardinality(x.meses_ejecutados) < y.esp_hasta THEN 'este_mes'
       WHEN cardinality(c.meses_programados) = 0 THEN 'sin_programar'
       ELSE 'al_dia' END AS semaforo
FROM public.sst_capacitaciones c
CROSS JOIN LATERAL (
  SELECT COALESCE((SELECT array_agg(t.mm ORDER BY t.mm)
                   FROM (SELECT DISTINCT extract(month FROM s.fecha)::smallint AS mm
                         FROM public.sst_cap_sesiones s
                         WHERE s.capacitacion_id = c.id AND s.estado = 'realizada') t), '{}'::smallint[]) AS meses_ejecutados,
         (SELECT count(*) FROM public.sst_cap_sesiones s WHERE s.capacitacion_id = c.id AND s.estado = 'realizada')::int AS sesiones_realizadas,
         (SELECT count(*) FROM public.sst_cap_sesiones s WHERE s.capacitacion_id = c.id AND s.estado = 'programada')::int AS sesiones_programadas,
         (SELECT COALESCE(sum(s.horas), 0) FROM public.sst_cap_sesiones s WHERE s.capacitacion_id = c.id AND s.estado = 'realizada') AS horas_realizadas,
         (SELECT count(*) FROM public.sst_cap_asistentes a JOIN public.sst_cap_sesiones s ON s.id = a.sesion_id
           WHERE s.capacitacion_id = c.id AND s.estado = 'realizada')::int AS convocados,
         (SELECT count(*) FROM public.sst_cap_asistentes a JOIN public.sst_cap_sesiones s ON s.id = a.sesion_id
           WHERE s.capacitacion_id = c.id AND s.estado = 'realizada' AND a.asistio)::int AS asistentes
) x
CROSS JOIN LATERAL (
  SELECT (SELECT count(*) FROM unnest(c.meses_programados) AS mm WHERE mm < public.sst_mes_ref(c.vigencia))::int AS esp_antes,
         (SELECT count(*) FROM unnest(c.meses_programados) AS mm WHERE mm <= public.sst_mes_ref(c.vigencia))::int AS esp_hasta
) y;
COMMENT ON VIEW public.sst_capacitaciones_resumen IS
  'SG-SST. Tema de capacitación + meses ejecutados (sesiones realizadas), convocados/asistentes, cobertura y semáforo.';
REVOKE ALL ON public.sst_capacitaciones_resumen FROM anon;

-- 5e. Indicadores mensuales del programa (equivalen a «cumplimiento» y «cobertura» del cronograma de formación).
CREATE OR REPLACE VIEW public.sst_cap_indicadores_mes
WITH (security_invoker = true) AS
SELECT k.empresa_id, k.vigencia, m.mes,
  (SELECT count(*) FROM public.sst_capacitaciones c
    WHERE c.empresa_id = k.empresa_id AND c.vigencia = k.vigencia AND c.activa AND m.mes = ANY (c.meses_programados))::int AS programadas,
  (SELECT count(*) FROM public.sst_capacitaciones c
    WHERE c.empresa_id = k.empresa_id AND c.vigencia = k.vigencia AND c.activa AND m.mes = ANY (c.meses_programados)
      AND EXISTS (SELECT 1 FROM public.sst_cap_sesiones s
                   WHERE s.capacitacion_id = c.id AND s.estado = 'realizada' AND extract(month FROM s.fecha)::int = m.mes))::int AS ejecutadas_programadas,
  (SELECT count(DISTINCT s.capacitacion_id) FROM public.sst_cap_sesiones s JOIN public.sst_capacitaciones c ON c.id = s.capacitacion_id
    WHERE c.empresa_id = k.empresa_id AND c.vigencia = k.vigencia AND s.estado = 'realizada' AND extract(month FROM s.fecha)::int = m.mes)::int AS ejecutadas,
  (SELECT count(*) FROM public.sst_cap_asistentes a JOIN public.sst_cap_sesiones s ON s.id = a.sesion_id JOIN public.sst_capacitaciones c ON c.id = s.capacitacion_id
    WHERE c.empresa_id = k.empresa_id AND c.vigencia = k.vigencia AND s.estado = 'realizada' AND extract(month FROM s.fecha)::int = m.mes)::int AS convocados,
  (SELECT count(*) FROM public.sst_cap_asistentes a JOIN public.sst_cap_sesiones s ON s.id = a.sesion_id JOIN public.sst_capacitaciones c ON c.id = s.capacitacion_id
    WHERE c.empresa_id = k.empresa_id AND c.vigencia = k.vigencia AND s.estado = 'realizada' AND extract(month FROM s.fecha)::int = m.mes AND a.asistio)::int AS asistentes
FROM (SELECT DISTINCT empresa_id, vigencia FROM public.sst_capacitaciones) k
CROSS JOIN generate_series(1, 12) AS m(mes);
COMMENT ON VIEW public.sst_cap_indicadores_mes IS
  'SG-SST. Por empresa, vigencia y mes: temas programados / ejecutados, convocados y asistentes de las sesiones realizadas.';
REVOKE ALL ON public.sst_cap_indicadores_mes FROM anon;

-- ── 6. Copiar un plan a la vigencia siguiente (invoker: aplica la RLS y los triggers) ──
-- Copia el encabezado, las actividades (con su programación mensual, sin lo ejecutado) y los temas
-- de capacitación activos. No copia firma, fechas, sesiones ni evidencias.
CREATE OR REPLACE FUNCTION public.sst_plan_copiar(p_plan_origen bigint, p_vigencia integer)
RETURNS bigint
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  o public.sst_planes%ROWTYPE;
  v_new bigint;
BEGIN
  IF p_vigencia IS NULL OR p_vigencia < 2019 OR p_vigencia > 2100 THEN
    RAISE EXCEPTION 'La vigencia debe ser un año entre 2019 y 2100';
  END IF;
  SELECT * INTO o FROM sst_planes WHERE id = p_plan_origen;
  IF NOT FOUND THEN RAISE EXCEPTION 'El plan de origen no existe'; END IF;
  IF o.vigencia = p_vigencia THEN RAISE EXCEPTION 'La vigencia nueva debe ser distinta de la del plan de origen'; END IF;

  INSERT INTO sst_planes (empresa_id, vigencia, codigo_documento, version, objetivo, metas, recursos, empleador_nombre, responsable_nombre)
  VALUES (o.empresa_id, p_vigencia, o.codigo_documento, '1', o.objetivo, o.metas, o.recursos, o.empleador_nombre, o.responsable_nombre)
  RETURNING id INTO v_new;

  INSERT INTO sst_plan_actividades (plan_id, orden, ciclo, grupo, item_codigo, item_nombre, actividad, responsable, peso, aplica, motivo_no_aplica, meses_programados)
  SELECT v_new, a.orden, a.ciclo, a.grupo, a.item_codigo, a.item_nombre, a.actividad, a.responsable, a.peso, a.aplica, a.motivo_no_aplica, a.meses_programados
  FROM sst_plan_actividades a
  WHERE a.plan_id = p_plan_origen
  ORDER BY a.orden, a.id;

  INSERT INTO sst_capacitaciones (empresa_id, vigencia, tema, dirigido_a, responsable, entregable, horas_previstas, meses_programados)
  SELECT c.empresa_id, p_vigencia, c.tema, c.dirigido_a, c.responsable, c.entregable, c.horas_previstas, c.meses_programados
  FROM sst_capacitaciones c
  WHERE c.empresa_id = o.empresa_id AND c.vigencia = o.vigencia AND c.activa
  ON CONFLICT DO NOTHING;

  RETURN v_new;
END;
$$;
REVOKE ALL ON FUNCTION public.sst_plan_copiar(bigint, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sst_plan_copiar(bigint, integer) TO authenticated;

-- ── 7. RLS ───────────────────────────────────────────────────
ALTER TABLE public.sst_planes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sst_plan_actividades ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sst_capacitaciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sst_cap_sesiones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sst_cap_asistentes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sst_planes FROM anon;
REVOKE ALL ON public.sst_plan_actividades FROM anon;
REVOKE ALL ON public.sst_capacitaciones FROM anon;
REVOKE ALL ON public.sst_cap_sesiones FROM anon;
REVOKE ALL ON public.sst_cap_asistentes FROM anon;

-- Planes, actividades, capacitaciones y sesiones: el módulo lee, crea y edita; borrar solo admin.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sst_planes','sst_plan_actividades','sst_capacitaciones','sst_cap_sesiones'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING ((select public.user_has_module_pqrs(%L)))', t || '_select', t, 'sst');
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_insert', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK ((select public.user_has_module_pqrs(%L)))', t || '_insert', t, 'sst');
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_update', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING ((select public.user_has_module_pqrs(%L))) WITH CHECK ((select public.user_has_module_pqrs(%L)))', t || '_update', t, 'sst', 'sst');
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_delete', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (get_user_role_pqrs() = %L)', t || '_delete', t, 'admin');
  END LOOP;
END;
$$;

-- Asistentes: igual, pero el módulo también puede quitar un convocado (el trigger lo limita a sesiones
-- programadas; el admin puede siempre).
DROP POLICY IF EXISTS "sst_cap_asistentes_select" ON public.sst_cap_asistentes;
CREATE POLICY "sst_cap_asistentes_select" ON public.sst_cap_asistentes FOR SELECT TO authenticated
  USING ((select public.user_has_module_pqrs('sst')));
DROP POLICY IF EXISTS "sst_cap_asistentes_insert" ON public.sst_cap_asistentes;
CREATE POLICY "sst_cap_asistentes_insert" ON public.sst_cap_asistentes FOR INSERT TO authenticated
  WITH CHECK ((select public.user_has_module_pqrs('sst')));
DROP POLICY IF EXISTS "sst_cap_asistentes_update" ON public.sst_cap_asistentes;
CREATE POLICY "sst_cap_asistentes_update" ON public.sst_cap_asistentes FOR UPDATE TO authenticated
  USING ((select public.user_has_module_pqrs('sst')))
  WITH CHECK ((select public.user_has_module_pqrs('sst')));
DROP POLICY IF EXISTS "sst_cap_asistentes_delete" ON public.sst_cap_asistentes;
CREATE POLICY "sst_cap_asistentes_delete" ON public.sst_cap_asistentes FOR DELETE TO authenticated
  USING ((select public.user_has_module_pqrs('sst')));

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- SG-SST (Res. 312 de 2019) en panel-pqrs — FASE 3: eventos (accidentes, incidentes, condiciones
-- inseguras, enfermedad laboral), acciones correctivas/preventivas/de mejora e indicadores
-- Requiere 0015 a 0017.
--
-- Fuentes verificadas en el texto oficial:
--   - Res. 1401/2007: investigar TODO incidente y accidente dentro de los 15 días siguientes (art. 4;
--     el texto no distingue hábiles de calendario: se cuentan calendario, que es lo prudente); equipo
--     mínimo = jefe inmediato, representante del COPASST o Vigía y encargado del SG-SST, más profesional
--     con licencia en SST si es grave o mortal (art. 7); accidente grave = amputación, fractura de huesos
--     largos, quemadura de 2.º y 3.er grado o lesión ocular que comprometa la agudeza o el campo visual
--     (art. 3); informe a la ARL en 15 días si es grave o mortal (art. 14); causas inmediatas (actos y
--     condiciones subestándar) y básicas (factores personales y del trabajo) (arts. 3 y 11); medidas de
--     intervención con responsable y fecha, y verificación de su efectividad (art. 12).
--   - Res. 156/2005 y Decreto 1072/2015: el FURAT se reporta a la ARL y a la EPS dentro de los 2 días
--     hábiles siguientes; los accidentes graves y mortales, además, a la Dirección Territorial en 2 días
--     hábiles. NO se descuentan festivos (no hay tabla de festivos): el límite que muestra la app es el
--     más temprano posible, es decir, el prudente.
--   - Res. 312/2019, art. 30: frecuencia = AT del mes / trabajadores del mes x 100; severidad = (días de
--     incapacidad por AT del mes + días cargados) / trabajadores del mes x 100; proporción de AT mortales =
--     mortales del año / AT del año x 100; prevalencia e incidencia de enfermedad laboral = casos
--     (nuevos y antiguos / nuevos) / promedio de trabajadores x 100.000. El ausentismo por causa médica NO
--     va en esta fase (exige los días de incapacidad por enfermedad común de cada trabajador).
--
-- Decisiones de diseño:
--   - Datos de salud: NO se guarda diagnóstico, tipo de lesión ni parte del cuerpo; solo gravedad, días de
--     incapacidad y la clasificación no clínica del FURAT (tipo de accidente, mecanismo, agente). La
--     investigación firmada, el FURAT y la lección aprendida permanecen en Drive (enlaces como evidencia).
--   - Los plazos y el estado de cada plazo NO se guardan: los calcula la vista sst_eventos_resumen.
--   - Los días de incapacidad y los días cargados se atribuyen al MES DEL ACCIDENTE (simplificación: la
--     norma habla de los días de incapacidad "en el mes").
--   - Trabajadores del mes = trabajadores registrados activos en ese mes; si no hay ninguno registrado se
--     usa el número declarado de la empresa (la vista indica la base usada).
--   - Una sola matriz de acciones (sst_acciones) con origen: evento, resultado del SG-SST, revisión por la
--     dirección, auditoría, inspección u otro (ítems 5.1 a 5.4 del plan anual).
--   - Nada se borra desde el cliente (DELETE solo admin): los eventos se anulan (con motivo) y las acciones
--     se cancelan (con motivo).
--
-- Idempotente. Aplicar con apply_migration (MCP) ANTES de publicar el frontend.
-- ============================================================

-- ── 0. Utilidades ────────────────────────────────────────────
-- Suma n días HÁBILES (lunes a viernes; no descuenta festivos) a una fecha.
CREATE OR REPLACE FUNCTION public.sst_dias_habiles_sumar(p_fecha date, p_n integer)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  d date := p_fecha;
  k integer := 0;
BEGIN
  IF p_fecha IS NULL OR p_n IS NULL THEN RETURN NULL; END IF;
  WHILE k < p_n LOOP
    d := d + 1;
    IF extract(isodow FROM d) < 6 THEN k := k + 1; END IF;
  END LOOP;
  RETURN d;
END;
$$;
REVOKE ALL ON FUNCTION public.sst_dias_habiles_sumar(date, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sst_dias_habiles_sumar(date, integer) TO authenticated;

-- Fecha de hoy en Bogotá.
CREATE OR REPLACE FUNCTION public.sst_hoy()
RETURNS date
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT (now() AT TIME ZONE 'America/Bogota')::date;
$$;
REVOKE ALL ON FUNCTION public.sst_hoy() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sst_hoy() TO authenticated;

-- ── 1. Eventos ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sst_eventos (
  id                        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa_id                bigint NOT NULL REFERENCES public.sst_empresas(id),
  tipo                      text NOT NULL CHECK (tipo IN ('accidente','incidente','condicion_insegura','enfermedad_laboral')),
  -- Fecha del evento (en enfermedad laboral: fecha del diagnóstico o de la calificación).
  fecha_evento              date NOT NULL,
  hora_evento               time,
  trabajador_id             bigint REFERENCES public.sst_trabajadores(id),
  -- Solo accidentes (Res. 1401, art. 3: grave = amputación, fractura de huesos largos, quemadura de 2.º y
  -- 3.er grado o lesión ocular que comprometa agudeza o campo visual).
  gravedad                  text CHECK (gravedad IN ('leve','grave','mortal')),
  tipo_accidente            text CHECK (tipo_accidente IN ('propios_del_trabajo','transito','violencia','deportivo','recreativo')),
  dentro_empresa            boolean,
  lugar                     text NOT NULL DEFAULT '',
  -- Clasificación no clínica del FURAT (Res. 156/2005).
  mecanismo                 text CHECK (mecanismo IN ('caida_personas','caida_objetos','pisadas_choques_golpes','atrapamientos',
                                                      'sobreesfuerzo','temperatura_extrema','electricidad','sustancias_nocivas','otro')),
  agente                    text CHECK (agente IN ('maquinas_equipos','medios_transporte','aparatos','herramientas',
                                                   'materiales_sustancias','ambiente_trabajo','otros','sin_clasificar')),
  -- Qué pasó. SIN datos médicos: el diagnóstico, la lesión y la parte del cuerpo viven en el FURAT (Drive).
  descripcion               text NOT NULL CHECK (char_length(btrim(descripcion)) BETWEEN 3 AND 3000),
  dias_incapacidad          integer NOT NULL DEFAULT 0 CHECK (dias_incapacidad BETWEEN 0 AND 3650),
  dias_cargados             integer NOT NULL DEFAULT 0 CHECK (dias_cargados BETWEEN 0 AND 30000),
  -- Enfermedad laboral: hasta cuándo es un caso activo (NULL = sigue activo) para la prevalencia.
  caso_hasta                date,
  -- Reporte (FURAT a ARL y EPS; graves y mortales además a la Dirección Territorial).
  referencia_reporte        text NOT NULL DEFAULT '',
  fecha_reporte_arl         date,
  fecha_reporte_eps         date,
  fecha_reporte_territorial date,
  estado                    text NOT NULL DEFAULT 'abierto' CHECK (estado IN ('abierto','en_investigacion','investigado','cerrado','anulado')),
  -- Investigación (Res. 1401).
  fecha_investigacion       date,
  equipo_investigador       text NOT NULL DEFAULT '',
  profesional_licencia_sst  text NOT NULL DEFAULT '',
  causas_inmediatas         text NOT NULL DEFAULT '',
  causas_basicas            text NOT NULL DEFAULT '',
  tipos_causa_inmediata     text[] NOT NULL DEFAULT '{}'::text[] CHECK (tipos_causa_inmediata <@ ARRAY['acto_subestandar','condicion_subestandar']::text[]),
  tipos_causa_basica        text[] NOT NULL DEFAULT '{}'::text[] CHECK (tipos_causa_basica <@ ARRAY['factor_personal','factor_trabajo']::text[]),
  informe_enviado_arl_en    date,
  leccion_aprendida         text NOT NULL DEFAULT '',
  leccion_socializada_en    date,
  cerrado_en                date,
  motivo_anulacion          text NOT NULL DEFAULT '',
  observaciones             text NOT NULL DEFAULT '',
  creado_por                uuid,
  creado_por_nombre         text,
  creado_en                 timestamptz,
  modificado_por            uuid,
  modificado_por_nombre     text,
  modificado_en             timestamptz
);
CREATE INDEX IF NOT EXISTS sst_eventos_empresa_fecha ON public.sst_eventos (empresa_id, fecha_evento);
CREATE INDEX IF NOT EXISTS sst_eventos_trabajador ON public.sst_eventos (trabajador_id) WHERE trabajador_id IS NOT NULL;
COMMENT ON TABLE public.sst_eventos IS
  'SG-SST. Accidentes, incidentes, condiciones inseguras y casos de enfermedad laboral. SIN datos médicos. Plazos: vista sst_eventos_resumen.';

-- ── 2. Acciones correctivas, preventivas y de mejora ─────────
CREATE TABLE IF NOT EXISTS public.sst_acciones (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa_id            bigint NOT NULL REFERENCES public.sst_empresas(id),
  origen                text NOT NULL CHECK (origen IN ('evento','resultado_sgsst','revision_direccion','auditoria','inspeccion','otro')),
  evento_id             bigint REFERENCES public.sst_eventos(id),
  tipo                  text NOT NULL DEFAULT 'correctiva' CHECK (tipo IN ('correctiva','preventiva','mejora')),
  hallazgo              text NOT NULL DEFAULT '',
  descripcion           text NOT NULL CHECK (char_length(btrim(descripcion)) BETWEEN 3 AND 1000),
  -- Dónde se interviene (Res. 1401, art. 12 y formato de investigación): fuente, medio, trabajador o proceso.
  nivel_control         text CHECK (nivel_control IN ('fuente','medio','trabajador','proceso')),
  responsable           text NOT NULL DEFAULT '',
  fecha_limite          date NOT NULL,
  estado                text NOT NULL DEFAULT 'abierta' CHECK (estado IN ('abierta','en_curso','en_verificacion','cerrada','cancelada')),
  fecha_ejecucion       date,
  fecha_verificacion    date,
  verificacion_eficaz   boolean,
  resultado_verificacion text NOT NULL DEFAULT '',
  verificado_por        text NOT NULL DEFAULT '',
  motivo_cancelacion    text NOT NULL DEFAULT '',
  cerrada_en            date,
  observaciones         text NOT NULL DEFAULT '',
  creado_por            uuid,
  creado_por_nombre     text,
  creado_en             timestamptz,
  modificado_por        uuid,
  modificado_por_nombre text,
  modificado_en         timestamptz,
  CONSTRAINT sst_acciones_evento_check CHECK ((origen = 'evento') = (evento_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS sst_acciones_empresa_estado ON public.sst_acciones (empresa_id, estado);
CREATE INDEX IF NOT EXISTS sst_acciones_evento ON public.sst_acciones (evento_id) WHERE evento_id IS NOT NULL;
COMMENT ON TABLE public.sst_acciones IS
  'SG-SST. Matriz de acciones correctivas, preventivas y de mejora (origen: evento, resultado del SG-SST, revisión por la dirección, auditoría, inspección u otro).';

-- ── 3. Reglas del servidor ───────────────────────────────────
-- 3a. Eventos
CREATE OR REPLACE FUNCTION public.sst_eventos_reglas()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_activa boolean;
  v_trab_emp bigint;
  v_hoy date := public.sst_hoy();
  v_es_admin boolean := (get_user_role_pqrs() IS NOT DISTINCT FROM 'admin');
  v_pendientes integer;
  v_cerradas integer;
  v_validas integer;
BEGIN
  NEW.lugar := btrim(NEW.lugar);
  NEW.descripcion := btrim(NEW.descripcion);
  NEW.referencia_reporte := btrim(NEW.referencia_reporte);
  NEW.equipo_investigador := btrim(NEW.equipo_investigador);
  NEW.profesional_licencia_sst := btrim(NEW.profesional_licencia_sst);
  NEW.causas_inmediatas := btrim(NEW.causas_inmediatas);
  NEW.causas_basicas := btrim(NEW.causas_basicas);
  NEW.leccion_aprendida := btrim(NEW.leccion_aprendida);
  NEW.motivo_anulacion := btrim(NEW.motivo_anulacion);

  IF TG_OP = 'INSERT' THEN
    SELECT activa INTO v_activa FROM sst_empresas WHERE id = NEW.empresa_id;
    IF v_activa IS NULL THEN RAISE EXCEPTION 'La empresa no existe'; END IF;
    IF NOT v_activa THEN RAISE EXCEPTION 'La empresa está inactiva: no se pueden registrar eventos'; END IF;
    NEW.estado := 'abierto';
    NEW.cerrado_en := NULL;
  ELSE
    NEW.empresa_id := OLD.empresa_id;
    NEW.tipo := OLD.tipo;
    IF OLD.estado = 'anulado' AND NOT v_es_admin THEN
      RAISE EXCEPTION 'El evento está anulado: solo un administrador puede modificarlo';
    END IF;
  END IF;

  -- Coherencia por tipo de evento.
  IF NEW.tipo = 'accidente' THEN
    IF NEW.gravedad IS NULL THEN RAISE EXCEPTION 'Indica la gravedad del accidente (leve, grave o mortal)'; END IF;
    IF NEW.trabajador_id IS NULL THEN RAISE EXCEPTION 'El accidente debe indicar el trabajador'; END IF;
  ELSE
    NEW.gravedad := NULL;
    NEW.tipo_accidente := NULL;
    NEW.dias_incapacidad := 0;
    NEW.dias_cargados := 0;
  END IF;
  IF NEW.tipo = 'enfermedad_laboral' THEN
    IF NEW.trabajador_id IS NULL THEN RAISE EXCEPTION 'El caso de enfermedad laboral debe indicar el trabajador'; END IF;
    IF NEW.caso_hasta IS NOT NULL AND NEW.caso_hasta < NEW.fecha_evento THEN
      RAISE EXCEPTION 'La fecha en que termina el caso no puede ser anterior a la del diagnóstico';
    END IF;
  ELSE
    NEW.caso_hasta := NULL;
  END IF;
  IF NEW.tipo NOT IN ('accidente','incidente') THEN
    NEW.mecanismo := NULL;
    NEW.agente := NULL;
  END IF;

  IF NEW.trabajador_id IS NOT NULL THEN
    SELECT empresa_id INTO v_trab_emp FROM sst_trabajadores WHERE id = NEW.trabajador_id;
    IF v_trab_emp IS DISTINCT FROM NEW.empresa_id THEN
      RAISE EXCEPTION 'El trabajador no pertenece a la empresa del evento';
    END IF;
  END IF;

  IF NEW.fecha_evento > v_hoy THEN RAISE EXCEPTION 'La fecha del evento no puede ser futura'; END IF;
  IF NEW.fecha_reporte_arl IS NOT NULL AND NEW.fecha_reporte_arl < NEW.fecha_evento THEN
    RAISE EXCEPTION 'La fecha de reporte a la ARL no puede ser anterior al evento';
  END IF;
  IF NEW.fecha_reporte_eps IS NOT NULL AND NEW.fecha_reporte_eps < NEW.fecha_evento THEN
    RAISE EXCEPTION 'La fecha de reporte a la EPS no puede ser anterior al evento';
  END IF;
  IF NEW.fecha_reporte_territorial IS NOT NULL AND NEW.fecha_reporte_territorial < NEW.fecha_evento THEN
    RAISE EXCEPTION 'La fecha de reporte a la Dirección Territorial no puede ser anterior al evento';
  END IF;
  IF NEW.fecha_investigacion IS NOT NULL AND NEW.fecha_investigacion < NEW.fecha_evento THEN
    RAISE EXCEPTION 'La fecha de la investigación no puede ser anterior al evento';
  END IF;

  -- Estados permitidos según el tipo.
  IF NEW.tipo IN ('condicion_insegura','enfermedad_laboral') AND NEW.estado NOT IN ('abierto','cerrado','anulado') THEN
    RAISE EXCEPTION 'Este tipo de evento solo puede estar abierto, cerrado o anulado';
  END IF;

  -- Transiciones.
  IF TG_OP = 'UPDATE' AND NEW.estado IS DISTINCT FROM OLD.estado THEN
    IF OLD.estado IN ('cerrado','anulado') AND NOT v_es_admin THEN
      RAISE EXCEPTION 'Solo un administrador puede reabrir un evento % ', OLD.estado;
    END IF;
    IF NEW.estado = 'investigado' THEN
      IF NEW.fecha_investigacion IS NULL THEN RAISE EXCEPTION 'Para dar por investigado el evento indica la fecha de la investigación'; END IF;
      IF NEW.equipo_investigador = '' THEN RAISE EXCEPTION 'Para dar por investigado el evento indica el equipo investigador'; END IF;
      IF NEW.causas_inmediatas = '' OR NEW.causas_basicas = '' THEN
        RAISE EXCEPTION 'Para dar por investigado el evento describe las causas inmediatas y las causas básicas';
      END IF;
      IF NEW.tipo = 'accidente' AND NEW.gravedad IN ('grave','mortal') AND NEW.profesional_licencia_sst = '' THEN
        RAISE EXCEPTION 'Un accidente grave o mortal exige un profesional con licencia en SST en la investigación (Res. 1401, art. 7)';
      END IF;
      SELECT count(*) INTO v_validas FROM sst_acciones WHERE evento_id = OLD.id AND estado <> 'cancelada';
      IF v_validas = 0 THEN
        RAISE EXCEPTION 'Para dar por investigado el evento registra al menos una medida de intervención (acción)';
      END IF;
    ELSIF NEW.estado = 'cerrado' THEN
      IF NEW.tipo IN ('accidente','incidente') AND OLD.estado IS DISTINCT FROM 'investigado' THEN
        RAISE EXCEPTION 'Antes de cerrar el evento debe estar investigado';
      END IF;
      SELECT count(*) FILTER (WHERE estado NOT IN ('cerrada','cancelada')),
             count(*) FILTER (WHERE estado = 'cerrada')
        INTO v_pendientes, v_cerradas FROM sst_acciones WHERE evento_id = OLD.id;
      IF v_pendientes > 0 THEN
        RAISE EXCEPTION 'No se puede cerrar el evento: hay % acción(es) sin cerrar', v_pendientes;
      END IF;
      IF NEW.tipo <> 'enfermedad_laboral' AND v_cerradas = 0 THEN
        RAISE EXCEPTION 'Para cerrar el evento registra y cierra al menos una acción';
      END IF;
      NEW.cerrado_en := COALESCE(NEW.cerrado_en, v_hoy);
    ELSIF NEW.estado = 'anulado' THEN
      IF char_length(NEW.motivo_anulacion) < 3 THEN RAISE EXCEPTION 'Indica el motivo de la anulación'; END IF;
      SELECT count(*) INTO v_pendientes FROM sst_acciones WHERE evento_id = OLD.id AND estado NOT IN ('cerrada','cancelada');
      IF v_pendientes > 0 THEN
        RAISE EXCEPTION 'No se puede anular el evento: cancela primero sus % acción(es) abierta(s)', v_pendientes;
      END IF;
    END IF;
    IF NEW.estado <> 'cerrado' THEN NEW.cerrado_en := NULL; END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.sst_eventos_reglas() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_reglas ON public.sst_eventos;
CREATE TRIGGER trg_reglas BEFORE INSERT OR UPDATE ON public.sst_eventos
  FOR EACH ROW EXECUTE FUNCTION public.sst_eventos_reglas();
DROP TRIGGER IF EXISTS trg_auditoria ON public.sst_eventos;
CREATE TRIGGER trg_auditoria BEFORE INSERT OR UPDATE ON public.sst_eventos
  FOR EACH ROW EXECUTE FUNCTION public.sst_set_auditoria();

-- 3b. Acciones
CREATE OR REPLACE FUNCTION public.sst_acciones_reglas()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_activa boolean;
  v_ev_emp bigint;
  v_ev_estado text;
  v_hoy date := public.sst_hoy();
  v_es_admin boolean := (get_user_role_pqrs() IS NOT DISTINCT FROM 'admin');
BEGIN
  NEW.hallazgo := btrim(NEW.hallazgo);
  NEW.descripcion := btrim(NEW.descripcion);
  NEW.responsable := btrim(NEW.responsable);
  NEW.resultado_verificacion := btrim(NEW.resultado_verificacion);
  NEW.verificado_por := btrim(NEW.verificado_por);
  NEW.motivo_cancelacion := btrim(NEW.motivo_cancelacion);

  IF TG_OP = 'INSERT' THEN
    SELECT activa INTO v_activa FROM sst_empresas WHERE id = NEW.empresa_id;
    IF v_activa IS NULL THEN RAISE EXCEPTION 'La empresa no existe'; END IF;
    IF NOT v_activa THEN RAISE EXCEPTION 'La empresa está inactiva: no se pueden registrar acciones'; END IF;
    IF NEW.evento_id IS NOT NULL THEN
      SELECT empresa_id, estado INTO v_ev_emp, v_ev_estado FROM sst_eventos WHERE id = NEW.evento_id;
      IF v_ev_emp IS NULL THEN RAISE EXCEPTION 'El evento no existe'; END IF;
      IF v_ev_emp <> NEW.empresa_id THEN RAISE EXCEPTION 'El evento no pertenece a la empresa de la acción'; END IF;
      IF v_ev_estado IN ('cerrado','anulado') THEN
        RAISE EXCEPTION 'El evento está % : reábrelo antes de agregarle acciones', v_ev_estado;
      END IF;
    END IF;
    NEW.estado := 'abierta';
    NEW.cerrada_en := NULL;
  ELSE
    NEW.empresa_id := OLD.empresa_id;
    NEW.origen := OLD.origen;
    NEW.evento_id := OLD.evento_id;
    IF OLD.estado IN ('cerrada','cancelada') AND NEW.estado IS DISTINCT FROM OLD.estado AND NOT v_es_admin THEN
      RAISE EXCEPTION 'Solo un administrador puede reabrir una acción %', OLD.estado;
    END IF;
  END IF;

  IF char_length(NEW.responsable) < 2 THEN RAISE EXCEPTION 'Indica el responsable de la acción'; END IF;
  IF NEW.fecha_ejecucion IS NOT NULL AND NEW.fecha_ejecucion > v_hoy THEN
    RAISE EXCEPTION 'La fecha de ejecución no puede ser futura';
  END IF;
  IF NEW.fecha_verificacion IS NOT NULL AND NEW.fecha_verificacion > v_hoy THEN
    RAISE EXCEPTION 'La fecha de verificación no puede ser futura';
  END IF;
  IF NEW.fecha_ejecucion IS NOT NULL AND NEW.fecha_verificacion IS NOT NULL AND NEW.fecha_verificacion < NEW.fecha_ejecucion THEN
    RAISE EXCEPTION 'La verificación no puede ser anterior a la ejecución';
  END IF;

  IF NEW.estado = 'en_verificacion' AND NEW.fecha_ejecucion IS NULL THEN
    RAISE EXCEPTION 'Para pasar a verificación indica la fecha de ejecución';
  END IF;
  IF NEW.estado = 'cerrada' THEN
    IF NEW.fecha_ejecucion IS NULL OR NEW.fecha_verificacion IS NULL OR NEW.verificacion_eficaz IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Para cerrar la acción registra la fecha de ejecución, la fecha de verificación y que fue eficaz';
    END IF;
    NEW.cerrada_en := COALESCE(NEW.cerrada_en, v_hoy);
  ELSE
    NEW.cerrada_en := NULL;
  END IF;
  IF NEW.estado = 'cancelada' AND char_length(NEW.motivo_cancelacion) < 3 THEN
    RAISE EXCEPTION 'Indica el motivo de la cancelación';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.sst_acciones_reglas() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_reglas ON public.sst_acciones;
CREATE TRIGGER trg_reglas BEFORE INSERT OR UPDATE ON public.sst_acciones
  FOR EACH ROW EXECUTE FUNCTION public.sst_acciones_reglas();
DROP TRIGGER IF EXISTS trg_auditoria ON public.sst_acciones;
CREATE TRIGGER trg_auditoria BEFORE INSERT OR UPDATE ON public.sst_acciones
  FOR EACH ROW EXECUTE FUNCTION public.sst_set_auditoria();

-- ── 4. Evidencias: el FURAT, la investigación y la lección aprendida respaldan un evento; los soportes de
-- ejecución respaldan una acción ──
ALTER TABLE public.sst_evidencias DROP CONSTRAINT IF EXISTS sst_evidencias_entidad_tipo_check;
ALTER TABLE public.sst_evidencias ADD CONSTRAINT sst_evidencias_entidad_tipo_check
  CHECK (entidad_tipo IN ('general','autoeval_item','plan_mejora','plan','plan_actividad','cap_sesion','evento','accion'));

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
  ELSIF NEW.entidad_tipo = 'evento' THEN
    IF NOT EXISTS (SELECT 1 FROM sst_eventos e WHERE e.id = NEW.entidad_id AND e.empresa_id = NEW.empresa_id) THEN
      RAISE EXCEPTION 'La evidencia debe pertenecer a la misma empresa del evento que respalda';
    END IF;
  ELSIF NEW.entidad_tipo = 'accion' THEN
    IF NOT EXISTS (SELECT 1 FROM sst_acciones a WHERE a.id = NEW.entidad_id AND a.empresa_id = NEW.empresa_id) THEN
      RAISE EXCEPTION 'La evidencia debe pertenecer a la misma empresa de la acción que respalda';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.sst_evidencias_reglas() FROM PUBLIC, anon, authenticated;

-- ── 5. Vistas (security_invoker: respetan la RLS; solo el módulo SST las ve) ──
-- 5a. Eventos con los plazos legales y su estado.
CREATE OR REPLACE VIEW public.sst_eventos_resumen
WITH (security_invoker = true) AS
SELECT x.*,
  CASE WHEN x.estado = 'anulado' OR x.limite_reporte_arl IS NULL THEN 'na'
       WHEN x.fecha_reporte_arl IS NOT NULL THEN (CASE WHEN x.fecha_reporte_arl > x.limite_reporte_arl THEN 'tarde' ELSE 'cumplido' END)
       WHEN public.sst_hoy() > x.limite_reporte_arl THEN 'vencido' ELSE 'pendiente' END AS plazo_reporte_arl,
  CASE WHEN x.estado = 'anulado' OR x.limite_reporte_arl IS NULL THEN 'na'
       WHEN x.fecha_reporte_eps IS NOT NULL THEN (CASE WHEN x.fecha_reporte_eps > x.limite_reporte_arl THEN 'tarde' ELSE 'cumplido' END)
       WHEN public.sst_hoy() > x.limite_reporte_arl THEN 'vencido' ELSE 'pendiente' END AS plazo_reporte_eps,
  CASE WHEN x.estado = 'anulado' OR x.limite_territorial IS NULL THEN 'na'
       WHEN x.fecha_reporte_territorial IS NOT NULL THEN (CASE WHEN x.fecha_reporte_territorial > x.limite_territorial THEN 'tarde' ELSE 'cumplido' END)
       WHEN public.sst_hoy() > x.limite_territorial THEN 'vencido' ELSE 'pendiente' END AS plazo_territorial,
  CASE WHEN x.estado = 'anulado' OR x.limite_investigacion IS NULL THEN 'na'
       WHEN x.fecha_investigacion IS NOT NULL THEN (CASE WHEN x.fecha_investigacion > x.limite_investigacion THEN 'tarde' ELSE 'cumplido' END)
       WHEN public.sst_hoy() > x.limite_investigacion THEN 'vencido' ELSE 'pendiente' END AS plazo_investigacion,
  CASE WHEN x.estado = 'anulado' OR x.limite_informe_arl IS NULL THEN 'na'
       WHEN x.informe_enviado_arl_en IS NOT NULL THEN (CASE WHEN x.informe_enviado_arl_en > x.limite_informe_arl THEN 'tarde' ELSE 'cumplido' END)
       WHEN public.sst_hoy() > x.limite_informe_arl THEN 'vencido' ELSE 'pendiente' END AS plazo_informe_arl
FROM (
  SELECT e.*,
    t.nombre AS trabajador_nombre,
    t.cargo AS trabajador_cargo,
    CASE WHEN e.tipo = 'accidente' THEN public.sst_dias_habiles_sumar(e.fecha_evento, 2) END AS limite_reporte_arl,
    CASE WHEN e.tipo = 'accidente' AND e.gravedad IN ('grave','mortal') THEN public.sst_dias_habiles_sumar(e.fecha_evento, 2) END AS limite_territorial,
    CASE WHEN e.tipo IN ('accidente','incidente') THEN e.fecha_evento + 15 END AS limite_investigacion,
    CASE WHEN e.tipo = 'accidente' AND e.gravedad IN ('grave','mortal') THEN e.fecha_evento + 15 END AS limite_informe_arl,
    COALESCE(a.n_acciones, 0) AS n_acciones,
    COALESCE(a.n_acciones_abiertas, 0) AS n_acciones_abiertas,
    COALESCE(a.n_acciones_vencidas, 0) AS n_acciones_vencidas
  FROM public.sst_eventos e
  LEFT JOIN public.sst_trabajadores t ON t.id = e.trabajador_id
  LEFT JOIN LATERAL (
    SELECT (count(*) FILTER (WHERE s.estado <> 'cancelada'))::int AS n_acciones,
           (count(*) FILTER (WHERE s.estado NOT IN ('cerrada','cancelada')))::int AS n_acciones_abiertas,
           (count(*) FILTER (WHERE s.estado NOT IN ('cerrada','cancelada') AND s.fecha_limite < public.sst_hoy()))::int AS n_acciones_vencidas
    FROM public.sst_acciones s WHERE s.evento_id = e.id
  ) a ON true
) x;
COMMENT ON VIEW public.sst_eventos_resumen IS
  'SG-SST. Evento + trabajador + límites legales (FURAT 2 días hábiles sin descontar festivos; investigación e informe a la ARL 15 días) y su estado (na/pendiente/cumplido/tarde/vencido) + conteo de acciones.';
REVOKE ALL ON public.sst_eventos_resumen FROM anon;

-- 5b. Acciones con su semáforo.
CREATE OR REPLACE VIEW public.sst_acciones_calc
WITH (security_invoker = true) AS
SELECT a.*,
  e.tipo AS evento_tipo,
  e.fecha_evento AS evento_fecha,
  CASE WHEN a.estado = 'cerrada' THEN 'cerrada'
       WHEN a.estado = 'cancelada' THEN 'cancelada'
       WHEN a.fecha_limite < public.sst_hoy() THEN 'vencida'
       WHEN a.fecha_limite <= public.sst_hoy() + 7 THEN 'por_vencer'
       ELSE 'al_dia' END AS semaforo,
  (a.fecha_limite - public.sst_hoy()) AS dias_restantes
FROM public.sst_acciones a
LEFT JOIN public.sst_eventos e ON e.id = a.evento_id;
COMMENT ON VIEW public.sst_acciones_calc IS
  'SG-SST. Acción + origen del evento + semáforo (al_dia / por_vencer en 7 días / vencida / cerrada / cancelada).';
REVOKE ALL ON public.sst_acciones_calc FROM anon;

-- 5c. Indicadores mensuales de accidentalidad (Res. 312/2019, art. 30): frecuencia y severidad.
CREATE OR REPLACE VIEW public.sst_indicadores_mes
WITH (security_invoker = true) AS
SELECT k.empresa_id, k.vigencia, m.mes,
  tm.trabajadores, tm.base_trabajadores,
  COALESCE(ev.n_at, 0) AS accidentes,
  COALESCE(ev.dias_incap, 0) AS dias_incapacidad,
  COALESCE(ev.dias_carg, 0) AS dias_cargados,
  CASE WHEN tm.trabajadores > 0 THEN round(100.0 * COALESCE(ev.n_at, 0) / tm.trabajadores, 2) END AS frecuencia,
  CASE WHEN tm.trabajadores > 0 THEN round(100.0 * (COALESCE(ev.dias_incap, 0) + COALESCE(ev.dias_carg, 0)) / tm.trabajadores, 2) END AS severidad
FROM (
  SELECT id AS empresa_id, extract(year FROM public.sst_hoy())::int AS vigencia FROM public.sst_empresas WHERE activa
  UNION
  SELECT empresa_id, extract(year FROM fecha_evento)::int FROM public.sst_eventos WHERE estado <> 'anulado'
) k
CROSS JOIN generate_series(1, 12) AS m(mes)
CROSS JOIN LATERAL (
  SELECT CASE WHEN r.n > 0 THEN r.n ELSE em.num_trabajadores END AS trabajadores,
         CASE WHEN r.n > 0 THEN 'registro' ELSE 'declarado' END AS base_trabajadores
  FROM (SELECT count(*)::int AS n FROM public.sst_trabajadores t
         WHERE t.empresa_id = k.empresa_id
           AND (t.fecha_ingreso IS NULL OR t.fecha_ingreso <= (make_date(k.vigencia, m.mes, 1) + interval '1 month' - interval '1 day')::date)
           AND (t.fecha_retiro IS NULL OR t.fecha_retiro >= make_date(k.vigencia, m.mes, 1))) r
  JOIN public.sst_empresas em ON em.id = k.empresa_id
) tm
LEFT JOIN LATERAL (
  SELECT count(*)::int AS n_at, sum(e.dias_incapacidad)::int AS dias_incap, sum(e.dias_cargados)::int AS dias_carg
  FROM public.sst_eventos e
  WHERE e.empresa_id = k.empresa_id AND e.tipo = 'accidente' AND e.estado <> 'anulado'
    AND extract(year FROM e.fecha_evento)::int = k.vigencia AND extract(month FROM e.fecha_evento)::int = m.mes
) ev ON true;
COMMENT ON VIEW public.sst_indicadores_mes IS
  'SG-SST. Frecuencia y severidad de accidentalidad por empresa y mes (Res. 312/2019, art. 30). Trabajadores = registrados activos en el mes (o los declarados por la empresa si no hay registro).';
REVOKE ALL ON public.sst_indicadores_mes FROM anon;

-- 5d. Indicadores anuales: proporción de mortales, prevalencia e incidencia de enfermedad laboral.
CREATE OR REPLACE VIEW public.sst_indicadores_anio
WITH (security_invoker = true) AS
SELECT y.empresa_id, y.vigencia,
  COALESCE(a.n_at, 0) AS accidentes,
  COALESCE(a.n_mortales, 0) AS accidentes_mortales,
  CASE WHEN COALESCE(a.n_at, 0) > 0 THEN round(100.0 * COALESCE(a.n_mortales, 0) / a.n_at, 2) END AS proporcion_mortales,
  p.promedio_trabajadores,
  COALESCE(el.nuevos, 0) AS el_nuevos,
  COALESCE(el.nuevos, 0) + COALESCE(el.antiguos, 0) AS el_casos,
  CASE WHEN p.promedio_trabajadores > 0 THEN round(100000.0 * (COALESCE(el.nuevos, 0) + COALESCE(el.antiguos, 0)) / p.promedio_trabajadores, 2) END AS prevalencia,
  CASE WHEN p.promedio_trabajadores > 0 THEN round(100000.0 * COALESCE(el.nuevos, 0) / p.promedio_trabajadores, 2) END AS incidencia
FROM (SELECT DISTINCT empresa_id, vigencia FROM public.sst_indicadores_mes) y
LEFT JOIN LATERAL (
  SELECT count(*)::int AS n_at, (count(*) FILTER (WHERE e.gravedad = 'mortal'))::int AS n_mortales
  FROM public.sst_eventos e
  WHERE e.empresa_id = y.empresa_id AND e.tipo = 'accidente' AND e.estado <> 'anulado'
    AND extract(year FROM e.fecha_evento)::int = y.vigencia
) a ON true
LEFT JOIN LATERAL (
  SELECT round(avg(m.trabajadores), 2) AS promedio_trabajadores
  FROM public.sst_indicadores_mes m
  WHERE m.empresa_id = y.empresa_id AND m.vigencia = y.vigencia
    AND m.mes <= LEAST(12, public.sst_mes_ref(y.vigencia))
) p ON true
LEFT JOIN LATERAL (
  SELECT (count(*) FILTER (WHERE extract(year FROM e.fecha_evento)::int = y.vigencia))::int AS nuevos,
         (count(*) FILTER (WHERE extract(year FROM e.fecha_evento)::int < y.vigencia
                             AND (e.caso_hasta IS NULL OR extract(year FROM e.caso_hasta)::int >= y.vigencia)))::int AS antiguos
  FROM public.sst_eventos e
  WHERE e.empresa_id = y.empresa_id AND e.tipo = 'enfermedad_laboral' AND e.estado <> 'anulado'
) el ON true;
COMMENT ON VIEW public.sst_indicadores_anio IS
  'SG-SST. Por empresa y año: accidentes, proporción de mortales y prevalencia/incidencia de enfermedad laboral por 100.000 trabajadores (Res. 312/2019, art. 30). Ausentismo: pendiente.';
REVOKE ALL ON public.sst_indicadores_anio FROM anon;

-- ── 6. RLS ───────────────────────────────────────────────────
ALTER TABLE public.sst_eventos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sst_acciones ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sst_eventos FROM anon;
REVOKE ALL ON public.sst_acciones FROM anon;

-- El módulo lee, crea y edita; borrar solo admin (los eventos se anulan y las acciones se cancelan).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sst_eventos','sst_acciones'] LOOP
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

NOTIFY pgrst, 'reload schema';

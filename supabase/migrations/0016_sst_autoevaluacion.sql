-- ============================================================
-- SG-SST (Res. 312 de 2019) en panel-pqrs — FASE 1: autoevaluación de estándares mínimos
--
-- Catálogo de estándares -> autoevaluación por empresa y vigencia -> calificación por
-- estándar (cumple / no cumple) con evidencias (enlaces a Drive) -> puntaje y banda ->
-- plan de mejoramiento. Requiere 0015.
--
-- Fuentes verificadas (Res. 312/2019):
--   - art. 3: los 7 estándares del grupo de 10 o menos trabajadores (riesgo I-III), con su
--     criterio y modo de verificación (texto en sst_estandares);
--   - arts. 25-26: la autoevaluación es ANUAL (diciembre); se registra en la aplicación del
--     Ministerio y se remite copia de la autoevaluación y del plan a la ARL;
--   - art. 27: cumple = valor máximo del ítem, no cumple = 0;
--   - art. 28: < 60 % crítico (plan de mejoramiento ya + reporte de avances a la ARL en
--     <= 3 meses + seguimiento y visita); 60-85 % moderadamente aceptable (plan + reporte en
--     <= 6 meses); > 85 % aceptable. En exactamente 60 y 85 se aplica "moderado" (el texto dice
--     "entre el 60 y 85").
--
-- NO VERIFICADO: cómo se ponderan los 7 estándares. El texto oficial solo trae la Tabla de
-- Valores de 60 ítems (art. 27) y no una propia para los 7. Por eso el PESO de cada estándar
-- es un DATO del catálogo (sst_estandares.peso) con la bandera peso_verificado = false:
-- hoy son iguales (1 c/u) y toda cifra se muestra como REFERENCIAL hasta confirmar el método
-- con la plataforma sgrl.mintrabajo.gov.co o con la ARL y actualizar el catálogo.
-- La autoevaluación guarda una copia (snapshot) del peso de cada estándar al crearse, así un
-- cambio posterior del catálogo no altera evaluaciones ya hechas.
--
-- Decisiones de diseño:
--   - El puntaje y la banda NO se guardan: los calcula la vista sst_autoevaluaciones_resumen
--     a partir de las calificaciones (una sola fuente de verdad; una evaluación cerrada es
--     inmutable, así que su cifra no cambia).
--   - Los ítems los crea el servidor al crear la autoevaluación (el cliente no puede omitir
--     estándares ni inventar pesos). Si no hay catálogo cargado para el grupo de la empresa
--     (hoy solo existe el de 7), la creación falla con un mensaje claro.
--   - Cerrada = inmutable (solo se editan las fechas de reporte a la ARL y de registro en el
--     Ministerio); solo un admin puede reabrir. No se puede cerrar con estándares pendientes.
--   - Nada se borra desde el cliente (DELETE solo admin): el plan se cancela, no se borra.
--
-- Idempotente. Aplicar con apply_migration (MCP) ANTES de publicar el frontend.
-- ============================================================

-- ── 1. Catálogo de estándares (versionado; solo lectura desde el cliente) ──
CREATE TABLE IF NOT EXISTS public.sst_estandares (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  grupo           text NOT NULL CHECK (grupo IN ('7','21','60')),
  orden           integer NOT NULL CHECK (orden >= 1),
  codigo          text NOT NULL,
  ciclo           text NOT NULL CHECK (ciclo IN ('planear','hacer','verificar','actuar')),
  nombre          text NOT NULL,
  criterio        text NOT NULL,
  verificacion    text NOT NULL,
  peso            numeric(7,3) NOT NULL CHECK (peso > 0),
  peso_verificado boolean NOT NULL DEFAULT false,
  activo          boolean NOT NULL DEFAULT true,
  CONSTRAINT sst_estandares_codigo_uq UNIQUE (grupo, codigo),
  CONSTRAINT sst_estandares_orden_uq UNIQUE (grupo, orden)
);
COMMENT ON TABLE public.sst_estandares IS
  'SG-SST. Catálogo de estándares mínimos de la Res. 312/2019 por grupo (7/21/60). Hoy solo el grupo 7 (art. 3). peso_verificado=false: pesos referenciales (ver 0016).';

INSERT INTO public.sst_estandares (grupo, orden, codigo, ciclo, nombre, criterio, verificacion, peso, peso_verificado) VALUES
('7', 1, 'G7-01', 'planear', 'Asignación de persona que diseña el Sistema de Gestión de SST',
 'Asignar una persona que cumpla con el siguiente perfil: el diseño del SG-SST, para empresas de diez (10) o menos trabajadores en clase de riesgo I, II, III, puede ser realizado por un técnico en SST (o en alguna de sus áreas) con licencia vigente en SST, que acredite mínimo un (1) año de experiencia certificada y la aprobación del curso de capacitación virtual de cincuenta (50) horas. También podrá ser desarrollada por tecnólogos, profesionales y profesionales con posgrado en SST, que cuenten con licencia vigente en SST y el referido curso de cincuenta (50) horas.',
 'Solicitar documento soporte de la asignación y constatar la hoja de vida con soportes, de la persona asignada.', 1, false),
('7', 2, 'G7-02', 'planear', 'Afiliación al Sistema de Seguridad Social Integral',
 'Afiliación a los Sistemas de Seguridad Social en Salud, Pensión y Riesgos Laborales de acuerdo con la normatividad vigente.',
 'Solicitar documento soporte de afiliación y del pago correspondiente.', 1, false),
('7', 3, 'G7-03', 'planear', 'Capacitación en SST',
 'Elaborar y ejecutar programa o actividades de capacitación en promoción y prevención, que incluya como mínimo lo referente a los peligros/riesgos prioritarios y las medidas de prevención y control.',
 'Solicitar documento soporte de las acciones de capacitación realizadas / planillas, donde se evidencie la firma de los trabajadores.', 1, false),
('7', 4, 'G7-04', 'planear', 'Plan Anual de Trabajo',
 'Elaborar el Plan Anual de Trabajo del Sistema de Gestión de SST, firmado por el empleador o contratante, en el que se identifiquen como mínimo: objetivos, metas, responsabilidades, recursos y cronograma anual.',
 'Solicitar documento que contenga el Plan Anual de Trabajo.', 1, false),
('7', 5, 'G7-05', 'hacer', 'Evaluaciones médicas ocupacionales',
 'Realizar las evaluaciones médicas ocupacionales de acuerdo con la normatividad y los peligros/riesgos a los cuales se encuentre expuesto el trabajador.',
 'Conceptos emitidos por el médico evaluador en el cual informe recomendaciones y restricciones laborales.', 1, false),
('7', 6, 'G7-06', 'hacer', 'Identificación de peligros; evaluación y valoración de riesgos',
 'Realizar la identificación de peligros y la evaluación y valoración de los riesgos con el acompañamiento de la ARL.',
 'Solicitar documento con la identificación de peligros; evaluación y valoración de los riesgos. Constancia de acompañamiento de la ARL (acta de visita ARL).', 1, false),
('7', 7, 'G7-07', 'hacer', 'Medidas de prevención y control frente a peligros/riesgos identificados',
 'Ejecutar las actividades de prevención y control de peligros y/o riesgos, con base en el resultado de la identificación de peligros, la evaluación y valoración de los riesgos.',
 'Solicitar documento soporte con acciones ejecutadas.', 1, false)
ON CONFLICT (grupo, codigo) DO NOTHING;

ALTER TABLE public.sst_estandares ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sst_estandares FROM anon;
-- Solo lectura para el módulo: el catálogo se cambia por migración.
DROP POLICY IF EXISTS "sst_estandares_select" ON public.sst_estandares;
CREATE POLICY "sst_estandares_select" ON public.sst_estandares FOR SELECT TO authenticated
  USING ((select public.user_has_module_pqrs('sst')));

-- ── 2. Autoevaluaciones ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sst_autoevaluaciones (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa_id            bigint NOT NULL REFERENCES public.sst_empresas(id),
  vigencia              integer NOT NULL CHECK (vigencia BETWEEN 2019 AND 2100),
  -- Copia del grupo de la empresa al crearla (la sella el servidor).
  grupo_estandares      text NOT NULL CHECK (grupo_estandares IN ('7','21','60')),
  fecha_evaluacion      date NOT NULL DEFAULT ((now() AT TIME ZONE 'America/Bogota')::date),
  estado                text NOT NULL DEFAULT 'borrador' CHECK (estado IN ('borrador','cerrada')),
  empleador_nombre      text NOT NULL DEFAULT '',
  responsable_nombre    text NOT NULL DEFAULT '',
  observaciones         text NOT NULL DEFAULT '',
  -- Seguimiento del reporte (arts. 26 y 28): copia de la autoevaluación y el plan a la ARL, reporte
  -- de avances del plan a la ARL (3 o 6 meses según la banda) y registro en la aplicación del Ministerio.
  copia_arl_en          date,
  reporte_avances_arl_en date,
  registro_ministerio_en date,
  cerrada_en            timestamptz,
  cerrada_por           uuid,
  cerrada_por_nombre    text,
  creado_por            uuid,
  creado_por_nombre     text,
  creado_en             timestamptz,
  modificado_por        uuid,
  modificado_por_nombre text,
  modificado_en         timestamptz,
  CONSTRAINT sst_autoevaluaciones_vigencia_uq UNIQUE (empresa_id, vigencia),
  CONSTRAINT sst_autoevaluaciones_cierre_check CHECK ((estado = 'cerrada') = (cerrada_en IS NOT NULL))
);
COMMENT ON TABLE public.sst_autoevaluaciones IS
  'SG-SST. Autoevaluación anual de estándares mínimos (Res. 312/2019) por empresa y vigencia. Cerrada = inmutable. Puntaje y banda: vista sst_autoevaluaciones_resumen.';

-- ── 3. Ítems (uno por estándar; los crea el servidor) ────────
CREATE TABLE IF NOT EXISTS public.sst_autoeval_items (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  autoeval_id           bigint NOT NULL REFERENCES public.sst_autoevaluaciones(id) ON DELETE CASCADE,
  estandar_id           bigint NOT NULL REFERENCES public.sst_estandares(id),
  resultado             text NOT NULL DEFAULT 'pendiente' CHECK (resultado IN ('pendiente','cumple','no_cumple')),
  observaciones         text NOT NULL DEFAULT '',
  -- Copia del peso del catálogo al crear la autoevaluación.
  peso                  numeric(7,3) NOT NULL CHECK (peso > 0),
  peso_verificado       boolean NOT NULL,
  creado_por            uuid,
  creado_por_nombre     text,
  creado_en             timestamptz,
  modificado_por        uuid,
  modificado_por_nombre text,
  modificado_en         timestamptz,
  CONSTRAINT sst_autoeval_items_uq UNIQUE (autoeval_id, estandar_id)
);
CREATE INDEX IF NOT EXISTS sst_autoeval_items_estandar ON public.sst_autoeval_items (estandar_id);
COMMENT ON TABLE public.sst_autoeval_items IS
  'SG-SST. Calificación de cada estándar dentro de una autoevaluación (pendiente / cumple / no cumple). Los crea el servidor.';

-- ── 4. Plan de mejoramiento ──────────────────────────────────
-- Contenido mínimo (art. 28): actividades concretas, responsables, plazo, recursos y soportes
-- de efectividad (estos últimos = evidencias enlazadas con entidad_tipo 'plan_mejora').
CREATE TABLE IF NOT EXISTS public.sst_plan_mejora (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  autoeval_id           bigint NOT NULL REFERENCES public.sst_autoevaluaciones(id) ON DELETE CASCADE,
  item_id               bigint REFERENCES public.sst_autoeval_items(id),
  actividad             text NOT NULL CHECK (char_length(btrim(actividad)) BETWEEN 3 AND 500),
  responsable           text NOT NULL DEFAULT '',
  plazo                 date,
  recursos              text NOT NULL DEFAULT '',
  estado                text NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','en_curso','cumplida','cancelada')),
  fecha_cumplimiento    date,
  observaciones         text NOT NULL DEFAULT '',
  creado_por            uuid,
  creado_por_nombre     text,
  creado_en             timestamptz,
  modificado_por        uuid,
  modificado_por_nombre text,
  modificado_en         timestamptz
);
CREATE INDEX IF NOT EXISTS sst_plan_mejora_autoeval ON public.sst_plan_mejora (autoeval_id);
CREATE INDEX IF NOT EXISTS sst_plan_mejora_item ON public.sst_plan_mejora (item_id) WHERE item_id IS NOT NULL;
COMMENT ON TABLE public.sst_plan_mejora IS
  'SG-SST. Plan de mejoramiento derivado de la autoevaluación (actividad, responsable, plazo, recursos, estado). Los soportes son evidencias (entidad_tipo plan_mejora).';

-- ── 5. Reglas del servidor ───────────────────────────────────
-- 5a. Autoevaluación
CREATE OR REPLACE FUNCTION public.sst_autoeval_reglas()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_grupo text;
  v_activa boolean;
  v_pend int;
BEGIN
  NEW.empleador_nombre := btrim(NEW.empleador_nombre);
  NEW.responsable_nombre := btrim(NEW.responsable_nombre);

  IF TG_OP = 'INSERT' THEN
    SELECT grupo_estandares, activa INTO v_grupo, v_activa FROM sst_empresas WHERE id = NEW.empresa_id;
    IF v_grupo IS NULL THEN RAISE EXCEPTION 'La empresa no existe'; END IF;
    IF NOT v_activa THEN RAISE EXCEPTION 'La empresa está inactiva: no se puede crear una autoevaluación'; END IF;
    NEW.grupo_estandares := v_grupo;
    NEW.estado := 'borrador';
    NEW.cerrada_en := NULL; NEW.cerrada_por := NULL; NEW.cerrada_por_nombre := NULL;
    RETURN NEW;
  END IF;

  -- UPDATE: el cliente no cambia la empresa, la vigencia ni el grupo.
  NEW.empresa_id := OLD.empresa_id;
  NEW.vigencia := OLD.vigencia;
  NEW.grupo_estandares := OLD.grupo_estandares;

  IF OLD.estado = 'cerrada' THEN
    IF NEW.estado = 'borrador' THEN
      IF get_user_role_pqrs() IS DISTINCT FROM 'admin' THEN
        RAISE EXCEPTION 'Solo un administrador puede reabrir una autoevaluación cerrada';
      END IF;
      NEW.cerrada_en := NULL; NEW.cerrada_por := NULL; NEW.cerrada_por_nombre := NULL;
    ELSE
      IF NEW.fecha_evaluacion IS DISTINCT FROM OLD.fecha_evaluacion
         OR NEW.empleador_nombre IS DISTINCT FROM OLD.empleador_nombre
         OR NEW.responsable_nombre IS DISTINCT FROM OLD.responsable_nombre
         OR NEW.observaciones IS DISTINCT FROM OLD.observaciones THEN
        RAISE EXCEPTION 'La autoevaluación está cerrada: solo se pueden registrar las fechas de reporte a la ARL y de registro en el Ministerio';
      END IF;
      NEW.cerrada_en := OLD.cerrada_en; NEW.cerrada_por := OLD.cerrada_por; NEW.cerrada_por_nombre := OLD.cerrada_por_nombre;
    END IF;
  ELSE
    NEW.cerrada_en := NULL; NEW.cerrada_por := NULL; NEW.cerrada_por_nombre := NULL;
    IF NEW.estado = 'cerrada' THEN
      SELECT count(*) INTO v_pend FROM sst_autoeval_items WHERE autoeval_id = OLD.id AND resultado = 'pendiente';
      IF v_pend > 0 THEN
        RAISE EXCEPTION 'No se puede cerrar: faltan % estándar(es) por calificar', v_pend;
      END IF;
      NEW.cerrada_en := now();
      NEW.cerrada_por := auth.uid();
      SELECT COALESCE(NULLIF(nombre, ''), email) INTO NEW.cerrada_por_nombre FROM usuarios_pqrs WHERE id = auth.uid();
      NEW.cerrada_por_nombre := COALESCE(NEW.cerrada_por_nombre, 'Sistema');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.sst_autoeval_reglas() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_reglas ON public.sst_autoevaluaciones;
CREATE TRIGGER trg_reglas
  BEFORE INSERT OR UPDATE ON public.sst_autoevaluaciones
  FOR EACH ROW EXECUTE FUNCTION public.sst_autoeval_reglas();

DROP TRIGGER IF EXISTS trg_auditoria ON public.sst_autoevaluaciones;
CREATE TRIGGER trg_auditoria
  BEFORE INSERT OR UPDATE ON public.sst_autoevaluaciones
  FOR EACH ROW EXECUTE FUNCTION public.sst_set_auditoria();

-- 5b. Al crear la autoevaluación, el servidor crea un ítem por estándar activo del grupo.
CREATE OR REPLACE FUNCTION public.sst_autoeval_crear_items()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n int;
BEGIN
  INSERT INTO sst_autoeval_items (autoeval_id, estandar_id, peso, peso_verificado)
  SELECT NEW.id, e.id, e.peso, e.peso_verificado
  FROM sst_estandares e
  WHERE e.grupo = NEW.grupo_estandares AND e.activo
  ORDER BY e.orden;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN
    RAISE EXCEPTION 'Aún no está cargado el catálogo de estándares para el grupo de % estándares de esta empresa', NEW.grupo_estandares;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.sst_autoeval_crear_items() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_crear_items ON public.sst_autoevaluaciones;
CREATE TRIGGER trg_crear_items
  AFTER INSERT ON public.sst_autoevaluaciones
  FOR EACH ROW EXECUTE FUNCTION public.sst_autoeval_crear_items();

-- 5c. Ítems: el cliente solo cambia resultado y observaciones, y solo mientras es borrador.
CREATE OR REPLACE FUNCTION public.sst_autoeval_items_reglas()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_estado text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT peso, peso_verificado INTO NEW.peso, NEW.peso_verificado FROM sst_estandares WHERE id = NEW.estandar_id;
    RETURN NEW;
  END IF;
  SELECT estado INTO v_estado FROM sst_autoevaluaciones WHERE id = OLD.autoeval_id;
  IF v_estado = 'cerrada' THEN
    RAISE EXCEPTION 'La autoevaluación está cerrada: no se puede cambiar la calificación';
  END IF;
  NEW.autoeval_id := OLD.autoeval_id;
  NEW.estandar_id := OLD.estandar_id;
  NEW.peso := OLD.peso;
  NEW.peso_verificado := OLD.peso_verificado;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.sst_autoeval_items_reglas() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_reglas ON public.sst_autoeval_items;
CREATE TRIGGER trg_reglas
  BEFORE INSERT OR UPDATE ON public.sst_autoeval_items
  FOR EACH ROW EXECUTE FUNCTION public.sst_autoeval_items_reglas();

DROP TRIGGER IF EXISTS trg_auditoria ON public.sst_autoeval_items;
CREATE TRIGGER trg_auditoria
  BEFORE INSERT OR UPDATE ON public.sst_autoeval_items
  FOR EACH ROW EXECUTE FUNCTION public.sst_set_auditoria();

-- 5d. Plan de mejoramiento
CREATE OR REPLACE FUNCTION public.sst_plan_mejora_reglas()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.actividad := btrim(NEW.actividad);
  IF TG_OP = 'UPDATE' THEN
    NEW.autoeval_id := OLD.autoeval_id;
  END IF;
  IF NEW.item_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM sst_autoeval_items i WHERE i.id = NEW.item_id AND i.autoeval_id = NEW.autoeval_id) THEN
    RAISE EXCEPTION 'El estándar indicado no pertenece a esta autoevaluación';
  END IF;
  IF NEW.estado = 'cumplida' THEN
    IF NEW.fecha_cumplimiento IS NULL THEN
      NEW.fecha_cumplimiento := (now() AT TIME ZONE 'America/Bogota')::date;
    END IF;
  ELSE
    NEW.fecha_cumplimiento := NULL;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.sst_plan_mejora_reglas() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_reglas ON public.sst_plan_mejora;
CREATE TRIGGER trg_reglas
  BEFORE INSERT OR UPDATE ON public.sst_plan_mejora
  FOR EACH ROW EXECUTE FUNCTION public.sst_plan_mejora_reglas();

DROP TRIGGER IF EXISTS trg_auditoria ON public.sst_plan_mejora;
CREATE TRIGGER trg_auditoria
  BEFORE INSERT OR UPDATE ON public.sst_plan_mejora
  FOR EACH ROW EXECUTE FUNCTION public.sst_set_auditoria();

-- ── 6. Evidencias: ahora pueden respaldar un ítem de autoevaluación o una actividad del plan ──
ALTER TABLE public.sst_evidencias DROP CONSTRAINT IF EXISTS sst_evidencias_entidad_tipo_check;
ALTER TABLE public.sst_evidencias ADD CONSTRAINT sst_evidencias_entidad_tipo_check
  CHECK (entidad_tipo IN ('general','autoeval_item','plan_mejora'));

-- La evidencia debe pertenecer a la MISMA empresa del registro que respalda.
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
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.sst_evidencias_reglas() FROM PUBLIC, anon, authenticated;

-- ── 7. Vista de resumen: puntaje, banda y plazo del reporte a la ARL (art. 28) ──
-- security_invoker: respeta la RLS de las tablas base (solo el módulo SST la ve).
CREATE OR REPLACE VIEW public.sst_autoevaluaciones_resumen
WITH (security_invoker = true) AS
SELECT r.*,
  CASE WHEN r.puntaje IS NULL THEN NULL
       WHEN r.puntaje < 60 THEN 'critico'
       WHEN r.puntaje <= 85 THEN 'moderado'
       ELSE 'aceptable' END AS banda,
  CASE WHEN r.puntaje IS NULL OR r.puntaje > 85 THEN NULL
       WHEN r.puntaje < 60 THEN (r.fecha_evaluacion + interval '3 months')::date
       ELSE (r.fecha_evaluacion + interval '6 months')::date END AS fecha_limite_reporte_arl
FROM (
  SELECT a.*,
    s.items_total, s.items_cumple, s.items_no_cumple, s.items_pendientes, s.puntaje, s.pesos_verificados
  FROM public.sst_autoevaluaciones a
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS items_total,
           (count(*) FILTER (WHERE i.resultado = 'cumple'))::int AS items_cumple,
           (count(*) FILTER (WHERE i.resultado = 'no_cumple'))::int AS items_no_cumple,
           (count(*) FILTER (WHERE i.resultado = 'pendiente'))::int AS items_pendientes,
           CASE WHEN sum(i.peso) > 0
                THEN round(100 * COALESCE(sum(i.peso) FILTER (WHERE i.resultado = 'cumple'), 0) / sum(i.peso), 2) END AS puntaje,
           COALESCE(bool_and(i.peso_verificado), false) AS pesos_verificados
    FROM public.sst_autoeval_items i
    WHERE i.autoeval_id = a.id
  ) s ON true
) r;
COMMENT ON VIEW public.sst_autoevaluaciones_resumen IS
  'SG-SST. Autoevaluación + puntaje (peso de lo que cumple / peso total), banda (art. 28: <60 crítico, 60-85 moderado, >85 aceptable) y fecha límite del reporte de avances a la ARL (3 o 6 meses). pesos_verificados=false => cifras referenciales.';
REVOKE ALL ON public.sst_autoevaluaciones_resumen FROM anon;

-- ── 8. RLS ───────────────────────────────────────────────────
ALTER TABLE public.sst_autoevaluaciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sst_autoeval_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sst_plan_mejora ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sst_autoevaluaciones FROM anon;
REVOKE ALL ON public.sst_autoeval_items FROM anon;
REVOKE ALL ON public.sst_plan_mejora FROM anon;

-- Autoevaluaciones: el módulo lee, crea y edita; borrar solo admin.
DROP POLICY IF EXISTS "sst_autoevaluaciones_select" ON public.sst_autoevaluaciones;
CREATE POLICY "sst_autoevaluaciones_select" ON public.sst_autoevaluaciones FOR SELECT TO authenticated
  USING ((select public.user_has_module_pqrs('sst')));
DROP POLICY IF EXISTS "sst_autoevaluaciones_insert" ON public.sst_autoevaluaciones;
CREATE POLICY "sst_autoevaluaciones_insert" ON public.sst_autoevaluaciones FOR INSERT TO authenticated
  WITH CHECK ((select public.user_has_module_pqrs('sst')));
DROP POLICY IF EXISTS "sst_autoevaluaciones_update" ON public.sst_autoevaluaciones;
CREATE POLICY "sst_autoevaluaciones_update" ON public.sst_autoevaluaciones FOR UPDATE TO authenticated
  USING ((select public.user_has_module_pqrs('sst')))
  WITH CHECK ((select public.user_has_module_pqrs('sst')));
DROP POLICY IF EXISTS "sst_autoevaluaciones_delete" ON public.sst_autoevaluaciones;
CREATE POLICY "sst_autoevaluaciones_delete" ON public.sst_autoevaluaciones FOR DELETE TO authenticated
  USING (get_user_role_pqrs() = 'admin');

-- Ítems: el módulo lee y califica; NO se insertan ni borran desde el cliente (los crea el servidor).
DROP POLICY IF EXISTS "sst_autoeval_items_select" ON public.sst_autoeval_items;
CREATE POLICY "sst_autoeval_items_select" ON public.sst_autoeval_items FOR SELECT TO authenticated
  USING ((select public.user_has_module_pqrs('sst')));
DROP POLICY IF EXISTS "sst_autoeval_items_update" ON public.sst_autoeval_items;
CREATE POLICY "sst_autoeval_items_update" ON public.sst_autoeval_items FOR UPDATE TO authenticated
  USING ((select public.user_has_module_pqrs('sst')))
  WITH CHECK ((select public.user_has_module_pqrs('sst')));

-- Plan de mejoramiento: el módulo lee, crea y edita; borrar solo admin (se cancela).
DROP POLICY IF EXISTS "sst_plan_mejora_select" ON public.sst_plan_mejora;
CREATE POLICY "sst_plan_mejora_select" ON public.sst_plan_mejora FOR SELECT TO authenticated
  USING ((select public.user_has_module_pqrs('sst')));
DROP POLICY IF EXISTS "sst_plan_mejora_insert" ON public.sst_plan_mejora;
CREATE POLICY "sst_plan_mejora_insert" ON public.sst_plan_mejora FOR INSERT TO authenticated
  WITH CHECK ((select public.user_has_module_pqrs('sst')));
DROP POLICY IF EXISTS "sst_plan_mejora_update" ON public.sst_plan_mejora;
CREATE POLICY "sst_plan_mejora_update" ON public.sst_plan_mejora FOR UPDATE TO authenticated
  USING ((select public.user_has_module_pqrs('sst')))
  WITH CHECK ((select public.user_has_module_pqrs('sst')));
DROP POLICY IF EXISTS "sst_plan_mejora_delete" ON public.sst_plan_mejora;
CREATE POLICY "sst_plan_mejora_delete" ON public.sst_plan_mejora FOR DELETE TO authenticated
  USING (get_user_role_pqrs() = 'admin');

NOTIFY pgrst, 'reload schema';

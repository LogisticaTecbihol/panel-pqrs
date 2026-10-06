-- ============================================================
-- CRM de Mercadeo en panel-pqrs (migrado desde panel-pedidos)
--
-- Leads + seguimiento, Actividades (= Calendario maestro de campañas),
-- Presupuesto + gastos y catálogo de comerciales. Port de las migraciones
-- create_crm_leads / create_actividades_mercadeo / create_presupuesto_mercadeo
-- de panel-pedidos, con estos cambios:
--   - Tablas snake_case 'mercadeo_*' y valores en códigos ASCII (lección de
--     0008_fix_tipo_solicitud_acento).
--   - Acceso por módulo: user_has_module_pqrs('mercadeo') (0012). Sin ramas de
--     rol 'comercial': los comerciales NO usan este panel; "asignado a" es un
--     catálogo (mercadeo_comerciales) y mercadeo registra el seguimiento.
--   - Transiciones de estado y fechas (calificación, asignación, cierre) las
--     sella el SERVIDOR (trigger), no el reloj del navegador; reasignar o
--     recalificar no hace retroceder el lead ni reinicia fechas.
--   - autorizacion_datos (Ley 1581) obligatoria en BD, no solo en la UI.
--   - Actividades con 'en_calendario' (calendario maestro, base de las reglas
--     de "urgente fuera de calendario" de 0014).
--   - Auditoría con una sola función (mercadeo_set_auditoria); no se porta
--     audit_log (nada del CRM lo leía).
--
-- Idempotente. Aplicar con apply_migration (MCP) ANTES de publicar el frontend.
-- ============================================================

-- ── 1. Auditoría común (creado_*/modificado_* con nombre desnormalizado) ──
-- Desnormalizado porque usuarios_pqrs solo deja leer la propia fila a un no-admin.
-- 'Sistema' cuando no hay sesión (p. ej. el cron).
CREATE OR REPLACE FUNCTION public.mercadeo_set_auditoria()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_nombre text;
BEGIN
  SELECT COALESCE(NULLIF(nombre, ''), email) INTO v_nombre FROM usuarios_pqrs WHERE id = auth.uid();
  v_nombre := COALESCE(v_nombre, 'Sistema');
  IF TG_OP = 'INSERT' THEN
    NEW.creado_por := auth.uid();
    NEW.creado_por_nombre := v_nombre;
    NEW.creado_en := now();
  ELSE
    NEW.creado_por := OLD.creado_por;
    NEW.creado_por_nombre := OLD.creado_por_nombre;
    NEW.creado_en := OLD.creado_en;
  END IF;
  NEW.modificado_por := auth.uid();
  NEW.modificado_por_nombre := v_nombre;
  NEW.modificado_en := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.mercadeo_set_auditoria() FROM PUBLIC, anon, authenticated;

-- ── 2. Catálogo de comerciales (sin login) ───────────────────
CREATE TABLE IF NOT EXISTS public.mercadeo_comerciales (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre                text NOT NULL CHECK (btrim(nombre) <> ''),
  activo                boolean NOT NULL DEFAULT true,
  creado_por            uuid,
  creado_por_nombre     text,
  creado_en             timestamptz,
  modificado_por        uuid,
  modificado_por_nombre text,
  modificado_en         timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS mercadeo_comerciales_nombre_uq ON public.mercadeo_comerciales (lower(btrim(nombre)));
COMMENT ON TABLE public.mercadeo_comerciales IS
  'CRM de Mercadeo. Catálogo de comerciales a quienes se asignan leads (no son usuarios del panel).';

-- ── 3. Actividades = calendario maestro ──────────────────────
CREATE TABLE IF NOT EXISTS public.mercadeo_actividades (
  id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre                   text NOT NULL CHECK (btrim(nombre) <> ''),
  tipo                     text NOT NULL CHECK (tipo IN ('eventos','digital','pop','trade','diseno','otro')),
  empresas                 text[] NOT NULL CHECK (cardinality(empresas) >= 1
                                                  AND empresas <@ ARRAY['PARCELAR','GREEN','RESO','IASO','IAS']::text[]),
  fecha_solicitud          date,
  fecha_inicio             date,
  fecha_fin                date,
  responsable              uuid REFERENCES public.usuarios_pqrs(id),
  estado                   text NOT NULL DEFAULT 'planificada' CHECK (estado IN ('planificada','en_ejecucion','cerrada','cancelada')),
  objetivo                 text NOT NULL DEFAULT '',
  presupuesto_asignado     numeric NOT NULL DEFAULT 0 CHECK (presupuesto_asignado >= 0),
  base_datos_entregada     boolean NOT NULL DEFAULT false,
  fecha_entrega_base_datos date,
  -- Aprobada en el Calendario Maestro de Campañas (MKT-P-04). Las tareas vinculadas a una
  -- actividad aprobada están "dentro del calendario"; el resto son "fuera de calendario".
  en_calendario            boolean NOT NULL DEFAULT false,
  observaciones            text NOT NULL DEFAULT '',
  creado_por               uuid,
  creado_por_nombre        text,
  creado_en                timestamptz,
  modificado_por           uuid,
  modificado_por_nombre    text,
  modificado_en            timestamptz,
  CONSTRAINT mercadeo_actividades_fechas_check CHECK (fecha_fin IS NULL OR fecha_inicio IS NULL OR fecha_fin >= fecha_inicio)
);
CREATE INDEX IF NOT EXISTS mercadeo_actividades_estado ON public.mercadeo_actividades (estado);
CREATE INDEX IF NOT EXISTS mercadeo_actividades_tipo ON public.mercadeo_actividades (tipo);
CREATE INDEX IF NOT EXISTS mercadeo_actividades_responsable ON public.mercadeo_actividades (responsable);
COMMENT ON TABLE public.mercadeo_actividades IS
  'CRM de Mercadeo. Actividades (eventos, digital, POP, trade) con presupuesto y responsable; con en_calendario=true forman el calendario maestro aprobado.';

-- ── 4. Leads ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mercadeo_leads (
  id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre_contacto          text NOT NULL CHECK (btrim(nombre_contacto) <> ''),
  empresa_contacto         text NOT NULL DEFAULT '',
  producto_interes         text NOT NULL DEFAULT '',
  telefono                 text NOT NULL DEFAULT '',
  correo                   text NOT NULL DEFAULT '',
  municipio                text NOT NULL DEFAULT '',
  departamento             text NOT NULL DEFAULT '',
  origen                   text NOT NULL CHECK (origen IN ('evento','digital','distribuidor')),
  -- Ley 1581 de 2012: sin autorización de tratamiento de datos no se registra el contacto.
  autorizacion_datos       boolean NOT NULL DEFAULT false CHECK (autorizacion_datos = true),
  fecha_captura            date NOT NULL DEFAULT ((now() AT TIME ZONE 'America/Bogota')::date),
  calificacion             text CHECK (calificacion IS NULL OR calificacion IN ('caliente','tibio','frio')),
  fecha_calificacion       timestamptz,
  asignado_a               bigint REFERENCES public.mercadeo_comerciales(id),
  fecha_asignacion         timestamptz,
  fecha_ultima_interaccion timestamptz,
  estado                   text NOT NULL DEFAULT 'nuevo' CHECK (estado IN ('nuevo','calificado','asignado','en_seguimiento','cerrado')),
  resultado_cierre         text CHECK (resultado_cierre IS NULL OR resultado_cierre IN ('convertido','perdido','cierre_automatico')),
  valor_venta              numeric CHECK (valor_venta IS NULL OR valor_venta >= 0),
  motivo_perdida           text NOT NULL DEFAULT '',
  fecha_cierre             timestamptz,
  observaciones            text NOT NULL DEFAULT '',
  actividad_id             bigint REFERENCES public.mercadeo_actividades(id),
  creado_por               uuid,
  creado_por_nombre        text,
  creado_en                timestamptz,
  modificado_por           uuid,
  modificado_por_nombre    text,
  modificado_en            timestamptz,
  CONSTRAINT mercadeo_leads_cierre_check CHECK (
    estado <> 'cerrado'
    OR (resultado_cierre = 'convertido' AND valor_venta IS NOT NULL)
    OR (resultado_cierre = 'perdido' AND motivo_perdida <> '')
    OR resultado_cierre = 'cierre_automatico'
  )
);
CREATE INDEX IF NOT EXISTS mercadeo_leads_asignado_a ON public.mercadeo_leads (asignado_a);
CREATE INDEX IF NOT EXISTS mercadeo_leads_estado ON public.mercadeo_leads (estado);
CREATE INDEX IF NOT EXISTS mercadeo_leads_actividad_id ON public.mercadeo_leads (actividad_id);
CREATE INDEX IF NOT EXISTS mercadeo_leads_ultima_interaccion ON public.mercadeo_leads (fecha_ultima_interaccion);
COMMENT ON TABLE public.mercadeo_leads IS
  'CRM de Mercadeo. Pipeline de leads (MKT-P-10): captura, calificación, asignación a comercial (48 h), seguimiento y cierre (convertido / perdido / cierre automático a 90 días).';

-- Transiciones y sellos de fecha del lead, a cargo del servidor.
--  - Estados solo avanzan: nuevo < calificado < asignado < en_seguimiento < cerrado.
--  - calificar: nuevo -> calificado; asignar: nuevo/calificado -> asignado. Reasignar o recalificar
--    NO retrocede el estado ni reinicia fecha_asignacion / fecha_calificacion (primera vez).
--  - fecha_cierre se sella al cerrar; un lead cerrado no se reabre.
CREATE OR REPLACE FUNCTION public.mercadeo_leads_transiciones()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_orden text[] := ARRAY['nuevo','calificado','asignado','en_seguimiento','cerrado'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.estado <> 'nuevo' THEN
      RAISE EXCEPTION 'Un lead se crea en estado "nuevo"';
    END IF;
    NEW.fecha_calificacion := NULL;
    NEW.fecha_asignacion := NULL;
    NEW.fecha_cierre := NULL;
    IF NEW.calificacion IS NOT NULL THEN
      NEW.fecha_calificacion := now();
      NEW.estado := 'calificado';
    END IF;
    IF NEW.asignado_a IS NOT NULL THEN
      NEW.fecha_asignacion := now();
      NEW.estado := 'asignado';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF OLD.estado = 'cerrado' AND NEW.estado <> 'cerrado' THEN
    RAISE EXCEPTION 'Un lead cerrado no se puede reabrir';
  END IF;

  IF NEW.calificacion IS NOT NULL AND NEW.calificacion IS DISTINCT FROM OLD.calificacion THEN
    NEW.fecha_calificacion := COALESCE(OLD.fecha_calificacion, now());
    IF NEW.estado = 'nuevo' THEN NEW.estado := 'calificado'; END IF;
  ELSE
    NEW.fecha_calificacion := OLD.fecha_calificacion;
  END IF;

  IF NEW.asignado_a IS NOT NULL AND NEW.asignado_a IS DISTINCT FROM OLD.asignado_a THEN
    NEW.fecha_asignacion := COALESCE(OLD.fecha_asignacion, now());
    IF NEW.estado IN ('nuevo','calificado') THEN NEW.estado := 'asignado'; END IF;
  ELSE
    NEW.fecha_asignacion := OLD.fecha_asignacion;
  END IF;

  IF array_position(v_orden, NEW.estado) < array_position(v_orden, OLD.estado) THEN
    RAISE EXCEPTION 'El estado del lead no puede retroceder (de % a %)', OLD.estado, NEW.estado;
  END IF;

  IF NEW.estado = 'cerrado' AND OLD.estado <> 'cerrado' THEN
    NEW.fecha_cierre := now();
  ELSE
    NEW.fecha_cierre := OLD.fecha_cierre;
  END IF;

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.mercadeo_leads_transiciones() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_leads_transiciones ON public.mercadeo_leads;
CREATE TRIGGER trg_leads_transiciones
  BEFORE INSERT OR UPDATE ON public.mercadeo_leads
  FOR EACH ROW EXECUTE FUNCTION public.mercadeo_leads_transiciones();

-- ── 5. Seguimiento (timeline de interacciones por lead) ──────
CREATE TABLE IF NOT EXISTS public.mercadeo_leads_seguimiento (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lead_id               bigint NOT NULL REFERENCES public.mercadeo_leads(id) ON DELETE CASCADE,
  tipo                  text NOT NULL DEFAULT 'llamada' CHECK (tipo IN ('llamada','visita','email','whatsapp','reunion','otro')),
  fecha                 timestamptz NOT NULL DEFAULT now(),
  resultado             text NOT NULL DEFAULT '',
  observaciones         text NOT NULL DEFAULT '',
  creado_por            uuid,
  creado_por_nombre     text,
  creado_en             timestamptz,
  modificado_por        uuid,
  modificado_por_nombre text,
  modificado_en         timestamptz
);
CREATE INDEX IF NOT EXISTS mercadeo_leads_seguimiento_lead ON public.mercadeo_leads_seguimiento (lead_id);
COMMENT ON TABLE public.mercadeo_leads_seguimiento IS
  'CRM de Mercadeo. Interacciones por lead (llamadas, visitas, etc.): evidencia de gestión comercial registrada por mercadeo.';

-- Fecha del servidor y no se registra seguimiento en un lead cerrado.
CREATE OR REPLACE FUNCTION public.mercadeo_seguimiento_antes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM mercadeo_leads WHERE id = NEW.lead_id AND estado = 'cerrado') THEN
    RAISE EXCEPTION 'No se pueden registrar seguimientos en un lead cerrado';
  END IF;
  NEW.fecha := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.mercadeo_seguimiento_antes() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_seguimiento_antes ON public.mercadeo_leads_seguimiento;
CREATE TRIGGER trg_seguimiento_antes
  BEFORE INSERT ON public.mercadeo_leads_seguimiento
  FOR EACH ROW EXECUTE FUNCTION public.mercadeo_seguimiento_antes();

-- Un seguimiento nuevo actualiza el lead: última interacción y asignado -> en_seguimiento.
CREATE OR REPLACE FUNCTION public.touch_lead_on_seguimiento()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE mercadeo_leads
     SET fecha_ultima_interaccion = NEW.fecha,
         estado = CASE WHEN estado = 'asignado' THEN 'en_seguimiento' ELSE estado END
   WHERE id = NEW.lead_id;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.touch_lead_on_seguimiento() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_touch_lead_on_seguimiento ON public.mercadeo_leads_seguimiento;
CREATE TRIGGER trg_touch_lead_on_seguimiento
  AFTER INSERT ON public.mercadeo_leads_seguimiento
  FOR EACH ROW EXECUTE FUNCTION public.touch_lead_on_seguimiento();

-- ── 6. Presupuesto de mercadeo + gastos ──────────────────────
-- Lo ejecutado NUNCA se duplica en la cabecera: se suma en el cliente desde los gastos.
CREATE TABLE IF NOT EXISTS public.mercadeo_presupuesto (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa               text NOT NULL CHECK (empresa IN ('PARCELAR','GREEN','RESO','IASO','IAS')),
  rubro                 text NOT NULL CHECK (rubro IN ('eventos','digital','pop','trade','diseno','otro')),
  periodo               text NOT NULL CHECK (periodo ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  valor_presupuestado   numeric NOT NULL DEFAULT 0 CHECK (valor_presupuestado >= 0),
  observaciones         text NOT NULL DEFAULT '',
  creado_por            uuid,
  creado_por_nombre     text,
  creado_en             timestamptz,
  modificado_por        uuid,
  modificado_por_nombre text,
  modificado_en         timestamptz,
  UNIQUE (empresa, rubro, periodo)
);
COMMENT ON TABLE public.mercadeo_presupuesto IS
  'CRM de Mercadeo. Presupuesto asignado por empresa/rubro/periodo (AAAA-MM); lo ejecutado se suma desde mercadeo_presupuesto_gastos.';

CREATE TABLE IF NOT EXISTS public.mercadeo_presupuesto_gastos (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  presupuesto_id        bigint NOT NULL REFERENCES public.mercadeo_presupuesto(id) ON DELETE CASCADE,
  actividad_id          bigint REFERENCES public.mercadeo_actividades(id) ON DELETE SET NULL,
  fecha_gasto           date NOT NULL DEFAULT ((now() AT TIME ZONE 'America/Bogota')::date),
  valor_ejecutado       numeric NOT NULL CHECK (valor_ejecutado > 0),
  concepto              text NOT NULL DEFAULT '',
  fecha_legalizacion    date,
  observaciones         text NOT NULL DEFAULT '',
  creado_por            uuid,
  creado_por_nombre     text,
  creado_en             timestamptz,
  modificado_por        uuid,
  modificado_por_nombre text,
  modificado_en         timestamptz,
  CONSTRAINT mercadeo_gastos_legalizacion_check CHECK (fecha_legalizacion IS NULL OR fecha_legalizacion >= fecha_gasto)
);
CREATE INDEX IF NOT EXISTS mercadeo_gastos_presupuesto ON public.mercadeo_presupuesto_gastos (presupuesto_id);
CREATE INDEX IF NOT EXISTS mercadeo_gastos_actividad ON public.mercadeo_presupuesto_gastos (actividad_id);
COMMENT ON TABLE public.mercadeo_presupuesto_gastos IS
  'CRM de Mercadeo. Gastos ejecutados y legalizados contra una línea de presupuesto, opcionalmente ligados a una actividad.';

-- ── 7. Auditoría + RLS por módulo en las 6 tablas ────────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'mercadeo_comerciales','mercadeo_actividades','mercadeo_leads',
    'mercadeo_leads_seguimiento','mercadeo_presupuesto','mercadeo_presupuesto_gastos'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_all', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated '
      'USING ((select public.user_has_module_pqrs(%L))) '
      'WITH CHECK ((select public.user_has_module_pqrs(%L)))',
      t || '_all', t, 'mercadeo', 'mercadeo');
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_auditoria ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER trg_auditoria BEFORE INSERT OR UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.mercadeo_set_auditoria()', t);
  END LOOP;
END $$;

-- ── 8. Cierre automático de leads sin movimiento en 90 días ──
CREATE OR REPLACE FUNCTION public.cerrar_leads_inactivos()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE mercadeo_leads
     SET estado = 'cerrado',
         resultado_cierre = 'cierre_automatico'
   WHERE estado <> 'cerrado'
     AND COALESCE(fecha_ultima_interaccion, fecha_asignacion, creado_en) < now() - interval '90 days';
END;
$$;
-- Sin GRANT a authenticated/anon: solo lo invoca el cron (como postgres).
REVOKE ALL ON FUNCTION public.cerrar_leads_inactivos() FROM PUBLIC, anon, authenticated;

CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'mercadeo-cerrar-leads-inactivos';
END $$;

SELECT cron.schedule(
  'mercadeo-cerrar-leads-inactivos',
  '0 10 * * *',   -- 10:00 UTC = 5:00 a. m. Bogotá
  $$SELECT public.cerrar_leads_inactivos();$$
);

NOTIFY pgrst, 'reload schema';

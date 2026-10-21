-- ============================================================
-- Eventos: empresas ADICIONALES «Chía Abagó», «Tecbihol» y «Otros» (con el nombre escrito)
--
-- Hasta 0031 la empresa del evento era una de las 5 del holding. Ahora un evento también puede ser de:
--   CHIA_ABAGO  (Chía Abagó) · TECBIHOL (Tecbihol) · OTROS (otra empresa; el nombre va en empresa_otra, obligatorio, 3-100 car.)
-- Son solo etiquetas del evento y de su tarea: no son empresas del holding (no tienen usuarios, CRM, PQRS ni presupuesto).
--
--  1. mercadeo_eventos.empresa admite los 3 códigos nuevos; columna empresa_otra (la limpia el trigger si la empresa no es OTROS).
--  2. mercadeo_tareas.empresas admite los 3 códigos nuevos: así la tarea que nace al aprobar el evento lleva su propia empresa
--     (decisión del usuario: «el Tablero las acepta también»). Para OTROS el nombre escrito va en el título y el brief de la tarea.
--  3. mercadeo_empresa_nombre(): nombre legible de la empresa (usado por el brief y el título de la tarea).
--  4. Se redefinen mercadeo_eventos_reglas / _bitacora / mercadeo_evento_brief / mercadeo_eventos_tarea (cambios mínimos sobre 0031).
--
-- Requiere 0031. Idempotente. Aplicar con apply_migration (MCP) ANTES de redesplegar solicitud-evento-pedidos y publicar el frontend.
-- ============================================================

-- ── 1. Eventos ───────────────────────────────────────────────
ALTER TABLE public.mercadeo_eventos DROP CONSTRAINT IF EXISTS mercadeo_eventos_empresa_check;
ALTER TABLE public.mercadeo_eventos ADD CONSTRAINT mercadeo_eventos_empresa_check
  CHECK (empresa IN ('PARCELAR','GREEN','RESO','IASO','IAS','CHIA_ABAGO','TECBIHOL','OTROS'));

ALTER TABLE public.mercadeo_eventos
  ADD COLUMN IF NOT EXISTS empresa_otra text NOT NULL DEFAULT '' CHECK (char_length(empresa_otra) <= 100);

ALTER TABLE public.mercadeo_eventos DROP CONSTRAINT IF EXISTS mercadeo_eventos_empresa_otra_check;
ALTER TABLE public.mercadeo_eventos ADD CONSTRAINT mercadeo_eventos_empresa_otra_check
  CHECK ((empresa = 'OTROS') = (btrim(empresa_otra) <> ''));

COMMENT ON COLUMN public.mercadeo_eventos.empresa_otra IS
  'Nombre de la empresa cuando empresa = OTROS (obligatorio en ese caso; vacío en los demás).';

-- ── 2. Tareas del Tablero ────────────────────────────────────
ALTER TABLE public.mercadeo_tareas DROP CONSTRAINT IF EXISTS mercadeo_tareas_empresas_check;
ALTER TABLE public.mercadeo_tareas ADD CONSTRAINT mercadeo_tareas_empresas_check
  CHECK (cardinality(empresas) >= 1
         AND empresas <@ ARRAY['PARCELAR','GREEN','RESO','IASO','IAS','CHIA_ABAGO','TECBIHOL','OTROS']::text[]);

-- ── 3. Nombre legible de la empresa ──────────────────────────
CREATE OR REPLACE FUNCTION public.mercadeo_empresa_nombre(p_empresa text, p_otra text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE p_empresa
           WHEN 'CHIA_ABAGO' THEN 'Chía Abagó'
           WHEN 'TECBIHOL' THEN 'Tecbihol'
           WHEN 'OTROS' THEN 'Otros: ' || COALESCE(NULLIF(btrim(p_otra), ''), '—')
           ELSE p_empresa
         END
$$;
REVOKE ALL ON FUNCTION public.mercadeo_empresa_nombre(text, text) FROM PUBLIC, anon, authenticated;

-- ── 4. Funciones del evento (misma definición de 0031 + empresa_otra) ──
CREATE OR REPLACE FUNCTION public.mercadeo_eventos_reglas()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hoy date := (now() AT TIME ZONE 'America/Bogota')::date;
  v_nombre text;
  v_el jsonb;
  v_conc text;
  v_valor numeric;
  v_nuevo jsonb := '[]'::jsonb;
  v_cancel_in text;
BEGIN
  SELECT COALESCE(NULLIF(nombre, ''), email) INTO v_nombre FROM usuarios_pqrs WHERE id = auth.uid();
  v_nombre := COALESCE(v_nombre, 'Sistema');

  IF TG_OP = 'UPDATE' AND OLD.estado IN ('cerrada','rechazada','cancelada') THEN
    RAISE EXCEPTION 'Un evento % ya no se puede modificar',
      CASE OLD.estado WHEN 'cerrada' THEN 'cerrado' WHEN 'rechazada' THEN 'rechazado' ELSE 'cancelado' END;
  END IF;

  -- Limpieza de textos.
  NEW.nombre := btrim(NEW.nombre);
  NEW.descripcion := btrim(NEW.descripcion);
  NEW.solicitante_nombre := btrim(NEW.solicitante_nombre);
  NEW.solicitante_area := btrim(COALESCE(NEW.solicitante_area, ''));
  NEW.solicitante_correo := btrim(COALESCE(NEW.solicitante_correo, ''));
  NEW.solicitante_telefono := btrim(COALESCE(NEW.solicitante_telefono, ''));
  NEW.lugar := btrim(COALESCE(NEW.lugar, ''));
  NEW.plataforma := btrim(COALESCE(NEW.plataforma, ''));
  NEW.objetivos_otro := btrim(COALESCE(NEW.objetivos_otro, ''));
  NEW.canales_otro := btrim(COALESCE(NEW.canales_otro, ''));
  NEW.materiales_otro := btrim(COALESCE(NEW.materiales_otro, ''));
  NEW.logistica_otro := btrim(COALESCE(NEW.logistica_otro, ''));
  NEW.publico_objetivo := btrim(COALESCE(NEW.publico_objetivo, ''));
  NEW.segmento_demografico := btrim(COALESCE(NEW.segmento_demografico, ''));
  NEW.segmento_profesional := btrim(COALESCE(NEW.segmento_profesional, ''));
  NEW.nivel_conocimiento := btrim(COALESCE(NEW.nivel_conocimiento, ''));

  -- Empresa «Otros»: el nombre es obligatorio; con cualquier otra empresa no se guarda.
  NEW.empresa_otra := regexp_replace(btrim(COALESCE(NEW.empresa_otra, '')), '\s+', ' ', 'g');
  IF NEW.empresa = 'OTROS' THEN
    IF char_length(NEW.empresa_otra) NOT BETWEEN 3 AND 100 THEN
      RAISE EXCEPTION 'Escribe el nombre de la empresa (entre 3 y 100 caracteres)';
    END IF;
  ELSE
    NEW.empresa_otra := '';
  END IF;
  NEW.objetivos := COALESCE(NEW.objetivos, '{}');
  NEW.canales := COALESCE(NEW.canales, '{}');
  NEW.materiales := COALESCE(NEW.materiales, '{}');
  NEW.logistica := COALESCE(NEW.logistica, '{}');

  -- Fechas.
  IF NEW.fecha_radicacion > v_hoy THEN
    RAISE EXCEPTION 'La fecha de radicación no puede ser futura';
  END IF;
  IF NEW.fecha_evento < NEW.fecha_radicacion THEN
    RAISE EXCEPTION 'La fecha del evento no puede ser anterior a la fecha en que se radicó la solicitud';
  END IF;
  IF NEW.fecha_limite_aprobacion IS NOT NULL AND NEW.fecha_limite_aprobacion > NEW.fecha_evento THEN
    RAISE EXCEPTION 'La fecha límite de aprobación no puede ser posterior a la fecha del evento';
  END IF;

  -- Modalidad: lugar para lo presencial, plataforma para lo virtual.
  IF NEW.modalidad IN ('fisico','hibrido') AND NEW.lugar = '' THEN
    RAISE EXCEPTION 'Indica el lugar o ubicación del evento';
  END IF;
  IF NEW.modalidad IN ('virtual','hibrido') AND NEW.plataforma = '' THEN
    RAISE EXCEPTION 'Indica la plataforma del evento virtual';
  END IF;
  IF NEW.modalidad = 'fisico' THEN NEW.plataforma := ''; END IF;
  IF NEW.modalidad = 'virtual' THEN NEW.lugar := ''; END IF;

  -- Desglose de gastos: [{concepto, valor}], máximo 30 líneas.
  FOR v_el IN SELECT * FROM jsonb_array_elements(NEW.desglose_gastos) LOOP
    IF jsonb_typeof(v_el) <> 'object' THEN RAISE EXCEPTION 'Desglose de gastos inválido'; END IF;
    v_conc := btrim(COALESCE(v_el->>'concepto', ''));
    IF char_length(v_conc) NOT BETWEEN 1 AND 120 THEN
      RAISE EXCEPTION 'Cada línea del desglose de gastos necesita un concepto (máximo 120 caracteres)';
    END IF;
    BEGIN
      v_valor := (v_el->>'valor')::numeric;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'El valor de "%" en el desglose de gastos no es un número', v_conc;
    END;
    IF v_valor IS NULL OR v_valor < 0 OR v_valor > 100000000000 THEN
      RAISE EXCEPTION 'El valor de "%" en el desglose de gastos no es válido', v_conc;
    END IF;
    v_nuevo := v_nuevo || jsonb_build_array(jsonb_build_object('concepto', v_conc, 'valor', v_valor));
  END LOOP;
  NEW.desglose_gastos := v_nuevo;

  IF TG_OP = 'INSERT' THEN
    IF NEW.estado <> 'radicada' THEN
      RAISE EXCEPTION 'Un evento nuevo se registra en estado "radicada"';
    END IF;
    NEW.respondida_en := NULL;
    NEW.aprobado_por := NULL; NEW.aprobado_por_nombre := NULL; NEW.aprobado_en := NULL;
    NEW.motivo_rechazo := NULL; NEW.rechazado_por_nombre := NULL; NEW.rechazado_en := NULL;
    NEW.motivo_cancelacion := NULL; NEW.cancelado_por_nombre := NULL; NEW.cancelado_en := NULL;
    NEW.realizado_en := NULL; NEW.cerrado_en := NULL;
    NEW.bd_asistentes_fecha := NULL; NEW.bd_no_aplica := false;
    RETURN NEW;
  END IF;

  -- ── UPDATE: el cliente no fija sellos del servidor ──
  v_cancel_in := NEW.cancelado_por_nombre;   -- solo lo respeta el puente (sin sesión) al retirar una solicitud
  NEW.respondida_en := OLD.respondida_en;
  NEW.aprobado_por := OLD.aprobado_por; NEW.aprobado_por_nombre := OLD.aprobado_por_nombre; NEW.aprobado_en := OLD.aprobado_en;
  NEW.rechazado_por_nombre := OLD.rechazado_por_nombre; NEW.rechazado_en := OLD.rechazado_en;
  NEW.cancelado_por_nombre := OLD.cancelado_por_nombre; NEW.cancelado_en := OLD.cancelado_en;
  NEW.realizado_en := OLD.realizado_en; NEW.cerrado_en := OLD.cerrado_en;

  -- Base de datos de asistentes: solo una vez realizado el evento.
  IF NEW.bd_no_aplica THEN NEW.bd_asistentes_fecha := NULL; END IF;
  IF (NEW.bd_asistentes_fecha IS DISTINCT FROM OLD.bd_asistentes_fecha OR NEW.bd_no_aplica IS DISTINCT FROM OLD.bd_no_aplica)
     AND NEW.estado NOT IN ('realizada','cerrada') THEN
    RAISE EXCEPTION 'La base de datos de asistentes se registra una vez realizado el evento';
  END IF;
  IF NEW.bd_asistentes_fecha IS NOT NULL AND (NEW.bd_asistentes_fecha < NEW.fecha_evento OR NEW.bd_asistentes_fecha > v_hoy) THEN
    RAISE EXCEPTION 'La fecha de entrega de la base de datos debe estar entre el día del evento y hoy';
  END IF;

  IF NEW.estado IS DISTINCT FROM OLD.estado THEN
    IF NEW.estado = 'rechazada' THEN
      IF OLD.estado NOT IN ('radicada','en_revision') THEN
        RAISE EXCEPTION 'Solo se rechaza una solicitud que aún no fue aprobada; después se cancela';
      END IF;
      IF char_length(btrim(COALESCE(NEW.motivo_rechazo, ''))) NOT BETWEEN 3 AND 500 THEN
        RAISE EXCEPTION 'Escribe el motivo del rechazo (entre 3 y 500 caracteres)';
      END IF;
      NEW.motivo_rechazo := btrim(NEW.motivo_rechazo);
      NEW.rechazado_por_nombre := v_nombre;
      NEW.rechazado_en := now();
      IF NEW.respondida_en IS NULL THEN NEW.respondida_en := now(); END IF;
    ELSIF NEW.estado = 'cancelada' THEN
      IF char_length(btrim(COALESCE(NEW.motivo_cancelacion, ''))) NOT BETWEEN 3 AND 500 THEN
        RAISE EXCEPTION 'Escribe el motivo de la cancelación (entre 3 y 500 caracteres)';
      END IF;
      NEW.motivo_cancelacion := btrim(NEW.motivo_cancelacion);
      -- Sin sesión (puente: el solicitante retiró la solicitud) se respeta el nombre que manda el puente.
      IF auth.uid() IS NULL AND btrim(COALESCE(v_cancel_in, '')) <> '' THEN
        NEW.cancelado_por_nombre := left(btrim(v_cancel_in), 120);
      ELSE
        NEW.cancelado_por_nombre := v_nombre;
      END IF;
      NEW.cancelado_en := now();
    ELSIF OLD.estado IN ('radicada','en_revision') THEN
      IF NEW.estado NOT IN ('en_revision','aprobada') THEN
        RAISE EXCEPTION 'Una solicitud sin aprobar solo puede pasar a En revisión o Aprobada (o rechazarse / cancelarse)';
      END IF;
      IF NEW.respondida_en IS NULL THEN NEW.respondida_en := now(); END IF;
      IF NEW.estado = 'aprobada' THEN
        NEW.aprobado_por := auth.uid();
        NEW.aprobado_por_nombre := v_nombre;
        NEW.aprobado_en := now();
      END IF;
    ELSE
      -- aprobada / en_preparacion / realizada
      IF NEW.estado NOT IN ('aprobada','en_preparacion','realizada','cerrada') THEN
        RAISE EXCEPTION 'Una solicitud aprobada no puede volver a revisión';
      END IF;
      IF NEW.estado = 'realizada' THEN
        NEW.realizado_en := now();
      ELSIF NEW.estado = 'cerrada' THEN
        IF OLD.estado <> 'realizada' THEN
          RAISE EXCEPTION 'Para cerrar el evento primero debe estar marcado como Realizado';
        END IF;
        IF NEW.bd_asistentes_fecha IS NULL AND NOT NEW.bd_no_aplica THEN
          RAISE EXCEPTION 'Para cerrar el evento registra la fecha en que llegó la base de datos de asistentes (o márcala como "no aplica")';
        END IF;
        NEW.cerrado_en := now();
      ELSE
        NEW.realizado_en := NULL;   -- se devolvió a un estado anterior a Realizado
      END IF;
    END IF;
  ELSE
    -- Sin cambio de estado: motivos no se tocan.
    NEW.motivo_rechazo := OLD.motivo_rechazo;
    NEW.motivo_cancelacion := OLD.motivo_cancelacion;
  END IF;

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.mercadeo_eventos_reglas() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.mercadeo_eventos_bitacora()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old jsonb;
  v_new jsonb;
  v_col text;
  v_cambios jsonb := '{}'::jsonb;
  v_cortas constant text[] := ARRAY[
    'empresa','empresa_otra','nombre','solicitante_nombre','solicitante_area','solicitante_correo','solicitante_telefono',
    'fecha_limite_aprobacion','fecha_radicacion','fecha_evento','hora_inicio','hora_fin','modalidad','lugar',
    'plataforma','presupuesto_estimado','total_solicitado','total_invitados','asistentes_presencial',
    'asistentes_virtual','bd_asistentes_fecha','bd_no_aplica'];
  v_largas constant text[] := ARRAY[
    'descripcion','objetivos','objetivos_otro','publico_objetivo','segmento_demografico','segmento_profesional',
    'nivel_conocimiento','canales','canales_otro','materiales','materiales_otro','logistica','logistica_otro',
    'desglose_gastos'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO mercadeo_evento_bitacora (evento_id, tipo_evento, detalle)
    VALUES (NEW.id, 'creacion',
            jsonb_build_object('nombre', NEW.nombre, 'estado', NEW.estado, 'origen', NEW.origen,
                               'solicitante_nombre', NEW.solicitante_nombre, 'extemporanea', NEW.extemporanea,
                               'dias_anticipacion', NEW.dias_anticipacion)
            || CASE WHEN NEW.origen = 'panel_pedidos'
                    THEN jsonb_build_object('enviado_por', NEW.enviado_por_nombre,
                                            'aprobada_origen_por', NEW.aprobada_origen_por_nombre,
                                            'numero_origen', NEW.origen_numero)
                    ELSE '{}'::jsonb END);
    RETURN NULL;
  END IF;

  IF NEW.estado IS DISTINCT FROM OLD.estado THEN
    INSERT INTO mercadeo_evento_bitacora (evento_id, tipo_evento, detalle)
    VALUES (NEW.id, 'cambio_estado',
            jsonb_build_object('de', OLD.estado, 'a', NEW.estado)
            || CASE WHEN NEW.estado = 'rechazada' THEN jsonb_build_object('motivo', NEW.motivo_rechazo)
                    WHEN NEW.estado = 'cancelada' THEN jsonb_build_object('motivo', NEW.motivo_cancelacion)
                    ELSE '{}'::jsonb END);
  END IF;

  v_old := to_jsonb(OLD);
  v_new := to_jsonb(NEW);
  FOREACH v_col IN ARRAY v_cortas LOOP
    IF v_old->v_col IS DISTINCT FROM v_new->v_col THEN
      v_cambios := v_cambios || jsonb_build_object(v_col, jsonb_build_object('de', v_old->v_col, 'a', v_new->v_col));
    END IF;
  END LOOP;
  FOREACH v_col IN ARRAY v_largas LOOP
    IF v_old->v_col IS DISTINCT FROM v_new->v_col THEN
      v_cambios := v_cambios || jsonb_build_object(v_col, true);
    END IF;
  END LOOP;
  IF v_cambios <> '{}'::jsonb THEN
    INSERT INTO mercadeo_evento_bitacora (evento_id, tipo_evento, detalle)
    VALUES (NEW.id, 'cambio_datos', v_cambios);
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.mercadeo_eventos_bitacora() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.mercadeo_evento_brief(e public.mercadeo_eventos)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  c_obj  constant jsonb := '{"leads":"Generar nuevos leads (oportunidades de venta)","relacion_clientes":"Fortalecer la relación con clientes existentes","lanzamiento":"Lanzamiento o promoción de un nuevo producto/servicio","posicionamiento":"Posicionamiento de la marca/empresa","capacitacion":"Capacitación o educación","trafico_digital":"Aumentar el tráfico a nuestro sitio web o redes sociales","retencion":"Retención de clientes"}';
  c_can  constant jsonb := '{"email":"Email marketing (campañas de invitación)","redes":"Redes sociales (posts, historias, anuncios)","web":"Blog o sitio web (contenido, landing page)","relaciones_publicas":"Relaciones públicas (comunicados de prensa)","publicidad_digital":"Publicidad digital (Google Ads, LinkedIn Ads, etc.)","video":"Creación de videos promocionales"}';
  c_mat  constant jsonb := '{"banners_redes":"Banners para redes sociales","diseno_email":"Diseño de email","invitaciones":"Invitaciones digitales o impresas","presentacion":"Presentación de diapositivas","flyers":"Flyers o folletos","rollups":"Roll-ups o pendones","merchandising":"Diseño para materiales de merchandising"}';
  c_log  constant jsonb := '{"registros":"Apoyo en la gestión de registros (plataforma, base de datos)","coordinacion_logistica":"Coordinación con el área de logística para el evento","plataforma_virtual":"Apoyo en la configuración de la plataforma de evento virtual"}';
  v_txt text;

  -- "- etiqueta" por cada código marcado, más el texto de "Otros" si lo hay.
  v_seccion text;
BEGIN
  v_txt := 'Evento EV-' || e.id || ': ' || e.nombre || E'\n' ||
           'Empresa: ' || public.mercadeo_empresa_nombre(e.empresa, e.empresa_otra) || E'\n' ||
           'Solicitante: ' || e.solicitante_nombre ||
             CASE WHEN e.solicitante_area <> '' THEN ' (' || e.solicitante_area || ')' ELSE '' END || E'\n' ||
           'Fecha del evento: ' || to_char(e.fecha_evento, 'DD/MM/YYYY') ||
             CASE WHEN e.hora_inicio IS NOT NULL THEN ' · ' || to_char(e.hora_inicio, 'HH24:MI') ||
                    CASE WHEN e.hora_fin IS NOT NULL THEN '–' || to_char(e.hora_fin, 'HH24:MI') ELSE '' END
                  ELSE '' END || E'\n' ||
           'Modalidad: ' || CASE e.modalidad WHEN 'fisico' THEN 'Físico' WHEN 'virtual' THEN 'Virtual' ELSE 'Híbrido' END ||
             CASE WHEN e.lugar <> '' THEN ' · Lugar: ' || e.lugar ELSE '' END ||
             CASE WHEN e.plataforma <> '' THEN ' · Plataforma: ' || e.plataforma ELSE '' END || E'\n' ||
           'Asistentes esperados: ' || COALESCE(e.total_invitados::text, '—') || ' invitados' ||
             CASE WHEN e.asistentes_presencial IS NOT NULL THEN ' · ' || e.asistentes_presencial || ' presenciales' ELSE '' END ||
             CASE WHEN e.asistentes_virtual IS NOT NULL THEN ' · ' || e.asistentes_virtual || ' virtuales' ELSE '' END || E'\n' ||
           'Presupuesto: estimado $' || replace(to_char(e.presupuesto_estimado, 'FM999,999,999,999,999'), ',', '.') ||
             ' · solicitado a Mercadeo $' || replace(to_char(e.total_solicitado, 'FM999,999,999,999,999'), ',', '.') || E'\n\n' ||
           'Qué es / por qué se realiza: ' || e.descripcion;

  SELECT string_agg('- ' || COALESCE(c_can->>x, x), E'\n' ORDER BY ord) INTO v_seccion FROM unnest(e.canales) WITH ORDINALITY AS t(x, ord);
  IF v_seccion IS NOT NULL OR e.canales_otro <> '' THEN
    v_txt := v_txt || E'\n\nCanales de promoción solicitados:\n' || COALESCE(v_seccion, '') ||
             CASE WHEN e.canales_otro <> '' THEN E'\n- Otros: ' || e.canales_otro ELSE '' END;
  END IF;

  SELECT string_agg('- ' || COALESCE(c_mat->>x, x), E'\n' ORDER BY ord) INTO v_seccion FROM unnest(e.materiales) WITH ORDINALITY AS t(x, ord);
  IF v_seccion IS NOT NULL OR e.materiales_otro <> '' THEN
    v_txt := v_txt || E'\n\nMateriales gráficos y visuales:\n' || COALESCE(v_seccion, '') ||
             CASE WHEN e.materiales_otro <> '' THEN E'\n- Otros: ' || e.materiales_otro ELSE '' END;
  END IF;

  SELECT string_agg('- ' || COALESCE(c_log->>x, x), E'\n' ORDER BY ord) INTO v_seccion FROM unnest(e.logistica) WITH ORDINALITY AS t(x, ord);
  IF v_seccion IS NOT NULL OR e.logistica_otro <> '' THEN
    v_txt := v_txt || E'\n\nLogística y presencialidad:\n' || COALESCE(v_seccion, '') ||
             CASE WHEN e.logistica_otro <> '' THEN E'\n- Otros: ' || e.logistica_otro ELSE '' END;
  END IF;

  SELECT string_agg('- ' || COALESCE(c_obj->>x, x), E'\n' ORDER BY ord) INTO v_seccion FROM unnest(e.objetivos) WITH ORDINALITY AS t(x, ord);
  IF v_seccion IS NOT NULL OR e.objetivos_otro <> '' THEN
    v_txt := v_txt || E'\n\nObjetivos del evento:\n' || COALESCE(v_seccion, '') ||
             CASE WHEN e.objetivos_otro <> '' THEN E'\n- Otros: ' || e.objetivos_otro ELSE '' END;
  END IF;

  RETURN v_txt;
END;
$$;
REVOKE ALL ON FUNCTION public.mercadeo_evento_brief(public.mercadeo_eventos) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.mercadeo_eventos_tarea()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tarea_id bigint;
BEGIN
  IF NEW.estado = 'aprobada' AND OLD.estado IN ('radicada','en_revision') THEN
    PERFORM set_config('mercadeo.creando_tarea_evento', 'on', true);
    INSERT INTO mercadeo_tareas (titulo, descripcion, tipo, prioridad, urgente, empresas, fecha_limite, evento_id)
    VALUES (left('Evento EV-' || NEW.id || ': ' || NEW.nombre || ' · ' || public.mercadeo_empresa_nombre(NEW.empresa, NEW.empresa_otra), 200),
            public.mercadeo_evento_brief(NEW),
            'evento', 'soporte_ventas', false, ARRAY[NEW.empresa], NEW.fecha_evento - 1, NEW.id)
    RETURNING id INTO v_tarea_id;
    PERFORM set_config('mercadeo.creando_tarea_evento', 'off', true);
    INSERT INTO mercadeo_evento_bitacora (evento_id, tipo_evento, detalle)
    VALUES (NEW.id, 'tarea_creada', jsonb_build_object('tarea_id', v_tarea_id));
  ELSIF NEW.estado = 'cancelada' AND OLD.estado <> 'cancelada' THEN
    UPDATE mercadeo_tareas SET estado = 'cancelada'
     WHERE evento_id = NEW.id AND estado IN ('solicitada','confirmada','en_produccion','en_validacion');
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.mercadeo_eventos_tarea() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';

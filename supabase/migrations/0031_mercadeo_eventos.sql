-- ============================================================
-- Eventos de Mercadeo: solicitudes de eventos (formato MC-ISO-FO01, v1)
--
-- Dos puertas de entrada, una sola tabla:
--   - Mercadeo digita el formato (llegó por correo a creative@tecbihol.com) en panel/eventos.html.
--   - El comercial lo diligencia en panel-pedidos; tras la aprobación PREVIA allá, la Edge Function
--     `solicitud-evento-pedidos` (service_role + secreto compartido) lo crea aquí como 'radicada'.
--
-- Flujo (Manual de procesos y procedimiento de EVENTOS, jun-2026):
--   radicada -> en_revision -> aprobada -> en_preparacion -> realizada -> cerrada
--   (+ rechazada, solo antes de aprobar; + cancelada, mientras no esté cerrada).
--   rechazada / cancelada / cerrada son estados FINALES.
--   El Líder de Mercadeo evalúa en <= 48 h hábiles; el comercial entrega la base de datos de
--   asistentes en <= 3 días hábiles tras el evento (por eso 'cerrada' exige esa entrega o "no aplica").
--
-- Política de anticipación (15 días): NO bloquea. Las columnas generadas dias_anticipacion y
-- extemporanea (fecha_evento - fecha_radicacion < 15) la marcan y alimentan el KPI "Oportunidad
-- en la solicitud"; el Líder decide. fecha_radicacion es la fecha en que LLEGÓ la solicitud: por
-- defecto hoy, editable por Mercadeo al digitar (queda en la bitácora) y sellada por el puente
-- cuando viene de Pedidos.
--
-- Al APROBAR se crea sola una tarea tipo Evento en el Tablero (mercadeo_tareas.evento_id, clase
-- "soporte a ventas", fecha límite = día anterior al evento, brief armado desde el formato). Al
-- CANCELAR el evento se cancela su tarea si sigue abierta.
--
-- Todo lo que el navegador no debe falsificar lo sella el servidor: consecutivo, quién/cuándo
-- aprobó, rechazó, canceló, realizó y cerró; origen; la bitácora de sistema.
--
-- Permiso: el del módulo 'mercadeo' (user_has_module_pqrs); borrar solo admin.
--
-- Requiere 0012-0030. Idempotente. Aplicar con apply_migration (MCP) ANTES de desplegar la
-- Edge Function y de publicar el frontend.
-- ============================================================

-- ── 1. Eventos ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mercadeo_eventos (
  id                         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,   -- N° visible: EV-<id>
  estado                     text NOT NULL DEFAULT 'radicada'
                               CHECK (estado IN ('radicada','en_revision','aprobada','en_preparacion','realizada','cerrada','rechazada','cancelada')),
  empresa                    text NOT NULL CHECK (empresa IN ('PARCELAR','GREEN','RESO','IASO','IAS')),

  -- Origen (solo el puente fija 'panel_pedidos'; inmutable después)
  origen                     text NOT NULL DEFAULT 'panel_mercadeo' CHECK (origen IN ('panel_mercadeo','panel_pedidos')),
  origen_ref                 uuid,           -- request_id del formulario de Pedidos (idempotencia)
  origen_numero              integer,        -- N° en Pedidos (SE-<n>)
  enviado_por_id             text,           -- usuario de Pedidos que envió la solicitud
  enviado_por_nombre         text,
  aprobada_origen_por_nombre text,           -- aprobador previo en Pedidos
  aprobada_origen_en         timestamptz,
  fecha_radicacion           date NOT NULL DEFAULT ((now() AT TIME ZONE 'America/Bogota')::date),

  -- 1. Información general del solicitante
  solicitante_id             text,           -- usuario de Pedidos a nombre de quien se hace (si lo es)
  solicitante_nombre         text NOT NULL CHECK (char_length(btrim(solicitante_nombre)) BETWEEN 2 AND 120),
  solicitante_area           text NOT NULL DEFAULT '' CHECK (char_length(solicitante_area) <= 120),
  solicitante_correo         text NOT NULL DEFAULT '' CHECK (char_length(solicitante_correo) <= 160),
  solicitante_telefono       text NOT NULL DEFAULT '' CHECK (char_length(solicitante_telefono) <= 40),
  fecha_limite_aprobacion    date,           -- fecha en que necesita la respuesta de Mercadeo

  -- 2. Detalles del evento
  nombre                     text NOT NULL CHECK (char_length(btrim(nombre)) BETWEEN 3 AND 200),
  descripcion                text NOT NULL CHECK (char_length(btrim(descripcion)) BETWEEN 10 AND 2000),
  fecha_evento               date NOT NULL,
  hora_inicio                time,
  hora_fin                   time,
  modalidad                  text NOT NULL CHECK (modalidad IN ('fisico','virtual','hibrido')),
  lugar                      text NOT NULL DEFAULT '' CHECK (char_length(lugar) <= 300),
  plataforma                 text NOT NULL DEFAULT '' CHECK (char_length(plataforma) <= 200),

  -- 3. Objetivos y público
  objetivos                  text[] NOT NULL DEFAULT '{}'
                               CHECK (objetivos <@ ARRAY['leads','relacion_clientes','lanzamiento','posicionamiento','capacitacion','trafico_digital','retencion']::text[]),
  objetivos_otro             text NOT NULL DEFAULT '' CHECK (char_length(objetivos_otro) <= 300),
  publico_objetivo           text NOT NULL DEFAULT '' CHECK (char_length(publico_objetivo) <= 500),
  segmento_demografico       text NOT NULL DEFAULT '' CHECK (char_length(segmento_demografico) <= 500),
  segmento_profesional       text NOT NULL DEFAULT '' CHECK (char_length(segmento_profesional) <= 500),
  nivel_conocimiento         text NOT NULL DEFAULT '' CHECK (char_length(nivel_conocimiento) <= 300),
  total_invitados            integer CHECK (total_invitados IS NULL OR total_invitados BETWEEN 0 AND 100000),
  asistentes_presencial      integer CHECK (asistentes_presencial IS NULL OR asistentes_presencial BETWEEN 0 AND 100000),
  asistentes_virtual         integer CHECK (asistentes_virtual IS NULL OR asistentes_virtual BETWEEN 0 AND 100000),

  -- 4. Requerimientos específicos de Mercadeo
  canales                    text[] NOT NULL DEFAULT '{}'
                               CHECK (canales <@ ARRAY['email','redes','web','relaciones_publicas','publicidad_digital','video']::text[]),
  canales_otro               text NOT NULL DEFAULT '' CHECK (char_length(canales_otro) <= 300),
  materiales                 text[] NOT NULL DEFAULT '{}'
                               CHECK (materiales <@ ARRAY['banners_redes','diseno_email','invitaciones','presentacion','flyers','rollups','merchandising']::text[]),
  materiales_otro            text NOT NULL DEFAULT '' CHECK (char_length(materiales_otro) <= 300),
  logistica                  text[] NOT NULL DEFAULT '{}'
                               CHECK (logistica <@ ARRAY['registros','coordinacion_logistica','plataforma_virtual']::text[]),
  logistica_otro             text NOT NULL DEFAULT '' CHECK (char_length(logistica_otro) <= 300),

  -- 5. Presupuesto
  presupuesto_estimado       numeric NOT NULL DEFAULT 0 CHECK (presupuesto_estimado BETWEEN 0 AND 100000000000),
  total_solicitado           numeric NOT NULL DEFAULT 0 CHECK (total_solicitado BETWEEN 0 AND 100000000000),
  desglose_gastos            jsonb NOT NULL DEFAULT '[]'::jsonb
                               CHECK (jsonb_typeof(desglose_gastos) = 'array' AND jsonb_array_length(desglose_gastos) <= 30),

  -- 6. Aprobación y seguimiento (los sella el servidor)
  respondida_en              timestamptz,    -- primera respuesta de Mercadeo (KPI de 48 h hábiles)
  aprobado_por               uuid,
  aprobado_por_nombre        text,
  aprobado_en                timestamptz,
  motivo_rechazo             text,
  rechazado_por_nombre       text,
  rechazado_en               timestamptz,
  motivo_cancelacion         text,
  cancelado_por_nombre       text,
  cancelado_en               timestamptz,
  realizado_en               timestamptz,
  bd_asistentes_fecha        date,           -- cuándo llegó la base de datos de asistentes
  bd_no_aplica               boolean NOT NULL DEFAULT false,
  cerrado_en                 timestamptz,

  creado_por                 uuid,
  creado_por_nombre          text,
  creado_en                  timestamptz,
  modificado_por             uuid,
  modificado_por_nombre      text,
  modificado_en              timestamptz,

  -- KPI "Oportunidad en la solicitud": anticipación en días calendario.
  dias_anticipacion          integer GENERATED ALWAYS AS (fecha_evento - fecha_radicacion) STORED,
  extemporanea               boolean GENERATED ALWAYS AS ((fecha_evento - fecha_radicacion) < 15) STORED,

  CONSTRAINT mercadeo_eventos_horas_check CHECK (hora_inicio IS NULL OR hora_fin IS NULL OR hora_fin > hora_inicio),
  CONSTRAINT mercadeo_eventos_fecha_check CHECK (fecha_evento >= fecha_radicacion),
  CONSTRAINT mercadeo_eventos_limite_check CHECK (fecha_limite_aprobacion IS NULL OR fecha_limite_aprobacion <= fecha_evento),
  CONSTRAINT mercadeo_eventos_pedidos_check CHECK (origen = 'panel_mercadeo' OR (
    origen_ref IS NOT NULL AND origen_numero IS NOT NULL AND enviado_por_id IS NOT NULL
    AND btrim(COALESCE(enviado_por_nombre, '')) <> '' AND btrim(COALESCE(aprobada_origen_por_nombre, '')) <> ''))
);

-- Una solicitud de Pedidos vigente por origen_ref (la rechazada o retirada no cuenta: se corrige y
-- reenvía, y llega un evento NUEVO con el mismo origen_ref).
CREATE UNIQUE INDEX IF NOT EXISTS mercadeo_eventos_origen_ref_uk
  ON public.mercadeo_eventos (origen_ref) WHERE origen_ref IS NOT NULL AND estado NOT IN ('rechazada','cancelada');
CREATE INDEX IF NOT EXISTS mercadeo_eventos_estado ON public.mercadeo_eventos (estado);
CREATE INDEX IF NOT EXISTS mercadeo_eventos_fecha_evento ON public.mercadeo_eventos (fecha_evento);
CREATE INDEX IF NOT EXISTS mercadeo_eventos_solicitante ON public.mercadeo_eventos (solicitante_id) WHERE solicitante_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mercadeo_eventos_enviado_por ON public.mercadeo_eventos (enviado_por_id) WHERE enviado_por_id IS NOT NULL;

COMMENT ON TABLE public.mercadeo_eventos IS
  'Solicitudes de eventos (formato MC-ISO-FO01). Flujo radicada -> en_revision -> aprobada -> en_preparacion -> realizada -> cerrada (+ rechazada/cancelada). Las reglas y los sellos los aplica el servidor.';
COMMENT ON COLUMN public.mercadeo_eventos.fecha_radicacion IS
  'Fecha en que llegó la solicitud a Mercadeo (base de la política de 15 días de anticipación).';
COMMENT ON COLUMN public.mercadeo_eventos.extemporanea IS
  'true si el evento se pidió con menos de 15 días de anticipación (solo advertencia: no bloquea).';

-- ── 2. Tareas del Tablero ligadas al evento ──────────────────
ALTER TABLE public.mercadeo_tareas
  ADD COLUMN IF NOT EXISTS evento_id bigint REFERENCES public.mercadeo_eventos(id) ON DELETE SET NULL;
-- Una tarea por evento.
CREATE UNIQUE INDEX IF NOT EXISTS mercadeo_tareas_evento_uk ON public.mercadeo_tareas (evento_id) WHERE evento_id IS NOT NULL;

-- evento_id solo lo fija el trigger de aprobación del evento (no el navegador) y no cambia después.
CREATE OR REPLACE FUNCTION public.mercadeo_tareas_evento_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.evento_id IS NOT NULL AND COALESCE(current_setting('mercadeo.creando_tarea_evento', true), '') <> 'on' THEN
      NEW.evento_id := NULL;
    END IF;
  ELSIF NEW.evento_id IS NOT NULL THEN
    -- Nadie lo reasigna a otro evento. (Solo puede quedar en NULL: la FK ON DELETE SET NULL lo necesita.)
    NEW.evento_id := OLD.evento_id;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.mercadeo_tareas_evento_id() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_evento_id ON public.mercadeo_tareas;
CREATE TRIGGER trg_evento_id
  BEFORE INSERT OR UPDATE ON public.mercadeo_tareas
  FOR EACH ROW EXECUTE FUNCTION public.mercadeo_tareas_evento_id();

-- ── 3. Bitácora y adjuntos del evento ────────────────────────
CREATE TABLE IF NOT EXISTS public.mercadeo_evento_bitacora (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  evento_id      bigint NOT NULL REFERENCES public.mercadeo_eventos(id) ON DELETE CASCADE,
  tipo_evento    text NOT NULL CHECK (tipo_evento IN
    ('creacion','cambio_estado','cambio_datos','comentario','respuesta_solicitante','observacion_solicitante',
     'adjunto_agregado','adjunto_eliminado','tarea_creada')),
  usuario_id     uuid,
  usuario_nombre text,
  detalle        jsonb,
  creado_en      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mercadeo_evento_bitacora_texto_check CHECK (
    tipo_evento NOT IN ('comentario','respuesta_solicitante')
    OR char_length(btrim(COALESCE(detalle->>'texto', ''))) BETWEEN 1 AND 2000),
  CONSTRAINT mercadeo_evento_bitacora_obs_check CHECK (
    tipo_evento <> 'observacion_solicitante'
    OR char_length(btrim(COALESCE(detalle->>'texto', ''))) BETWEEN 5 AND 1000)
);
CREATE INDEX IF NOT EXISTS mercadeo_evento_bitacora_evento ON public.mercadeo_evento_bitacora (evento_id);

-- Autor y hora siempre del servidor; sin sesión (puente), el solicitante si el evento lo declara.
CREATE OR REPLACE FUNCTION public.mercadeo_evento_bitacora_antes()
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
REVOKE ALL ON FUNCTION public.mercadeo_evento_bitacora_antes() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_bitacora_antes ON public.mercadeo_evento_bitacora;
CREATE TRIGGER trg_bitacora_antes
  BEFORE INSERT ON public.mercadeo_evento_bitacora
  FOR EACH ROW EXECUTE FUNCTION public.mercadeo_evento_bitacora_antes();

CREATE TABLE IF NOT EXISTS public.mercadeo_evento_adjuntos (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  evento_id         bigint NOT NULL REFERENCES public.mercadeo_eventos(id) ON DELETE CASCADE,
  storage_path      text NOT NULL,
  nombre_original   text,
  tipo_mime         text,
  tamano_bytes      bigint,
  subido_por        uuid REFERENCES public.usuarios_pqrs(id),
  subido_por_nombre text,                   -- adjuntos del solicitante de Pedidos (sin cuenta aquí)
  creado_en         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mercadeo_evento_adjuntos_evento ON public.mercadeo_evento_adjuntos (evento_id);
CREATE INDEX IF NOT EXISTS mercadeo_evento_adjuntos_subido_por ON public.mercadeo_evento_adjuntos (subido_por);

CREATE OR REPLACE FUNCTION public.mercadeo_evento_adjuntos_bitacora()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO mercadeo_evento_bitacora (evento_id, tipo_evento, detalle)
    VALUES (NEW.evento_id, 'adjunto_agregado',
            jsonb_build_object('nombre', NEW.nombre_original)
            || CASE WHEN NEW.subido_por IS NULL AND NEW.subido_por_nombre IS NOT NULL
                    THEN jsonb_build_object('solicitante_nombre', NEW.subido_por_nombre)
                    ELSE '{}'::jsonb END);
  ELSIF EXISTS (SELECT 1 FROM mercadeo_eventos WHERE id = OLD.evento_id) THEN
    -- Si el evento se está borrando (cascada) no se registra: la bitácora también se borra.
    INSERT INTO mercadeo_evento_bitacora (evento_id, tipo_evento, detalle)
    VALUES (OLD.evento_id, 'adjunto_eliminado', jsonb_build_object('nombre', OLD.nombre_original));
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.mercadeo_evento_adjuntos_bitacora() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_adjuntos_bitacora ON public.mercadeo_evento_adjuntos;
CREATE TRIGGER trg_adjuntos_bitacora
  AFTER INSERT OR DELETE ON public.mercadeo_evento_adjuntos
  FOR EACH ROW EXECUTE FUNCTION public.mercadeo_evento_adjuntos_bitacora();

-- ── 4. Origen: solo el puente lo fija; inmutable después ─────
-- Dispara DESPUÉS de trg_auditoria (orden alfabético) para poner el nombre de quien envió
-- en lugar de "Sistema", y antes de trg_reglas.
CREATE OR REPLACE FUNCTION public.mercadeo_eventos_origen()
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
        RAISE EXCEPTION 'Las solicitudes de evento de origen panel_pedidos solo las registra el puente de Pedidos';
      END IF;
      NEW.creado_por_nombre := NEW.enviado_por_nombre;
      NEW.modificado_por_nombre := NEW.enviado_por_nombre;
    ELSE
      -- Evento digitado en el panel: nunca lleva datos de origen externo.
      NEW.origen_ref := NULL;
      NEW.origen_numero := NULL;
      NEW.enviado_por_id := NULL;
      NEW.enviado_por_nombre := NULL;
      NEW.aprobada_origen_por_nombre := NULL;
      NEW.aprobada_origen_en := NULL;
      NEW.solicitante_id := NULL;
    END IF;
  ELSE
    NEW.origen := OLD.origen;
    NEW.origen_ref := OLD.origen_ref;
    NEW.origen_numero := OLD.origen_numero;
    NEW.enviado_por_id := OLD.enviado_por_id;
    NEW.enviado_por_nombre := OLD.enviado_por_nombre;
    NEW.aprobada_origen_por_nombre := OLD.aprobada_origen_por_nombre;
    NEW.aprobada_origen_en := OLD.aprobada_origen_en;
    NEW.solicitante_id := OLD.solicitante_id;
    -- La fecha en que llegó una solicitud de Pedidos la fija el puente; la de un evento digitado, Mercadeo.
    IF OLD.origen = 'panel_pedidos' THEN NEW.fecha_radicacion := OLD.fecha_radicacion; END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.mercadeo_eventos_origen() FROM PUBLIC, anon, authenticated;

-- ── 5. Reglas del flujo y sellos del servidor ────────────────
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

DROP TRIGGER IF EXISTS trg_auditoria ON public.mercadeo_eventos;
CREATE TRIGGER trg_auditoria
  BEFORE INSERT OR UPDATE ON public.mercadeo_eventos
  FOR EACH ROW EXECUTE FUNCTION public.mercadeo_set_auditoria();

DROP TRIGGER IF EXISTS trg_origen ON public.mercadeo_eventos;
CREATE TRIGGER trg_origen
  BEFORE INSERT OR UPDATE ON public.mercadeo_eventos
  FOR EACH ROW EXECUTE FUNCTION public.mercadeo_eventos_origen();

DROP TRIGGER IF EXISTS trg_reglas ON public.mercadeo_eventos;
CREATE TRIGGER trg_reglas
  BEFORE INSERT OR UPDATE ON public.mercadeo_eventos
  FOR EACH ROW EXECUTE FUNCTION public.mercadeo_eventos_reglas();

-- ── 6. Bitácora de sistema del evento ────────────────────────
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
    'empresa','nombre','solicitante_nombre','solicitante_area','solicitante_correo','solicitante_telefono',
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

DROP TRIGGER IF EXISTS trg_bitacora ON public.mercadeo_eventos;
CREATE TRIGGER trg_bitacora
  AFTER INSERT OR UPDATE ON public.mercadeo_eventos
  FOR EACH ROW EXECUTE FUNCTION public.mercadeo_eventos_bitacora();

-- ── 7. Tarea del Tablero: se crea al aprobar, se cancela al cancelar ──
-- Brief con lo que el formato pide a Mercadeo (para que la tarjeta se entienda sin abrir el evento).
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
           'Empresa: ' || e.empresa || E'\n' ||
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
    VALUES (left('Evento EV-' || NEW.id || ': ' || NEW.nombre || ' · ' || NEW.empresa, 200),
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

DROP TRIGGER IF EXISTS trg_tarea ON public.mercadeo_eventos;
CREATE TRIGGER trg_tarea
  AFTER UPDATE ON public.mercadeo_eventos
  FOR EACH ROW EXECUTE FUNCTION public.mercadeo_eventos_tarea();

-- ── 8. Avisos (campanita) del equipo ─────────────────────────
ALTER TABLE public.mercadeo_notificaciones
  ADD COLUMN IF NOT EXISTS evento_id bigint REFERENCES public.mercadeo_eventos(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS mercadeo_notif_evento ON public.mercadeo_notificaciones (evento_id);

ALTER TABLE public.mercadeo_notificaciones DROP CONSTRAINT IF EXISTS mercadeo_notificaciones_tipo_check;
ALTER TABLE public.mercadeo_notificaciones ADD CONSTRAINT mercadeo_notificaciones_tipo_check
  CHECK (tipo IN ('solicitud_aprobada','solicitud_modificada','observacion_solicitante',
                  'evento_recibido','evento_retirado','evento_observacion'));

-- Llega un evento aprobado en Pedidos.
CREATE OR REPLACE FUNCTION public.mercadeo_eventos_notificar_nuevo()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO mercadeo_notificaciones (para_usuario_id, tipo, evento_id, titulo, mensaje)
  SELECT u.id, 'evento_recibido', NEW.id,
         '🎪 Nueva solicitud de evento desde Pedidos: EV-' || NEW.id,
         NEW.solicitante_nombre || ' pide: ' || NEW.nombre || ' (' || to_char(NEW.fecha_evento, 'DD/MM/YYYY') || ')' ||
           CASE WHEN NEW.extemporanea THEN ' · ⚠ con ' || NEW.dias_anticipacion || ' días de anticipación' ELSE '' END ||
           ' · aprobada por ' || NEW.aprobada_origen_por_nombre
  FROM usuarios_pqrs u
  WHERE u.activo = true AND (u.rol = 'admin' OR 'mercadeo' = ANY (u.modulos));
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.mercadeo_eventos_notificar_nuevo() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_notificar_nuevo ON public.mercadeo_eventos;
CREATE TRIGGER trg_notificar_nuevo
  AFTER INSERT ON public.mercadeo_eventos
  FOR EACH ROW WHEN (NEW.origen = 'panel_pedidos')
  EXECUTE FUNCTION public.mercadeo_eventos_notificar_nuevo();

-- El solicitante modificó su solicitud y la retiró del módulo (solo el puente cancela sin sesión).
CREATE OR REPLACE FUNCTION public.mercadeo_eventos_notificar_retiro()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL THEN RETURN NULL; END IF;
  INSERT INTO mercadeo_notificaciones (para_usuario_id, tipo, evento_id, titulo, mensaje)
  SELECT u.id, 'evento_retirado', NEW.id,
         '↩ Solicitud de evento retirada: EV-' || NEW.id || ' (estaba en ' ||
           CASE OLD.estado WHEN 'radicada' THEN 'Radicada' ELSE 'En revisión' END || ')',
         NEW.motivo_cancelacion
  FROM usuarios_pqrs u
  WHERE u.activo = true AND (u.rol = 'admin' OR 'mercadeo' = ANY (u.modulos));
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.mercadeo_eventos_notificar_retiro() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_notificar_retiro ON public.mercadeo_eventos;
CREATE TRIGGER trg_notificar_retiro
  AFTER UPDATE ON public.mercadeo_eventos
  FOR EACH ROW WHEN (NEW.origen = 'panel_pedidos' AND OLD.estado <> 'cancelada' AND NEW.estado = 'cancelada')
  EXECUTE FUNCTION public.mercadeo_eventos_notificar_retiro();

-- Observación del solicitante (la escribe el puente en la bitácora).
CREATE OR REPLACE FUNCTION public.mercadeo_eventos_notificar_observacion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_quien text := CASE WHEN NEW.detalle->>'como' = 'aprobador' THEN 'del aprobador' ELSE 'del solicitante' END;
  v_texto text := btrim(NEW.detalle->>'texto');
BEGIN
  INSERT INTO mercadeo_notificaciones (para_usuario_id, tipo, evento_id, titulo, mensaje)
  SELECT u.id, 'evento_observacion', NEW.evento_id,
         '💬 Observación ' || v_quien || ' en el evento EV-' || NEW.evento_id,
         COALESCE(NEW.usuario_nombre, 'Sistema') || ': ' ||
           CASE WHEN char_length(v_texto) > 240 THEN left(v_texto, 237) || '…' ELSE v_texto END
  FROM usuarios_pqrs u
  WHERE u.activo = true AND (u.rol = 'admin' OR 'mercadeo' = ANY (u.modulos));
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.mercadeo_eventos_notificar_observacion() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_notificar_observacion ON public.mercadeo_evento_bitacora;
CREATE TRIGGER trg_notificar_observacion
  AFTER INSERT ON public.mercadeo_evento_bitacora
  FOR EACH ROW WHEN (NEW.tipo_evento = 'observacion_solicitante')
  EXECUTE FUNCTION public.mercadeo_eventos_notificar_observacion();

-- ── 9. RLS ───────────────────────────────────────────────────
ALTER TABLE public.mercadeo_eventos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mercadeo_evento_bitacora ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mercadeo_evento_adjuntos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mercadeo_eventos FROM anon;
REVOKE ALL ON public.mercadeo_evento_bitacora FROM anon;
REVOKE ALL ON public.mercadeo_evento_adjuntos FROM anon;

-- Eventos: el módulo lee/crea/edita; borrar solo admin (se cancelan; conservan evidencia para los KPI).
DROP POLICY IF EXISTS "mercadeo_eventos_select" ON public.mercadeo_eventos;
CREATE POLICY "mercadeo_eventos_select" ON public.mercadeo_eventos FOR SELECT TO authenticated
  USING ((select public.user_has_module_pqrs('mercadeo')));
DROP POLICY IF EXISTS "mercadeo_eventos_insert" ON public.mercadeo_eventos;
CREATE POLICY "mercadeo_eventos_insert" ON public.mercadeo_eventos FOR INSERT TO authenticated
  WITH CHECK ((select public.user_has_module_pqrs('mercadeo')));
DROP POLICY IF EXISTS "mercadeo_eventos_update" ON public.mercadeo_eventos;
CREATE POLICY "mercadeo_eventos_update" ON public.mercadeo_eventos FOR UPDATE TO authenticated
  USING ((select public.user_has_module_pqrs('mercadeo')))
  WITH CHECK ((select public.user_has_module_pqrs('mercadeo')));
DROP POLICY IF EXISTS "mercadeo_eventos_delete" ON public.mercadeo_eventos;
CREATE POLICY "mercadeo_eventos_delete" ON public.mercadeo_eventos FOR DELETE TO authenticated
  USING ((select public.get_user_role_pqrs()) = 'admin');

-- Bitácora: el módulo lee; el cliente solo inserta comentarios (y respuestas al solicitante, solo en eventos de Pedidos).
DROP POLICY IF EXISTS "mercadeo_evento_bitacora_select" ON public.mercadeo_evento_bitacora;
CREATE POLICY "mercadeo_evento_bitacora_select" ON public.mercadeo_evento_bitacora FOR SELECT TO authenticated
  USING ((select public.user_has_module_pqrs('mercadeo')));
DROP POLICY IF EXISTS "mercadeo_evento_bitacora_insert" ON public.mercadeo_evento_bitacora;
CREATE POLICY "mercadeo_evento_bitacora_insert" ON public.mercadeo_evento_bitacora FOR INSERT TO authenticated
  WITH CHECK (
    (select public.user_has_module_pqrs('mercadeo'))
    AND (
      tipo_evento = 'comentario'
      OR (tipo_evento = 'respuesta_solicitante'
          AND EXISTS (SELECT 1 FROM public.mercadeo_eventos e WHERE e.id = evento_id AND e.origen = 'panel_pedidos'))
    )
  );

-- Adjuntos: el módulo lee, sube (como sí mismo) y borra. Mismo bucket privado que el Tablero.
DROP POLICY IF EXISTS "mercadeo_evento_adjuntos_select" ON public.mercadeo_evento_adjuntos;
CREATE POLICY "mercadeo_evento_adjuntos_select" ON public.mercadeo_evento_adjuntos FOR SELECT TO authenticated
  USING ((select public.user_has_module_pqrs('mercadeo')));
DROP POLICY IF EXISTS "mercadeo_evento_adjuntos_insert" ON public.mercadeo_evento_adjuntos;
CREATE POLICY "mercadeo_evento_adjuntos_insert" ON public.mercadeo_evento_adjuntos FOR INSERT TO authenticated
  WITH CHECK ((select public.user_has_module_pqrs('mercadeo')) AND subido_por = (select auth.uid()));
DROP POLICY IF EXISTS "mercadeo_evento_adjuntos_delete" ON public.mercadeo_evento_adjuntos;
CREATE POLICY "mercadeo_evento_adjuntos_delete" ON public.mercadeo_evento_adjuntos FOR DELETE TO authenticated
  USING ((select public.user_has_module_pqrs('mercadeo')));

-- ── 10. Realtime: la lista se actualiza sola entre las personas del equipo ──
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                  WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'mercadeo_eventos') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.mercadeo_eventos;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

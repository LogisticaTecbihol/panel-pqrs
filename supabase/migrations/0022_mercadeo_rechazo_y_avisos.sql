-- ============================================================
-- Mercadeo puede RECHAZAR una solicitud de Pedidos (con motivo) y el equipo recibe
-- AVISOS (campanita) cuando llega una solicitud aprobada.
--
-- 1. Estado nuevo 'rechazada' (fuera de las columnas, como 'cancelada'), con
--    motivo_rechazo / rechazada_por_nombre / rechazada_en. Reglas en un trigger propio
--    (trg_rechazo): solo tareas que llegaron de Pedidos, solo mientras no estén
--    entregadas/canceladas, motivo obligatorio (3+ caracteres), quién y cuándo los pone
--    el servidor, y es un estado FINAL (no se reabre).
-- 2. Una solicitud rechazada se puede corregir y reenviar desde Pedidos: al aprobarse
--    de nuevo llega como tarea NUEVA con el mismo origen_ref; por eso la unicidad de
--    origen_ref pasa a ser parcial (no cuenta las rechazadas).
-- 3. mercadeo_tareas_reglas: 'rechazada' queda exenta de "sin brief no hay fecha"
--    (igual que 'cancelada'). Se parte de la versión de PRODUCCIÓN (que ya traía el
--    ajuste de 'cancelada' que no estaba en el repo).
-- 4. Bitácora: el cambio de estado a 'rechazada' lleva el motivo.
-- 5. Tabla mercadeo_notificaciones + trigger: cuando entra una tarea de origen
--    'panel_pedidos' se avisa a cada usuario activo con acceso a Mercadeo (admin o
--    módulo 'mercadeo'). Cada quien solo lee y marca leídas las suyas.
--
-- Requiere 0012-0021. Idempotente. Aplicar con apply_migration (MCP) ANTES de
-- redesplegar las funciones y publicar el frontend.
-- ============================================================

-- ── 1. Estado 'rechazada' y sus datos ────────────────────────
ALTER TABLE public.mercadeo_tareas DROP CONSTRAINT IF EXISTS mercadeo_tareas_estado_check;
ALTER TABLE public.mercadeo_tareas ADD CONSTRAINT mercadeo_tareas_estado_check
  CHECK (estado IN ('solicitada','confirmada','en_produccion','en_validacion','entregada','cancelada','rechazada'));

ALTER TABLE public.mercadeo_tareas
  ADD COLUMN IF NOT EXISTS motivo_rechazo       text,
  ADD COLUMN IF NOT EXISTS rechazada_por_nombre text,
  ADD COLUMN IF NOT EXISTS rechazada_en         timestamptz;

COMMENT ON COLUMN public.mercadeo_tareas.motivo_rechazo IS
  'Motivo con el que Mercadeo rechazó una solicitud de Pedidos (estado rechazada).';

-- ── 2. Unicidad de origen_ref sin contar las rechazadas ──────
DROP INDEX IF EXISTS public.mercadeo_tareas_origen_ref_uk;
CREATE UNIQUE INDEX IF NOT EXISTS mercadeo_tareas_origen_ref_uk
  ON public.mercadeo_tareas (origen_ref)
  WHERE origen_ref IS NOT NULL AND estado <> 'rechazada';

-- ── 3. Reglas del rechazo (trigger propio) ───────────────────
CREATE OR REPLACE FUNCTION public.mercadeo_tareas_rechazo()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_nombre text;
BEGIN
  IF OLD.estado = 'rechazada' THEN
    -- Estado final: no se reabre ni se reescribe el rechazo.
    NEW.estado := 'rechazada';
    NEW.motivo_rechazo := OLD.motivo_rechazo;
    NEW.rechazada_por_nombre := OLD.rechazada_por_nombre;
    NEW.rechazada_en := OLD.rechazada_en;
  ELSIF NEW.estado = 'rechazada' THEN
    IF OLD.origen <> 'panel_pedidos' THEN
      RAISE EXCEPTION 'Solo se rechazan solicitudes que llegan de Pedidos; una tarea propia se cancela';
    END IF;
    IF OLD.estado NOT IN ('solicitada','confirmada','en_produccion','en_validacion') THEN
      RAISE EXCEPTION 'Una solicitud entregada o cancelada ya no se puede rechazar';
    END IF;
    IF char_length(btrim(COALESCE(NEW.motivo_rechazo, ''))) < 3 THEN
      RAISE EXCEPTION 'Escribe el motivo del rechazo (mínimo 3 caracteres)';
    END IF;
    IF char_length(btrim(NEW.motivo_rechazo)) > 500 THEN
      RAISE EXCEPTION 'El motivo del rechazo no puede superar 500 caracteres';
    END IF;
    SELECT COALESCE(NULLIF(nombre, ''), email) INTO v_nombre FROM usuarios_pqrs WHERE id = auth.uid();
    NEW.motivo_rechazo := btrim(NEW.motivo_rechazo);
    NEW.rechazada_por_nombre := COALESCE(v_nombre, 'Sistema');
    NEW.rechazada_en := now();
  ELSE
    -- Sin rechazo: estos datos no se tocan desde el cliente.
    NEW.motivo_rechazo := OLD.motivo_rechazo;
    NEW.rechazada_por_nombre := OLD.rechazada_por_nombre;
    NEW.rechazada_en := OLD.rechazada_en;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.mercadeo_tareas_rechazo() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_rechazo ON public.mercadeo_tareas;
CREATE TRIGGER trg_rechazo
  BEFORE UPDATE ON public.mercadeo_tareas
  FOR EACH ROW EXECUTE FUNCTION public.mercadeo_tareas_rechazo();

-- ── 4. mercadeo_tareas_reglas (versión de producción + 'rechazada' exenta) ──
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
      NEW.aval_por := NULL;
      NEW.aval_referencia := '';
      NEW.aval_motivo := '';
      NEW.aval_registrado_por := NULL;
      NEW.aval_registrado_por_nombre := NULL;
      NEW.aval_registrado_en := NULL;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.estado = 'solicitada' AND NEW.estado NOT IN ('solicitada','cancelada','rechazada') THEN
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

-- ── 5. Bitácora: el cambio a 'rechazada' lleva el motivo ─────
-- (misma función de 0019 + motivo en el evento cambio_estado)
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
    VALUES (NEW.id, 'creacion',
            jsonb_build_object('titulo', NEW.titulo, 'estado', NEW.estado)
            || CASE WHEN NEW.origen = 'panel_pedidos'
                    THEN jsonb_build_object('origen', 'panel_pedidos',
                                            'solicitante_nombre', NEW.solicitante_nombre,
                                            'a_nombre_de', NEW.a_nombre_de_nombre,
                                            'asunto', NEW.asunto)
                    ELSE '{}'::jsonb END);
    IF NEW.aval_registrado_en IS NOT NULL THEN
      INSERT INTO mercadeo_tarea_bitacora (tarea_id, tipo_evento, detalle)
      VALUES (NEW.id, 'aval_registrado', jsonb_build_object('por', NEW.aval_por, 'referencia', NEW.aval_referencia, 'motivo', NEW.aval_motivo));
    END IF;
    RETURN NULL;
  END IF;

  IF NEW.estado IS DISTINCT FROM OLD.estado THEN
    INSERT INTO mercadeo_tarea_bitacora (tarea_id, tipo_evento, detalle)
    VALUES (NEW.id, 'cambio_estado',
            jsonb_build_object('de', OLD.estado, 'a', NEW.estado)
            || CASE WHEN NEW.estado = 'rechazada'
                    THEN jsonb_build_object('motivo', NEW.motivo_rechazo)
                    ELSE '{}'::jsonb END);
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

-- ── 6. Avisos (campanita) del equipo de Mercadeo ─────────────
CREATE TABLE IF NOT EXISTS public.mercadeo_notificaciones (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  para_usuario_id uuid        NOT NULL REFERENCES public.usuarios_pqrs(id) ON DELETE CASCADE,
  tipo            text        NOT NULL CHECK (tipo IN ('solicitud_aprobada')),
  tarea_id        bigint      REFERENCES public.mercadeo_tareas(id) ON DELETE CASCADE,
  titulo          text        NOT NULL,
  mensaje         text,
  leida           boolean     NOT NULL DEFAULT false,
  leida_en        timestamptz,
  creado_en       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mercadeo_notif_usuario
  ON public.mercadeo_notificaciones (para_usuario_id, leida, creado_en DESC);
CREATE INDEX IF NOT EXISTS mercadeo_notif_tarea
  ON public.mercadeo_notificaciones (tarea_id);

ALTER TABLE public.mercadeo_notificaciones ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mercadeo_notificaciones FROM anon, authenticated;
-- Cada quien lee las suyas y solo puede marcarlas leídas; las crea el servidor (trigger).
GRANT SELECT ON public.mercadeo_notificaciones TO authenticated;
GRANT UPDATE (leida, leida_en) ON public.mercadeo_notificaciones TO authenticated;

DROP POLICY IF EXISTS "mercadeo_notif_select" ON public.mercadeo_notificaciones;
CREATE POLICY "mercadeo_notif_select" ON public.mercadeo_notificaciones FOR SELECT TO authenticated
  USING (para_usuario_id = (select auth.uid()));
DROP POLICY IF EXISTS "mercadeo_notif_update" ON public.mercadeo_notificaciones;
CREATE POLICY "mercadeo_notif_update" ON public.mercadeo_notificaciones FOR UPDATE TO authenticated
  USING (para_usuario_id = (select auth.uid()))
  WITH CHECK (para_usuario_id = (select auth.uid()));

-- Al entrar una tarea de Pedidos (ya aprobada) se avisa a todo el equipo con acceso a Mercadeo.
CREATE OR REPLACE FUNCTION public.mercadeo_notificar_solicitud_nueva()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ref text := CASE WHEN NEW.origen_numero IS NOT NULL THEN 'SM-' || NEW.origen_numero ELSE '#' || NEW.id END;
  v_quien text := COALESCE(NEW.a_nombre_de_nombre, NEW.solicitante_nombre, 'Pedidos');
BEGIN
  INSERT INTO mercadeo_notificaciones (para_usuario_id, tipo, tarea_id, titulo, mensaje)
  SELECT u.id, 'solicitud_aprobada', NEW.id,
         '📥 Nueva solicitud aprobada desde Pedidos: ' || v_ref,
         v_quien || ' pide: ' || NEW.titulo ||
         CASE WHEN NEW.aprobada_por_nombre IS NOT NULL THEN ' · aprobada por ' || NEW.aprobada_por_nombre ELSE '' END
  FROM usuarios_pqrs u
  WHERE u.activo = true AND (u.rol = 'admin' OR 'mercadeo' = ANY (u.modulos));
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.mercadeo_notificar_solicitud_nueva() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_notificar_solicitud ON public.mercadeo_tareas;
CREATE TRIGGER trg_notificar_solicitud
  AFTER INSERT ON public.mercadeo_tareas
  FOR EACH ROW WHEN (NEW.origen = 'panel_pedidos')
  EXECUTE FUNCTION public.mercadeo_notificar_solicitud_nueva();

-- Realtime: la campanita se actualiza sola.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                  WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'mercadeo_notificaciones') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.mercadeo_notificaciones;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

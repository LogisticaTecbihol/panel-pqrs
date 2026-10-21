-- ============================================================
-- 0033 — Tablero de Mercadeo: el aval de una tarea urgente fuera de
--        calendario deja de ser obligatorio.
-- ============================================================
-- Hasta ahora mercadeo_tareas_reglas() rechazaba una tarea urgente fuera de
-- calendario si faltaba "quién avala", la referencia o el motivo. Por ahora
-- esos tres campos quedan a discreción del equipo de Mercadeo.
--
-- Se conserva todo lo demás de la función (misma versión de 0022):
--  * una urgente fuera de calendario sigue contando como excepción
--    (fuera_calendario = true, KPI de excepciones);
--  * el sello del aval (aval_registrado_por / _por_nombre / _en) y el evento
--    'aval_registrado' de la bitácora SOLO se generan si se diligenció algún
--    dato del aval; sin datos no hay sello ni evento vacío.
-- ============================================================

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
      -- El aval es opcional: se sella solo si se diligenció algún dato.
      IF NEW.aval_por IS NOT NULL OR btrim(NEW.aval_referencia) <> '' OR btrim(NEW.aval_motivo) <> '' THEN
        IF v_aval_cambio OR NEW.aval_registrado_en IS NULL THEN
          NEW.aval_registrado_por := auth.uid();
          NEW.aval_registrado_por_nombre := v_nombre;
          NEW.aval_registrado_en := now();
        END IF;
      ELSE
        NEW.aval_registrado_por := NULL;
        NEW.aval_registrado_por_nombre := NULL;
        NEW.aval_registrado_en := NULL;
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

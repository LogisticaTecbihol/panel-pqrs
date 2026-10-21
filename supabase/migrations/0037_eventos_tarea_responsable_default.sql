-- ============================================================
-- Eventos: la tarea del Tablero nace ASIGNADA por defecto a Laura Sanchez
--
-- Al aprobar un evento, el trigger `mercadeo_eventos_tarea` crea la tarea tipo Evento en el Tablero (estado «Recibido»).
-- Hasta ahora nacía sin responsable; ahora nace con el responsable por defecto de los eventos, que el equipo puede cambiar o ampliar
-- desde la tarjeta como cualquier otra.
--
--  1. mercadeo_responsable_eventos(): devuelve el/los responsables por defecto (hoy, Laura Sanchez). Solo si esa persona sigue
--     ACTIVA y con acceso a Mercadeo; si no, devuelve vacío y la tarea nace sin responsable como antes (nunca falla la aprobación).
--     Para cambiar de persona: CREATE OR REPLACE de esta función con otro id (la lista usuarios_pqrs.id).
--  2. mercadeo_eventos_tarea(): el INSERT de la tarea usa ese responsable. Se reescribe a partir de la definición vigente
--     (solo se agrega la columna `responsables`), así no depende de qué migración la dejó como está.
--  3. Las tareas de eventos que ya existen sin ningún responsable (y siguen abiertas) se asignan también al responsable por defecto.
--
-- Solo aplica a eventos: las solicitudes generales a Mercadeo que llegan de Pedidos no cambian. Idempotente.
-- ============================================================

-- ── 1. Responsable por defecto ───────────────────────────────
CREATE OR REPLACE FUNCTION public.mercadeo_responsable_eventos()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(array_agg(u.id), '{}'::uuid[])
  FROM usuarios_pqrs u
  WHERE u.id = '8472ca51-b16d-4c3c-b7bd-bc1bd9b5e897'::uuid   -- Laura Sanchez
    AND u.activo
    AND (u.rol = 'admin' OR 'mercadeo' = ANY (u.modulos));
$$;
REVOKE ALL ON FUNCTION public.mercadeo_responsable_eventos() FROM PUBLIC, anon, authenticated;

-- ── 2. La tarea del evento nace con ese responsable ──────────
DO $$
DECLARE
  v_def text;
BEGIN
  v_def := pg_get_functiondef('public.mercadeo_eventos_tarea()'::regprocedure);
  IF position('mercadeo_responsable_eventos' IN v_def) > 0 THEN
    RETURN;   -- ya aplicada
  END IF;
  IF position('fecha_limite, evento_id)' IN v_def) = 0 OR position('NEW.fecha_evento - 1, NEW.id)' IN v_def) = 0 THEN
    RAISE EXCEPTION 'mercadeo_eventos_tarea: no se encontró el INSERT esperado; revisa la función antes de aplicar';
  END IF;
  v_def := replace(v_def, 'fecha_limite, evento_id)', 'fecha_limite, evento_id, responsables)');
  v_def := replace(v_def, 'NEW.fecha_evento - 1, NEW.id)', 'NEW.fecha_evento - 1, NEW.id, public.mercadeo_responsable_eventos())');
  EXECUTE v_def;
END;
$$;

-- ── 3. Tareas de eventos ya existentes, abiertas y sin responsable ──
UPDATE public.mercadeo_tareas
   SET responsables = public.mercadeo_responsable_eventos()
 WHERE evento_id IS NOT NULL
   AND COALESCE(cardinality(responsables), 0) = 0
   AND estado IN ('solicitada', 'confirmada', 'en_produccion', 'en_validacion')
   AND COALESCE(cardinality(public.mercadeo_responsable_eventos()), 0) > 0;

NOTIFY pgrst, 'reload schema';

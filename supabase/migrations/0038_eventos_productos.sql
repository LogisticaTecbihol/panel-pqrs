-- ============================================================
-- 0038 — Eventos: «Productos relacionados» (alineado con Solicitudes de Eventos de panel-pedidos)
-- ============================================================
-- El solicitante (y Mercadeo, al digitar o corregir) registra los productos relacionados con el evento. Desde Pedidos se buscan en
-- el maestro de productos por el NOMBRE, sin la presentación («CALIMAN X LITRO» -> «CALIMAN»), o se escriben a mano si no están en
-- el listado; aquí no hay maestro, así que el campo es un arreglo de textos libres.
--
--  1. mercadeo_eventos.productos : text[] (hasta 20 nombres de 2 a 100 caracteres). Vacío por defecto: los eventos anteriores quedan
--     sin productos. La función mercadeo_productos_validos() lo exige en la BD (también contra escrituras directas del navegador).
--  2. mercadeo_evento_brief(): el brief de la tarea del Tablero agrega «Productos relacionados» (lista) cuando hay.
--  3. mercadeo_eventos_bitacora(): un cambio en `productos` queda en la bitácora del evento (cambio_datos), como el resto de listas.
--
-- Las dos funciones se reescriben a partir de su definición vigente (solo se agrega el bloque nuevo / un elemento a una lista), así que no
-- dependen de qué migración las dejó como están. Idempotente.
--
-- Orden de despliegue: aplicar esta migración (apply_migration) ANTES de redesplegar solicitud-evento-pedidos y de publicar el frontend;
-- si no, un evento con productos fallaría al insertar la columna.
-- ============================================================

CREATE OR REPLACE FUNCTION public.mercadeo_productos_validos(p text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT p IS NOT NULL
     AND cardinality(p) <= 20
     AND NOT EXISTS (
       SELECT 1 FROM unnest(p) AS x
        WHERE x IS NULL OR char_length(btrim(x)) < 2 OR char_length(x) > 100
     )
$$;

ALTER TABLE public.mercadeo_eventos ADD COLUMN IF NOT EXISTS productos text[] NOT NULL DEFAULT '{}';

ALTER TABLE public.mercadeo_eventos DROP CONSTRAINT IF EXISTS mercadeo_eventos_productos_check;
ALTER TABLE public.mercadeo_eventos ADD CONSTRAINT mercadeo_eventos_productos_check
  CHECK (public.mercadeo_productos_validos(productos));

-- Brief de la tarea: agrega la sección de productos justo antes del RETURN.
DO $mig$
DECLARE
  v_def text;
  v_ancla constant text := '  RETURN v_txt;';
  v_nuevo constant text := $bloque$  IF cardinality(e.productos) > 0 THEN
    SELECT string_agg('- ' || x, E'\n' ORDER BY ord) INTO v_seccion FROM unnest(e.productos) WITH ORDINALITY AS t(x, ord);
    v_txt := v_txt || E'\n\nProductos relacionados:\n' || v_seccion;
  END IF;

  RETURN v_txt;$bloque$;
BEGIN
  v_def := pg_get_functiondef('public.mercadeo_evento_brief(public.mercadeo_eventos)'::regprocedure);
  IF position('Productos relacionados' IN v_def) > 0 THEN
    RETURN;   -- ya aplicada
  END IF;
  IF (length(v_def) - length(replace(v_def, v_ancla, ''))) <> length(v_ancla) THEN
    RAISE EXCEPTION 'mercadeo_evento_brief: no se encontró un único RETURN v_txt; revisa la función antes de aplicar';
  END IF;
  EXECUTE replace(v_def, v_ancla, v_nuevo);
END
$mig$;

-- Bitácora: `productos` se compara como las demás listas (solo se anota que cambió).
DO $mig$
DECLARE
  v_def text;
  v_ancla constant text := $a$'desglose_gastos'];$a$;
  v_nuevo constant text := $n$'desglose_gastos','productos'];$n$;
BEGIN
  v_def := pg_get_functiondef('public.mercadeo_eventos_bitacora()'::regprocedure);
  IF position($p$'productos'$p$ IN v_def) > 0 THEN
    RETURN;   -- ya aplicada
  END IF;
  IF (length(v_def) - length(replace(v_def, v_ancla, ''))) <> length(v_ancla) THEN
    RAISE EXCEPTION 'mercadeo_eventos_bitacora: no se encontró la lista v_largas esperada; revisa la función antes de aplicar';
  END IF;
  EXECUTE replace(v_def, v_ancla, v_nuevo);
END
$mig$;

NOTIFY pgrst, 'reload schema';

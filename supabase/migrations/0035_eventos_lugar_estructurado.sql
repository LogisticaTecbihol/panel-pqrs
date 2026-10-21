-- ============================================================
-- Eventos: lugar ESTRUCTURADO (alineado con Solicitudes de Eventos de panel-pedidos)
--
-- El «Lugar» deja de ser solo un texto libre: ahora se registra por partes.
--   lugar_municipio / lugar_departamento : de la lista oficial de Colombia (validada en el formulario)
--   lugar_distribuidor / lugar_distribuidor_nit : distribuidor o cliente donde se hace el evento (opcionales)
--   lugar_finca : finca, si aplica (opcional)
-- `lugar` sigue existiendo y se mantiene como el TEXTO ARMADO con esas partes
-- («Municipio, Departamento · Distribuidor/cliente: X (NIT n) · Finca: Y»): lo siguen usando el brief de la tarea, la
-- búsqueda y la tabla, y los eventos anteriores conservan su lugar en texto libre.
--
-- Solo se agregan columnas con valor vacío por defecto: no cambia ninguna regla ni ningún dato existente. La obligatoriedad
-- (municipio y departamento en eventos físicos/híbridos) la exige el formulario, igual que en Pedidos.
-- Idempotente. Aplicar con apply_migration (MCP) ANTES de redesplegar solicitud-evento-pedidos y publicar el frontend.
-- ============================================================

ALTER TABLE public.mercadeo_eventos
  ADD COLUMN IF NOT EXISTS lugar_municipio        text NOT NULL DEFAULT '' CHECK (char_length(lugar_municipio) <= 60),
  ADD COLUMN IF NOT EXISTS lugar_departamento     text NOT NULL DEFAULT '' CHECK (char_length(lugar_departamento) <= 40),
  ADD COLUMN IF NOT EXISTS lugar_distribuidor     text NOT NULL DEFAULT '' CHECK (char_length(lugar_distribuidor) <= 120),
  ADD COLUMN IF NOT EXISTS lugar_distribuidor_nit text NOT NULL DEFAULT '' CHECK (char_length(lugar_distribuidor_nit) <= 25),
  ADD COLUMN IF NOT EXISTS lugar_finca            text NOT NULL DEFAULT '' CHECK (char_length(lugar_finca) <= 100);

NOTIFY pgrst, 'reload schema';

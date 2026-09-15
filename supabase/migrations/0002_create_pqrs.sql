-- ============================================================
-- Tabla principal de PQRS (Peticiones, Quejas, Reclamos, Sugerencias)
-- Origen: puente Google Apps Script -> Edge Function ingest-formulario,
-- o el script de importación histórica (scripts/importar_historico_pqrs.mjs).
-- ============================================================

CREATE TABLE IF NOT EXISTS pqrs (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  folio                  text NOT NULL UNIQUE,
  empresa_sigla          text NOT NULL CHECK (empresa_sigla IN ('PARCELAR','GREEN','RESO','IASO','IAS')),

  -- Datos del remitente (el cliente externo no tiene cuenta en el sistema:
  -- NO hay columna creado_por).
  nombre_completo        text,
  contacto               text NOT NULL,
  identificacion_cliente text,
  tipo_solicitud         text NOT NULL CHECK (tipo_solicitud IN ('Peticion','Queja','Reclamo','Sugerencia')),
  fecha_evento           date,
  area_relacionada       text NOT NULL CHECK (area_relacionada IN
    ('Produccion','Servicio al cliente','Ventas','Estado del producto','Logistica','Pos venta','Otro')),
  referencia_pedido      text,
  producto_lote          text,
  ciudad_departamento    text,
  descripcion            text NOT NULL,
  urgencia               text NOT NULL CHECK (urgencia IN ('ALTO','MEDIO','BAJA')),
  desea_respuesta        boolean NOT NULL,
  comentarios_adicionales text,

  -- Gestión interna
  estado                 text NOT NULL DEFAULT 'Nuevo' CHECK (estado IN ('Nuevo','En proceso','Resuelto','Cerrado')),
  responsable_id         uuid REFERENCES usuarios_pqrs(id),
  fecha_limite           date,

  creado_en              timestamptz NOT NULL DEFAULT now(),
  modificado_por         uuid REFERENCES usuarios_pqrs(id),
  modificado_en          timestamptz
);

CREATE INDEX IF NOT EXISTS idx_pqrs_empresa ON pqrs(empresa_sigla);
CREATE INDEX IF NOT EXISTS idx_pqrs_estado ON pqrs(estado);
CREATE INDEX IF NOT EXISTS idx_pqrs_responsable ON pqrs(responsable_id);
CREATE INDEX IF NOT EXISTS idx_pqrs_creado_en ON pqrs(creado_en);

ALTER TABLE pqrs ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- Adjuntos (referencia a Drive del cliente + subida propia de gestión interna)
-- y bitácora/timeline de gestión de cada PQRS.
-- ============================================================

CREATE TABLE IF NOT EXISTS pqrs_adjuntos (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pqrs_id        bigint NOT NULL REFERENCES pqrs(id) ON DELETE CASCADE,
  origen         text NOT NULL CHECK (origen IN ('cliente_drive','gestion_interna')),

  -- Solo si origen='cliente_drive' (llega del Form/puente, referencia a Drive):
  drive_file_id  text,
  drive_url      text,

  -- Solo si origen='gestion_interna' (subido por el equipo desde el panel):
  storage_path   text,
  subido_por     uuid REFERENCES usuarios_pqrs(id),

  nombre_original text,
  tipo_mime       text,
  tamano_bytes    bigint,
  creado_en       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pqrs_adjuntos_origen_datos_check CHECK (
    (origen = 'cliente_drive' AND drive_url IS NOT NULL AND storage_path IS NULL) OR
    (origen = 'gestion_interna' AND storage_path IS NOT NULL AND drive_url IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_pqrs_adjuntos_pqrs ON pqrs_adjuntos(pqrs_id);

ALTER TABLE pqrs_adjuntos ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS pqrs_bitacora (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pqrs_id        bigint NOT NULL REFERENCES pqrs(id) ON DELETE CASCADE,
  tipo_evento    text NOT NULL CHECK (tipo_evento IN
    ('creacion','cambio_estado','asignacion','nota','notificacion_enviada','adjunto_agregado')),
  usuario_id     uuid REFERENCES usuarios_pqrs(id),
  usuario_nombre text,
  detalle        jsonb,
  creado_en      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pqrs_bitacora_pqrs ON pqrs_bitacora(pqrs_id);

ALTER TABLE pqrs_bitacora ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';

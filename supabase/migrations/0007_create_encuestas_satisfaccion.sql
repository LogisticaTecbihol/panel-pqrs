-- ============================================================
-- Encuesta de Satisfacción (la otra rama del mismo Google Form).
-- Datos de reporte/análisis, no un caso que se gestiona uno por uno:
-- sin folio, sin estado, sin responsable, sin bitácora. Inmutable una
-- vez recibida.
-- ============================================================

CREATE TABLE IF NOT EXISTS encuestas_satisfaccion (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa_sigla          text NOT NULL CHECK (empresa_sigla IN ('PARCELAR','GREEN','RESO','IASO','IAS')),
  municipio              text NOT NULL,
  asesor_nombre          text,
  canal_adquisicion      text NOT NULL CHECK (canal_adquisicion IN
    ('Directo','Distribuidor autorizado','Tienda agropecuaria local','Otro')),
  canal_adquisicion_otro text,

  calificacion_calidad_producto            smallint NOT NULL CHECK (calificacion_calidad_producto BETWEEN 1 AND 5),
  calificacion_atencion_asesor_tecnico     smallint NOT NULL CHECK (calificacion_atencion_asesor_tecnico BETWEEN 1 AND 5),
  calificacion_atencion_servicio_logistica smallint NOT NULL CHECK (calificacion_atencion_servicio_logistica BETWEEN 1 AND 5),
  calificacion_tiempos_respuesta           smallint NOT NULL CHECK (calificacion_tiempos_respuesta BETWEEN 1 AND 5),
  calificacion_relacion_calidad_precio     smallint NOT NULL CHECK (calificacion_relacion_calidad_precio BETWEEN 1 AND 5),
  calificacion_satisfaccion_general        smallint NOT NULL CHECK (calificacion_satisfaccion_general BETWEEN 1 AND 5),

  comentarios_adicionales text,
  creado_en               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_encuestas_empresa ON encuestas_satisfaccion(empresa_sigla);
CREATE INDEX IF NOT EXISTS idx_encuestas_creado_en ON encuestas_satisfaccion(creado_en);

ALTER TABLE encuestas_satisfaccion ENABLE ROW LEVEL SECURITY;

-- Sin policy de INSERT: solo service_role (ingest-formulario / importación histórica).
CREATE POLICY "encuestas_satisfaccion_select" ON encuestas_satisfaccion
  FOR SELECT TO authenticated
  USING (get_user_role_pqrs() = ANY (ARRAY['admin','gestor','lector']));

CREATE POLICY "encuestas_satisfaccion_delete" ON encuestas_satisfaccion
  FOR DELETE TO authenticated
  USING (get_user_role_pqrs() = 'admin');

NOTIFY pgrst, 'reload schema';

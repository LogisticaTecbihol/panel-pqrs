-- ============================================================
-- Distingue en el panel las PQRS importadas del histórico de
-- Google Forms de las que llegan en vivo desde ahora en adelante,
-- para poder mostrarlas en pestañas separadas (Histórico / PQRS).
-- ============================================================

ALTER TABLE pqrs ADD COLUMN es_historico boolean NOT NULL DEFAULT false;

UPDATE pqrs SET es_historico = true
WHERE id IN (
  SELECT DISTINCT pqrs_id FROM pqrs_bitacora WHERE detalle->>'origen' = 'importacion_historica'
);

CREATE INDEX idx_pqrs_es_historico ON pqrs (es_historico);

NOTIFY pgrst, 'reload schema';

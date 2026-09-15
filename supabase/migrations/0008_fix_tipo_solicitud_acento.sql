-- ============================================================
-- Fix: el Google Form entrega "Petición" (con tilde, español correcto) como
-- valor de la pregunta "Tipo de solicitud". La migración 0002 había definido
-- el CHECK con 'Peticion' sin tilde por error -- se detectó al inspeccionar
-- los CSV reales de respuestas antes de la importación histórica.
-- ============================================================

ALTER TABLE pqrs DROP CONSTRAINT pqrs_tipo_solicitud_check;
ALTER TABLE pqrs ADD CONSTRAINT pqrs_tipo_solicitud_check
  CHECK (tipo_solicitud IN ('Petición','Queja','Reclamo','Sugerencia'));

NOTIFY pgrst, 'reload schema';

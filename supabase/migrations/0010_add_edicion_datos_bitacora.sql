-- ============================================================
-- Permite registrar en la bitácora cuando un admin corrige los datos
-- originales de la solicitud (nombre, contacto, descripción, etc.)
-- desde el panel. La edición en sí ya está protegida por el trigger
-- guard_pqrs_datos_remitente (solo admin puede modificar esas columnas);
-- esto solo habilita el tipo de evento para dejar rastro en pqrs_bitacora.
-- ============================================================

ALTER TABLE pqrs_bitacora DROP CONSTRAINT pqrs_bitacora_tipo_evento_check;
ALTER TABLE pqrs_bitacora ADD CONSTRAINT pqrs_bitacora_tipo_evento_check
  CHECK (tipo_evento IN ('creacion','cambio_estado','asignacion','nota','notificacion_enviada','adjunto_agregado','edicion_datos'));

DROP POLICY IF EXISTS "pqrs_bitacora_insert" ON pqrs_bitacora;
CREATE POLICY "pqrs_bitacora_insert" ON pqrs_bitacora
  FOR INSERT TO authenticated
  WITH CHECK (
    usuario_id = (select auth.uid())
    AND get_user_role_pqrs() = ANY (ARRAY['admin','gestor'])
    AND tipo_evento IN ('nota','cambio_estado','asignacion','adjunto_agregado','edicion_datos')
  );

NOTIFY pgrst, 'reload schema';

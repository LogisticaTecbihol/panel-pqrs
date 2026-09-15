-- ============================================================
-- Ajustes de rendimiento sugeridos por el linter de Supabase
-- (get_advisors) tras la carga inicial de datos:
--   - Índices faltantes en columnas FK de auditoría.
--   - auth.uid() envuelto en (select ...) en las policies para que el
--     planner lo evalúe una sola vez por consulta, no una vez por fila.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_pqrs_modificado_por ON pqrs(modificado_por);
CREATE INDEX IF NOT EXISTS idx_pqrs_adjuntos_subido_por ON pqrs_adjuntos(subido_por);
CREATE INDEX IF NOT EXISTS idx_pqrs_bitacora_usuario_id ON pqrs_bitacora(usuario_id);

DROP POLICY IF EXISTS "usuarios_pqrs_select" ON usuarios_pqrs;
CREATE POLICY "usuarios_pqrs_select" ON usuarios_pqrs
  FOR SELECT TO authenticated
  USING (id = (select auth.uid()) OR get_user_role_pqrs() = 'admin');

DROP POLICY IF EXISTS "pqrs_adjuntos_insert_gestion" ON pqrs_adjuntos;
CREATE POLICY "pqrs_adjuntos_insert_gestion" ON pqrs_adjuntos
  FOR INSERT TO authenticated
  WITH CHECK (
    origen = 'gestion_interna'
    AND subido_por = (select auth.uid())
    AND get_user_role_pqrs() = ANY (ARRAY['admin','gestor'])
  );

DROP POLICY IF EXISTS "pqrs_bitacora_insert" ON pqrs_bitacora;
CREATE POLICY "pqrs_bitacora_insert" ON pqrs_bitacora
  FOR INSERT TO authenticated
  WITH CHECK (
    usuario_id = (select auth.uid())
    AND get_user_role_pqrs() = ANY (ARRAY['admin','gestor'])
    AND tipo_evento IN ('nota','cambio_estado','asignacion','adjunto_agregado')
  );

NOTIFY pgrst, 'reload schema';

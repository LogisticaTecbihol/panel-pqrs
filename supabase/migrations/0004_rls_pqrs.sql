-- ============================================================
-- RLS de pqrs / pqrs_adjuntos / pqrs_bitacora
--
-- pqrs y pqrs_adjuntos (rama cliente_drive) NO tienen policy de INSERT:
-- el único camino de escritura es el Edge Function ingest-formulario con
-- service_role (que ignora RLS), tras validar el secreto compartido del
-- puente de Apps Script. Con RLS habilitado y sin policy, INSERT desde
-- anon/authenticated queda denegado por defecto.
-- ============================================================

-- ── pqrs ──────────────────────────────────────────────────────

CREATE POLICY "pqrs_select" ON pqrs
  FOR SELECT TO authenticated
  USING (get_user_role_pqrs() = ANY (ARRAY['admin','gestor','lector']));

CREATE POLICY "pqrs_update" ON pqrs
  FOR UPDATE TO authenticated
  USING (get_user_role_pqrs() = ANY (ARRAY['admin','gestor']))
  WITH CHECK (get_user_role_pqrs() = ANY (ARRAY['admin','gestor']));

CREATE POLICY "pqrs_delete" ON pqrs
  FOR DELETE TO authenticated
  USING (get_user_role_pqrs() = 'admin');

-- Trigger: impide que un rol distinto de 'admin' modifique los datos
-- originales del remitente (RLS es por fila, no por columna). También
-- sella modificado_por/modificado_en en cada UPDATE, como el patrón de
-- auditoría del panel de pedidos.
CREATE OR REPLACE FUNCTION public.guard_pqrs_datos_remitente()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rol text := get_user_role_pqrs();
BEGIN
  IF v_rol IS NOT NULL AND v_rol <> 'admin' THEN
    IF NEW.folio                   IS DISTINCT FROM OLD.folio
       OR NEW.empresa_sigla        IS DISTINCT FROM OLD.empresa_sigla
       OR NEW.nombre_completo      IS DISTINCT FROM OLD.nombre_completo
       OR NEW.contacto             IS DISTINCT FROM OLD.contacto
       OR NEW.identificacion_cliente IS DISTINCT FROM OLD.identificacion_cliente
       OR NEW.tipo_solicitud       IS DISTINCT FROM OLD.tipo_solicitud
       OR NEW.fecha_evento         IS DISTINCT FROM OLD.fecha_evento
       OR NEW.area_relacionada     IS DISTINCT FROM OLD.area_relacionada
       OR NEW.referencia_pedido    IS DISTINCT FROM OLD.referencia_pedido
       OR NEW.producto_lote        IS DISTINCT FROM OLD.producto_lote
       OR NEW.ciudad_departamento  IS DISTINCT FROM OLD.ciudad_departamento
       OR NEW.descripcion          IS DISTINCT FROM OLD.descripcion
       OR NEW.urgencia             IS DISTINCT FROM OLD.urgencia
       OR NEW.desea_respuesta      IS DISTINCT FROM OLD.desea_respuesta
       OR NEW.comentarios_adicionales IS DISTINCT FROM OLD.comentarios_adicionales
       OR NEW.creado_en            IS DISTINCT FROM OLD.creado_en
    THEN
      RAISE EXCEPTION 'Solo un administrador puede modificar los datos originales del remitente';
    END IF;
  END IF;
  NEW.modificado_por := auth.uid();
  NEW.modificado_en := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_pqrs_datos_remitente ON pqrs;
CREATE TRIGGER trg_guard_pqrs_datos_remitente
  BEFORE UPDATE ON pqrs
  FOR EACH ROW EXECUTE FUNCTION public.guard_pqrs_datos_remitente();

REVOKE ALL ON FUNCTION public.guard_pqrs_datos_remitente() FROM PUBLIC, anon, authenticated;

-- ── pqrs_adjuntos ─────────────────────────────────────────────

CREATE POLICY "pqrs_adjuntos_select" ON pqrs_adjuntos
  FOR SELECT TO authenticated
  USING (get_user_role_pqrs() = ANY (ARRAY['admin','gestor','lector']));

-- Solo permite insertar adjuntos de gestión interna (origen='gestion_interna');
-- la rama 'cliente_drive' nunca la satisface un usuario authenticated, así que
-- en la práctica solo service_role puede crear esas filas.
CREATE POLICY "pqrs_adjuntos_insert_gestion" ON pqrs_adjuntos
  FOR INSERT TO authenticated
  WITH CHECK (
    origen = 'gestion_interna'
    AND subido_por = auth.uid()
    AND get_user_role_pqrs() = ANY (ARRAY['admin','gestor'])
  );

CREATE POLICY "pqrs_adjuntos_delete" ON pqrs_adjuntos
  FOR DELETE TO authenticated
  USING (get_user_role_pqrs() = 'admin');

-- ── pqrs_bitacora ─────────────────────────────────────────────

CREATE POLICY "pqrs_bitacora_select" ON pqrs_bitacora
  FOR SELECT TO authenticated
  USING (get_user_role_pqrs() = ANY (ARRAY['admin','gestor','lector']));

-- Los eventos de sistema ('creacion', 'notificacion_enviada') solo los inserta
-- service_role desde ingest-formulario; un usuario authenticated solo puede
-- registrar eventos de su propia gestión.
CREATE POLICY "pqrs_bitacora_insert" ON pqrs_bitacora
  FOR INSERT TO authenticated
  WITH CHECK (
    usuario_id = auth.uid()
    AND get_user_role_pqrs() = ANY (ARRAY['admin','gestor'])
    AND tipo_evento IN ('nota','cambio_estado','asignacion','adjunto_agregado')
  );

NOTIFY pgrst, 'reload schema';

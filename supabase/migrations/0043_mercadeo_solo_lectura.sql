-- ============================================================
-- Mercadeo: acceso de SOLO LECTURA para el rol 'lector' + fuera del directorio del equipo.
--
-- Hasta ahora el módulo 'mercadeo' daba lectura Y escritura (todas las policies usaban
-- user_has_module_pqrs('mercadeo')), sin importar el rol. Un lector con el módulo (p. ej. alguien
-- que solo debe CONSULTAR el Tablero, el CRM, Eventos e Indicadores) podía crear, mover y borrar.
--
-- Regla nueva (misma idea que en PQRS: «lector = solo lectura»):
--   - Ve todo Mercadeo:       user_has_module_pqrs('mercadeo')   (sin cambios; admin siempre).
--   - Gestiona (escribe):     user_can_manage_mercadeo() = admin, o módulo 'mercadeo' con un rol que NO sea 'lector'.
--   - Es parte del equipo:    list_equipo_mercadeo() = admin, o módulo 'mercadeo' con un rol que NO sea 'lector'.
--     Un lector ya no sale en los filtros de responsable, la leyenda de color, la carga por responsable de los
--     Indicadores ni en los selectores de «asignar a». Sus nombres históricos no existen: nunca fue responsable.
--
-- Los roles 'mercadeo', 'gestor' y 'sst' con el módulo siguen igual (leen y escriben).
-- No cambia: la campanita de avisos (los triggers siguen avisando a quien tenga el módulo), ni
-- mercadeo_responsable_eventos(). Idempotente. Aplicar con apply_migration ANTES de publicar el frontend.
-- ============================================================

-- ── 1. ¿Puede el usuario actual GESTIONAR Mercadeo? ──────────
CREATE OR REPLACE FUNCTION public.user_can_manage_mercadeo()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM usuarios_pqrs u
    WHERE u.id = auth.uid()
      AND u.activo = true
      AND (u.rol = 'admin' OR ('mercadeo' = ANY (u.modulos) AND u.rol <> 'lector'))
  );
$$;

REVOKE ALL ON FUNCTION public.user_can_manage_mercadeo() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.user_can_manage_mercadeo() TO authenticated;

-- ── 2. Directorio del equipo: sin lectores ───────────────────
CREATE OR REPLACE FUNCTION public.list_equipo_mercadeo()
RETURNS TABLE (id uuid, nombre text, activo boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT u.id, COALESCE(NULLIF(u.nombre, ''), u.email) AS nombre, u.activo
  FROM usuarios_pqrs u
  WHERE public.user_has_module_pqrs('mercadeo')
    AND (u.rol = 'admin' OR ('mercadeo' = ANY (u.modulos) AND u.rol <> 'lector'))
  ORDER BY 2;
$$;

REVOKE ALL ON FUNCTION public.list_equipo_mercadeo() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_equipo_mercadeo() TO authenticated;

-- ── 3. Tablas del CRM con una sola policy FOR ALL → lectura aparte de escritura ──
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'mercadeo_actividades', 'mercadeo_comerciales', 'mercadeo_leads',
    'mercadeo_leads_seguimiento', 'mercadeo_presupuesto', 'mercadeo_presupuesto_gastos'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_all', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_insert', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_update', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_delete', t);

    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING ((SELECT public.user_has_module_pqrs(''mercadeo'')))', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK ((SELECT public.user_can_manage_mercadeo()))', t || '_insert', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING ((SELECT public.user_can_manage_mercadeo())) WITH CHECK ((SELECT public.user_can_manage_mercadeo()))', t || '_update', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING ((SELECT public.user_can_manage_mercadeo()))', t || '_delete', t);
  END LOOP;
END $$;

-- ── 4. Tablero (tareas) ──────────────────────────────────────
ALTER POLICY mercadeo_tareas_insert ON public.mercadeo_tareas
  WITH CHECK ((SELECT public.user_can_manage_mercadeo()));
ALTER POLICY mercadeo_tareas_update ON public.mercadeo_tareas
  USING ((SELECT public.user_can_manage_mercadeo()))
  WITH CHECK ((SELECT public.user_can_manage_mercadeo()));

-- Bitácora: el cliente solo inserta comentarios (y respuestas al solicitante en tareas de Pedidos).
ALTER POLICY mercadeo_tarea_bitacora_insert ON public.mercadeo_tarea_bitacora
  WITH CHECK (
    (SELECT public.user_can_manage_mercadeo())
    AND (
      tipo_evento = 'comentario'
      OR (tipo_evento = 'respuesta_solicitante'
          AND EXISTS (SELECT 1 FROM public.mercadeo_tareas t
                      WHERE t.id = mercadeo_tarea_bitacora.tarea_id AND t.origen = 'panel_pedidos'))
    )
  );

ALTER POLICY mercadeo_tarea_adjuntos_insert ON public.mercadeo_tarea_adjuntos
  WITH CHECK ((SELECT public.user_can_manage_mercadeo()) AND subido_por = (SELECT auth.uid()));
ALTER POLICY mercadeo_tarea_adjuntos_delete ON public.mercadeo_tarea_adjuntos
  USING ((SELECT public.user_can_manage_mercadeo()));

-- ── 5. Eventos ───────────────────────────────────────────────
ALTER POLICY mercadeo_eventos_insert ON public.mercadeo_eventos
  WITH CHECK ((SELECT public.user_can_manage_mercadeo()));
ALTER POLICY mercadeo_eventos_update ON public.mercadeo_eventos
  USING ((SELECT public.user_can_manage_mercadeo()))
  WITH CHECK ((SELECT public.user_can_manage_mercadeo()));

ALTER POLICY mercadeo_evento_bitacora_insert ON public.mercadeo_evento_bitacora
  WITH CHECK (
    (SELECT public.user_can_manage_mercadeo())
    AND (
      tipo_evento = 'comentario'
      OR (tipo_evento = 'respuesta_solicitante'
          AND EXISTS (SELECT 1 FROM public.mercadeo_eventos e
                      WHERE e.id = mercadeo_evento_bitacora.evento_id AND e.origen = 'panel_pedidos'))
    )
  );

ALTER POLICY mercadeo_evento_adjuntos_insert ON public.mercadeo_evento_adjuntos
  WITH CHECK ((SELECT public.user_can_manage_mercadeo()) AND subido_por = (SELECT auth.uid()));
ALTER POLICY mercadeo_evento_adjuntos_delete ON public.mercadeo_evento_adjuntos
  USING ((SELECT public.user_can_manage_mercadeo()));

ALTER POLICY mercadeo_evento_checklist_insert ON public.mercadeo_evento_checklist
  WITH CHECK ((SELECT public.user_can_manage_mercadeo()));
ALTER POLICY mercadeo_evento_checklist_update ON public.mercadeo_evento_checklist
  USING ((SELECT public.user_can_manage_mercadeo()))
  WITH CHECK ((SELECT public.user_can_manage_mercadeo()));
ALTER POLICY mercadeo_evento_checklist_delete ON public.mercadeo_evento_checklist
  USING ((SELECT public.user_can_manage_mercadeo()));

ALTER POLICY mercadeo_evento_chk_adj_insert ON public.mercadeo_evento_checklist_adjuntos
  WITH CHECK ((SELECT public.user_can_manage_mercadeo()));
ALTER POLICY mercadeo_evento_chk_adj_delete ON public.mercadeo_evento_checklist_adjuntos
  USING ((SELECT public.user_can_manage_mercadeo()));

ALTER POLICY mercadeo_evento_asistentes_insert ON public.mercadeo_evento_asistentes
  WITH CHECK ((SELECT public.user_can_manage_mercadeo()));
ALTER POLICY mercadeo_evento_asistentes_update ON public.mercadeo_evento_asistentes
  USING ((SELECT public.user_can_manage_mercadeo()))
  WITH CHECK ((SELECT public.user_can_manage_mercadeo()));
ALTER POLICY mercadeo_evento_asistentes_delete ON public.mercadeo_evento_asistentes
  USING ((SELECT public.user_can_manage_mercadeo()));

-- ── 6. Storage: el bucket mercadeo-adjuntos se lee con el módulo, se escribe solo gestionando ──
DROP POLICY IF EXISTS "mercadeo_adjuntos_insert" ON storage.objects;
CREATE POLICY "mercadeo_adjuntos_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'mercadeo-adjuntos' AND (SELECT public.user_can_manage_mercadeo()));

DROP POLICY IF EXISTS "mercadeo_adjuntos_delete" ON storage.objects;
CREATE POLICY "mercadeo_adjuntos_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'mercadeo-adjuntos' AND (SELECT public.user_can_manage_mercadeo()));

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- Módulo 'pqrs' asignable a un usuario (consulta de PQRS, SOLO LECTURA).
--
-- Hasta aquí PQRS salía únicamente del ROL: admin / gestor / lector la veían; un usuario con rol
-- 'mercadeo' o 'sst' no podía recibirla (las policies de pqrs enumeran roles). Ahora 'pqrs' es un
-- módulo más de usuarios_pqrs.modulos, igual que 'mercadeo', 'sst' y 'encuestas' (0028):
--   - admin la ve siempre;
--   - los roles gestor y lector la traen por sí solos (no hace falta guardarla en modulos);
--   - a cualquier otro rol (mercadeo, sst) se le puede marcar el módulo desde Usuarios.
--
-- El módulo da LECTURA: lista, detalle, adjuntos, bitácora y descarga de adjuntos de gestión.
-- Gestionar (estado, responsable, fecha límite, notas, adjuntos nuevos) sigue siendo de los
-- roles admin y gestor (policies de UPDATE/INSERT de 0004/0009/0010, que NO se tocan), y
-- borrar sigue siendo solo de admin. Quien deba gestionar necesita el rol gestor.
--
-- user_has_module_pqrs('pqrs') queda igual que AUTH.hasModule('pqrs') del frontend: admin, rol
-- gestor/lector, o 'pqrs' en modulos.
--
-- Requiere 0004, 0006, 0012 y 0028. Idempotente. Aplicar con apply_migration (MCP) ANTES de
-- publicar el frontend. Al aplicarla nadie tiene 'pqrs' en modulos: no cambia el acceso de nadie
-- hasta que un admin lo marque.
-- ============================================================

-- ── 1. 'pqrs' como módulo válido ─────────────────────────────
ALTER TABLE public.usuarios_pqrs DROP CONSTRAINT IF EXISTS usuarios_pqrs_modulos_check;
ALTER TABLE public.usuarios_pqrs ADD CONSTRAINT usuarios_pqrs_modulos_check
  CHECK (modulos <@ ARRAY['mercadeo','sst','encuestas','pqrs']::text[]);

-- ── 2. user_has_module_pqrs(): 'pqrs' también la traen los roles gestor y lector ──
CREATE OR REPLACE FUNCTION public.user_has_module_pqrs(p_modulo text)
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
      AND (u.rol = 'admin'
           OR p_modulo = ANY (u.modulos)
           OR (p_modulo = 'pqrs' AND u.rol IN ('gestor', 'lector')))
  );
$$;

REVOKE ALL ON FUNCTION public.user_has_module_pqrs(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.user_has_module_pqrs(text) TO authenticated;

-- ── 3. Lectura de PQRS: por módulo, ya no por la lista de roles ──
-- ALTER POLICY cambia solo la condición de las policies de 0004/0012 (mismo nombre, comando y rol),
-- de forma atómica y sin dejar ningún instante la tabla sin policy.
-- (select ...) para que el planner evalúe la función una sola vez por consulta (patrón de 0009).
ALTER POLICY "pqrs_select" ON public.pqrs
  USING ((select public.user_has_module_pqrs('pqrs')));

ALTER POLICY "pqrs_adjuntos_select" ON public.pqrs_adjuntos
  USING ((select public.user_has_module_pqrs('pqrs')));

ALTER POLICY "pqrs_bitacora_select" ON public.pqrs_bitacora
  USING ((select public.user_has_module_pqrs('pqrs')));

-- Descarga de los adjuntos de gestión (URL firmada). Subir y borrar siguen igual (0006 / 0012).
ALTER POLICY "pqrs_gestion_adjuntos_select" ON storage.objects
  USING (
    bucket_id = 'pqrs-gestion-adjuntos'
    AND (select public.user_has_module_pqrs('pqrs'))
  );

NOTIFY pgrst, 'reload schema';

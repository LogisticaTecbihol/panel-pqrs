-- ============================================================
-- Permisos por módulo + rol 'mercadeo' (equipo de Mercadeo del holding).
--
-- Hasta ahora panel-pqrs solo tenía roles globales (admin/gestor/lector) y
-- cualquiera de ellos lee TODAS las PQRS (datos de clientes). El equipo de
-- Mercadeo (tablero de tareas + CRM) NO debe ver PQRS, así que:
--   - rol 'mercadeo' = sin acceso a PQRS/Encuestas (las policies de esas
--     tablas enumeran roles, por eso quedan excluidos solos);
--   - usuarios_pqrs.modulos = módulos extra habilitados (hoy solo 'mercadeo').
--     Un gestor/lector puede recibir el módulo sin cambiar de rol.
--
-- Nota de numeración: en la BD viva existe la migración add_es_historico_pqrs
-- cuyo archivo 0011 se borró del repo con el revert 9ef048b (recuperable con
-- `git show e6af868:supabase/migrations/0011_add_es_historico_pqrs.sql`).
--
-- Idempotente. Aplicar con apply_migration (MCP) ANTES de publicar el frontend.
-- ============================================================

-- ── 1. Rol 'mercadeo' y columna modulos ──────────────────────
ALTER TABLE usuarios_pqrs DROP CONSTRAINT IF EXISTS usuarios_pqrs_rol_check;
ALTER TABLE usuarios_pqrs ADD CONSTRAINT usuarios_pqrs_rol_check
  CHECK (rol IN ('admin','gestor','lector','mercadeo'));

ALTER TABLE usuarios_pqrs ADD COLUMN IF NOT EXISTS modulos text[] NOT NULL DEFAULT '{}';

ALTER TABLE usuarios_pqrs DROP CONSTRAINT IF EXISTS usuarios_pqrs_modulos_check;
ALTER TABLE usuarios_pqrs ADD CONSTRAINT usuarios_pqrs_modulos_check
  CHECK (modulos <@ ARRAY['mercadeo']::text[]);

-- Un usuario con rol 'mercadeo' siempre tiene el módulo (si no, no podría entrar a nada).
ALTER TABLE usuarios_pqrs DROP CONSTRAINT IF EXISTS usuarios_pqrs_mercadeo_modulo_check;
ALTER TABLE usuarios_pqrs ADD CONSTRAINT usuarios_pqrs_mercadeo_modulo_check
  CHECK (rol <> 'mercadeo' OR 'mercadeo' = ANY (modulos));

-- ── 2. user_has_module_pqrs(): ¿el usuario actual tiene el módulo? ──
-- true para admin activo o si el módulo está en usuarios_pqrs.modulos.
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
      AND (u.rol = 'admin' OR p_modulo = ANY (u.modulos))
  );
$$;

REVOKE ALL ON FUNCTION public.user_has_module_pqrs(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.user_has_module_pqrs(text) TO authenticated;

-- ── 3. list_equipo_mercadeo(): directorio del equipo con acceso al módulo ──
-- usuarios_pqrs solo deja leer la propia fila a quien no es admin; este RPC
-- permite listar responsables/asignados sin abrir esa lectura. Devuelve
-- también a los inactivos (para resolver nombres de tareas históricas).
-- Vacío si el llamador no tiene el módulo.
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
    AND (u.rol = 'admin' OR 'mercadeo' = ANY (u.modulos))
  ORDER BY 2;
$$;

REVOKE ALL ON FUNCTION public.list_equipo_mercadeo() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_equipo_mercadeo() TO authenticated;

-- ── 4. Endurecer el bucket de adjuntos de PQRS ───────────────
-- Las policies de 0006 solo miraban bucket_id: cualquier usuario autenticado
-- (incluido el equipo de Mercadeo) podía leer/subir. Ahora solo los roles de PQRS.
DROP POLICY IF EXISTS "pqrs_gestion_adjuntos_select" ON storage.objects;
CREATE POLICY "pqrs_gestion_adjuntos_select" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'pqrs-gestion-adjuntos'
    AND get_user_role_pqrs() = ANY (ARRAY['admin','gestor','lector'])
  );

DROP POLICY IF EXISTS "pqrs_gestion_adjuntos_insert" ON storage.objects;
CREATE POLICY "pqrs_gestion_adjuntos_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'pqrs-gestion-adjuntos'
    AND get_user_role_pqrs() = ANY (ARRAY['admin','gestor'])
  );

NOTIFY pgrst, 'reload schema';

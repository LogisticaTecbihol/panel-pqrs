-- ============================================================
-- Cuentas del equipo interno que gestiona PQRS (auth propia,
-- separada de "usuarios" del panel de pedidos).
-- ============================================================

CREATE TABLE IF NOT EXISTS usuarios_pqrs (
  id         uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email      text NOT NULL,
  nombre     text,
  rol        text NOT NULL CHECK (rol IN ('admin','gestor','lector')),
  activo     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE usuarios_pqrs ENABLE ROW LEVEL SECURITY;

-- get_user_role_pqrs(): mismo patrón que get_user_role() del panel de pedidos
-- (supabase/auth_migration.sql), pero contra usuarios_pqrs.
CREATE OR REPLACE FUNCTION public.get_user_role_pqrs()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT rol FROM usuarios_pqrs
  WHERE id = auth.uid() AND activo = true;
$$;

REVOKE ALL ON FUNCTION public.get_user_role_pqrs() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_user_role_pqrs() TO authenticated;

-- SELECT: cada quien ve su propio perfil; admin ve todos.
CREATE POLICY "usuarios_pqrs_select" ON usuarios_pqrs
  FOR SELECT TO authenticated
  USING (id = auth.uid() OR get_user_role_pqrs() = 'admin');

-- UPDATE: solo admin puede cambiar rol/activo de cualquiera (incluido su propio perfil,
-- salvo el caso trivial de auto-degradarse, que queda permitido: es su decisión).
CREATE POLICY "usuarios_pqrs_update" ON usuarios_pqrs
  FOR UPDATE TO authenticated
  USING (get_user_role_pqrs() = 'admin')
  WITH CHECK (get_user_role_pqrs() = 'admin');

-- Sin policy de INSERT/DELETE: el alta de cuentas se hace vía el Edge Function
-- create-user-pqrs (service_role, tras validar que el llamador es admin).

NOTIFY pgrst, 'reload schema';

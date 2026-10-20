-- ============================================================
-- Directorio del equipo de PQRS para el dashboard y el detalle (responsables).
--
-- usuarios_pqrs solo deja leer la propia fila a quien no es admin (policy de 0001), y el dashboard / el
-- detalle de PQRS leían esa tabla directamente para (a) llenar la lista «Responsable» y (b) mostrar el
-- nombre de cada responsable. Resultado para cualquier usuario no admin (gestor, lector o quien tenga
-- el módulo 'pqrs'):
--   - la columna Responsable salía en blanco salvo que el responsable fuera él mismo;
--   - un gestor solo podía asignarse PQRS a sí mismo (la lista traía solo su fila);
--   - al asignar, la bitácora guardaba el evento con el nombre vacío («Asignado a sin asignar»).
--
-- Este RPC (mismo patrón que list_equipo_mercadeo(), 0012) devuelve el directorio sin abrir la lectura
-- de usuarios_pqrs: solo id, nombre (o el correo si no tiene nombre) y si está activo; nada de rol ni
-- módulos. Vacío si el llamador no tiene acceso a PQRS. Incluye:
--   - a quienes tienen acceso a PQRS (admin, gestor, lector o el módulo 'pqrs', 0029);
--   - a cualquiera que figure como responsable de alguna PQRS, aunque después haya cambiado de rol o se
--     haya desactivado, para que su nombre no vuelva a quedar en blanco.
-- Devuelve también a los inactivos (el frontend los usa para resolver nombres, no para la lista).
--
-- Requiere 0012 y 0029. Idempotente. Aplicar con apply_migration (MCP) ANTES de publicar el frontend.
-- No cambia ninguna policy ni el acceso de nadie.
-- ============================================================

CREATE OR REPLACE FUNCTION public.list_equipo_pqrs()
RETURNS TABLE (id uuid, nombre text, activo boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT u.id, COALESCE(NULLIF(u.nombre, ''), u.email) AS nombre, u.activo
  FROM usuarios_pqrs u
  WHERE (select public.user_has_module_pqrs('pqrs'))
    AND (u.rol IN ('admin', 'gestor', 'lector')
         OR 'pqrs' = ANY (u.modulos)
         OR EXISTS (SELECT 1 FROM pqrs p WHERE p.responsable_id = u.id))
  ORDER BY 2;
$$;

REVOKE ALL ON FUNCTION public.list_equipo_pqrs() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_equipo_pqrs() TO authenticated;

NOTIFY pgrst, 'reload schema';

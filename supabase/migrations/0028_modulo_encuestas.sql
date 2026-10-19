-- ============================================================
-- Módulo 'encuestas' (Encuesta de Satisfacción) como módulo aparte.
--
-- Hasta aquí Encuestas salía del ROL: admin / gestor / lector la veían (policy
-- encuestas_satisfaccion_select de 0007), y el rol 'mercadeo' o 'sst' no. Ahora es un módulo
-- más de usuarios_pqrs.modulos, igual que 'mercadeo' y 'sst', pero SIN rol propio:
--   - el admin la ve siempre (user_has_module_pqrs() deja pasar al admin activo);
--   - cualquier otro rol (lector, gestor, mercadeo, sst) la ve solo si el módulo está marcado;
--   - es de SOLO LECTURA: editar, borrar y el historial de ediciones siguen siendo solo de admin
--     (policies de 0007 y 0027, que no se tocan).
-- Cambio de comportamiento a propósito: lector y gestor YA NO ven Encuestas por el solo hecho de
-- su rol; hay que marcarles el módulo (decisión del administrador). Al aplicar no había ningún
-- usuario gestor/lector, así que no se pierde acceso a nadie.
--
-- Requiere 0007, 0012 (user_has_module_pqrs) y 0015. Idempotente. Aplicar con apply_migration (MCP)
-- ANTES de publicar el frontend.
-- ============================================================

-- ── 1. 'encuestas' como módulo válido ────────────────────────
ALTER TABLE public.usuarios_pqrs DROP CONSTRAINT IF EXISTS usuarios_pqrs_modulos_check;
ALTER TABLE public.usuarios_pqrs ADD CONSTRAINT usuarios_pqrs_modulos_check
  CHECK (modulos <@ ARRAY['mercadeo','sst','encuestas']::text[]);

-- ── 2. Lectura de las encuestas: por módulo, ya no por rol ───
-- (select ...) para que el planner evalúe la función una sola vez por consulta (patrón de 0009).
DROP POLICY IF EXISTS "encuestas_satisfaccion_select" ON public.encuestas_satisfaccion;
CREATE POLICY "encuestas_satisfaccion_select" ON public.encuestas_satisfaccion
  FOR SELECT TO authenticated
  USING ((select public.user_has_module_pqrs('encuestas')));

NOTIFY pgrst, 'reload schema';

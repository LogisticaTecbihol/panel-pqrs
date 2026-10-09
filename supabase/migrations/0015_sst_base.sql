-- ============================================================
-- SG-SST (Res. 312 de 2019) en panel-pqrs — FASE 0: base del módulo
--
-- Mismo patrón que Mercadeo (0012-0014): rol 'sst' + módulo 'sst' en
-- usuarios_pqrs.modulos, tablas con prefijo 'sst_', RLS por
-- user_has_module_pqrs('sst'). Las policies de PQRS/Encuestas enumeran roles,
-- así que el rol 'sst' queda excluido solo de los datos de clientes.
--
-- Esta fase crea solo la BASE (sin lógica de autoevaluación, plan ni acciones):
--   - sst_empresas      empresas del holding evaluadas (clase de riesgo, nº de
--                       trabajadores). El GRUPO de estándares (7 / 21 / 60) lo
--                       sella el servidor (Res. 312, art. 3), no el navegador.
--   - sst_trabajadores  registros SIN login (datos personales, Ley 1581/2012:
--                       solo lo mínimo; NINGÚN dato de salud).
--   - sst_evidencias    ENLACES a Drive + metadatos. Las evidencias permanecen en
--                       Google Drive (decisión de la usuaria): no hay bucket de
--                       Storage ni se sube ningún archivo a Supabase.
--
-- Decisiones de diseño:
--   - Valores en códigos ASCII (lección de 0008_fix_tipo_solicitud_acento).
--   - Nada se borra desde el cliente: el DELETE es solo de admin; empresas se
--     desactivan (activa), trabajadores se retiran (fecha_retiro) y las
--     evidencias se marcan 'retirada' (se conserva la trazabilidad).
--   - list_equipo_sst() NO va en esta fase: se agrega en la que haya
--     responsables (plan anual / acciones).
--
-- Idempotente. Aplicar con apply_migration (MCP) ANTES de publicar el frontend.
-- ============================================================

-- ── 1. Rol 'sst' y módulo 'sst' ──────────────────────────────
ALTER TABLE public.usuarios_pqrs DROP CONSTRAINT IF EXISTS usuarios_pqrs_rol_check;
ALTER TABLE public.usuarios_pqrs ADD CONSTRAINT usuarios_pqrs_rol_check
  CHECK (rol IN ('admin','gestor','lector','mercadeo','sst'));

ALTER TABLE public.usuarios_pqrs DROP CONSTRAINT IF EXISTS usuarios_pqrs_modulos_check;
ALTER TABLE public.usuarios_pqrs ADD CONSTRAINT usuarios_pqrs_modulos_check
  CHECK (modulos <@ ARRAY['mercadeo','sst']::text[]);

-- Un usuario con rol 'sst' siempre tiene el módulo (si no, no podría entrar a nada).
ALTER TABLE public.usuarios_pqrs DROP CONSTRAINT IF EXISTS usuarios_pqrs_sst_modulo_check;
ALTER TABLE public.usuarios_pqrs ADD CONSTRAINT usuarios_pqrs_sst_modulo_check
  CHECK (rol <> 'sst' OR 'sst' = ANY (modulos));

-- ── 2. Auditoría común (creado_*/modificado_* con nombre desnormalizado) ──
-- Desnormalizado porque usuarios_pqrs solo deja leer la propia fila a un no-admin.
-- 'Sistema' cuando no hay sesión (p. ej. una carga puntual por SQL).
CREATE OR REPLACE FUNCTION public.sst_set_auditoria()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_nombre text;
BEGIN
  SELECT COALESCE(NULLIF(nombre, ''), email) INTO v_nombre FROM usuarios_pqrs WHERE id = auth.uid();
  v_nombre := COALESCE(v_nombre, 'Sistema');
  IF TG_OP = 'INSERT' THEN
    NEW.creado_por := auth.uid();
    NEW.creado_por_nombre := v_nombre;
    NEW.creado_en := now();
  ELSE
    NEW.creado_por := OLD.creado_por;
    NEW.creado_por_nombre := OLD.creado_por_nombre;
    NEW.creado_en := OLD.creado_en;
  END IF;
  NEW.modificado_por := auth.uid();
  NEW.modificado_por_nombre := v_nombre;
  NEW.modificado_en := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.sst_set_auditoria() FROM PUBLIC, anon, authenticated;

-- ── 3. Empresas ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sst_empresas (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre                text NOT NULL CHECK (char_length(btrim(nombre)) BETWEEN 2 AND 200),
  nit                   text NOT NULL DEFAULT '',
  arl                   text NOT NULL DEFAULT '',
  -- Clases de riesgo reportadas (una empresa puede tener varias, p. ej. I y III).
  clases_riesgo         text[] NOT NULL CHECK (cardinality(clases_riesgo) >= 1
                                               AND clases_riesgo <@ ARRAY['I','II','III','IV','V']::text[]),
  num_trabajadores      integer NOT NULL CHECK (num_trabajadores >= 0),
  -- Sellado por trigger (Res. 312/2019, art. 3): '7' (<=10 trabajadores, riesgo I-III),
  -- '21' (11-50, riesgo I-III) o '60' (>50 trabajadores o cualquier riesgo IV/V).
  -- No contempla las unidades de producción agropecuaria (3 estándares).
  grupo_estandares      text NOT NULL CHECK (grupo_estandares IN ('7','21','60')),
  actividades           text NOT NULL DEFAULT '',
  activa                boolean NOT NULL DEFAULT true,
  observaciones         text NOT NULL DEFAULT '',
  creado_por            uuid,
  creado_por_nombre     text,
  creado_en             timestamptz,
  modificado_por        uuid,
  modificado_por_nombre text,
  modificado_en         timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS sst_empresas_nombre_uq ON public.sst_empresas (lower(btrim(nombre)));
COMMENT ON TABLE public.sst_empresas IS
  'SG-SST. Empresas del holding evaluadas con la Res. 312/2019. grupo_estandares (7/21/60) lo sella el servidor según nº de trabajadores y clase de riesgo.';

CREATE OR REPLACE FUNCTION public.sst_empresas_reglas()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.nombre := btrim(NEW.nombre);
  IF NEW.clases_riesgo && ARRAY['IV','V']::text[] THEN
    NEW.grupo_estandares := '60';
  ELSIF NEW.num_trabajadores <= 10 THEN
    NEW.grupo_estandares := '7';
  ELSIF NEW.num_trabajadores <= 50 THEN
    NEW.grupo_estandares := '21';
  ELSE
    NEW.grupo_estandares := '60';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.sst_empresas_reglas() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_reglas ON public.sst_empresas;
CREATE TRIGGER trg_reglas
  BEFORE INSERT OR UPDATE ON public.sst_empresas
  FOR EACH ROW EXECUTE FUNCTION public.sst_empresas_reglas();

DROP TRIGGER IF EXISTS trg_auditoria ON public.sst_empresas;
CREATE TRIGGER trg_auditoria
  BEFORE INSERT OR UPDATE ON public.sst_empresas
  FOR EACH ROW EXECUTE FUNCTION public.sst_set_auditoria();

-- ── 4. Trabajadores (registros sin login) ────────────────────
CREATE TABLE IF NOT EXISTS public.sst_trabajadores (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa_id            bigint NOT NULL REFERENCES public.sst_empresas(id),
  nombre                text NOT NULL CHECK (char_length(btrim(nombre)) BETWEEN 3 AND 200),
  tipo_documento        text NOT NULL DEFAULT 'CC' CHECK (tipo_documento IN ('CC','CE','PEP','PPT','PAS','OTRO')),
  numero_documento      text NOT NULL CHECK (char_length(btrim(numero_documento)) BETWEEN 3 AND 30),
  cargo                 text NOT NULL DEFAULT '',
  tipo_vinculacion      text NOT NULL DEFAULT 'contrato_trabajo'
                          CHECK (tipo_vinculacion IN ('contrato_trabajo','prestacion_servicios','aprendiz','otro')),
  fecha_ingreso         date,
  fecha_retiro          date,
  creado_por            uuid,
  creado_por_nombre     text,
  creado_en             timestamptz,
  modificado_por        uuid,
  modificado_por_nombre text,
  modificado_en         timestamptz,
  CONSTRAINT sst_trabajadores_fechas_check CHECK (fecha_retiro IS NULL OR fecha_ingreso IS NULL OR fecha_retiro >= fecha_ingreso)
);
CREATE UNIQUE INDEX IF NOT EXISTS sst_trabajadores_doc_uq
  ON public.sst_trabajadores (empresa_id, tipo_documento, btrim(numero_documento));
CREATE INDEX IF NOT EXISTS sst_trabajadores_empresa ON public.sst_trabajadores (empresa_id);
COMMENT ON TABLE public.sst_trabajadores IS
  'SG-SST. Trabajadores (con o sin contrato laboral) como REGISTROS, sin login. Datos personales mínimos (Ley 1581/2012); no almacena datos de salud.';

CREATE OR REPLACE FUNCTION public.sst_trabajadores_reglas()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.nombre := btrim(NEW.nombre);
  NEW.numero_documento := btrim(NEW.numero_documento);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.sst_trabajadores_reglas() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_reglas ON public.sst_trabajadores;
CREATE TRIGGER trg_reglas
  BEFORE INSERT OR UPDATE ON public.sst_trabajadores
  FOR EACH ROW EXECUTE FUNCTION public.sst_trabajadores_reglas();

DROP TRIGGER IF EXISTS trg_auditoria ON public.sst_trabajadores;
CREATE TRIGGER trg_auditoria
  BEFORE INSERT OR UPDATE ON public.sst_trabajadores
  FOR EACH ROW EXECUTE FUNCTION public.sst_set_auditoria();

-- ── 5. Evidencias = enlaces a Drive + metadatos ──────────────
-- Las evidencias permanecen en Google Drive. La BD guarda el enlace, qué es y a qué
-- respalda. entidad_tipo/entidad_id apuntan (sin FK) al registro respaldado; hoy solo
-- existe 'general' (sin entidad) y cada fase siguiente amplía el CHECK.
CREATE TABLE IF NOT EXISTS public.sst_evidencias (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa_id            bigint NOT NULL REFERENCES public.sst_empresas(id),
  entidad_tipo          text NOT NULL DEFAULT 'general' CHECK (entidad_tipo IN ('general')),
  entidad_id            bigint,
  titulo                text NOT NULL CHECK (char_length(btrim(titulo)) BETWEEN 3 AND 200),
  url                   text NOT NULL CHECK (char_length(url) <= 2000
                                             AND url ~* '^https://(drive|docs)\.google\.com/[^[:space:]]+$'),
  tipo                  text NOT NULL DEFAULT 'documento'
                          CHECK (tipo IN ('politica','procedimiento','formato','registro','acta','informe','certificado','foto','documento','otro')),
  codigo_documento      text NOT NULL DEFAULT '',
  version               text NOT NULL DEFAULT '',
  fecha_documento       date,
  vigente_hasta         date,
  -- 'por_revisar' = el enlace pudo romperse (archivo movido o borrado); 'retirada' = ya no se usa.
  estado_enlace         text NOT NULL DEFAULT 'ok' CHECK (estado_enlace IN ('ok','por_revisar','retirada')),
  observaciones         text NOT NULL DEFAULT '',
  creado_por            uuid,
  creado_por_nombre     text,
  creado_en             timestamptz,
  modificado_por        uuid,
  modificado_por_nombre text,
  modificado_en         timestamptz,
  CONSTRAINT sst_evidencias_entidad_check CHECK ((entidad_tipo = 'general') = (entidad_id IS NULL)),
  CONSTRAINT sst_evidencias_fechas_check CHECK (vigente_hasta IS NULL OR fecha_documento IS NULL OR vigente_hasta >= fecha_documento)
);
CREATE INDEX IF NOT EXISTS sst_evidencias_empresa ON public.sst_evidencias (empresa_id);
CREATE INDEX IF NOT EXISTS sst_evidencias_vigente_hasta ON public.sst_evidencias (vigente_hasta) WHERE vigente_hasta IS NOT NULL;
COMMENT ON TABLE public.sst_evidencias IS
  'SG-SST. Evidencias como ENLACES a Google Drive (no se suben archivos a Supabase) con metadatos: tipo, código documental (SST-TEC-...), versión, fecha y vigencia.';

CREATE OR REPLACE FUNCTION public.sst_evidencias_reglas()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.titulo := btrim(NEW.titulo);
  NEW.url := btrim(NEW.url);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.sst_evidencias_reglas() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_reglas ON public.sst_evidencias;
CREATE TRIGGER trg_reglas
  BEFORE INSERT OR UPDATE ON public.sst_evidencias
  FOR EACH ROW EXECUTE FUNCTION public.sst_evidencias_reglas();

DROP TRIGGER IF EXISTS trg_auditoria ON public.sst_evidencias;
CREATE TRIGGER trg_auditoria
  BEFORE INSERT OR UPDATE ON public.sst_evidencias
  FOR EACH ROW EXECUTE FUNCTION public.sst_set_auditoria();

-- ── 6. RLS ───────────────────────────────────────────────────
ALTER TABLE public.sst_empresas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sst_trabajadores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sst_evidencias ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sst_empresas FROM anon;
REVOKE ALL ON public.sst_trabajadores FROM anon;
REVOKE ALL ON public.sst_evidencias FROM anon;

-- El módulo lee, crea y edita; borrar solo admin (en la práctica se desactiva/retira).
DROP POLICY IF EXISTS "sst_empresas_select" ON public.sst_empresas;
CREATE POLICY "sst_empresas_select" ON public.sst_empresas FOR SELECT TO authenticated
  USING ((select public.user_has_module_pqrs('sst')));
DROP POLICY IF EXISTS "sst_empresas_insert" ON public.sst_empresas;
CREATE POLICY "sst_empresas_insert" ON public.sst_empresas FOR INSERT TO authenticated
  WITH CHECK ((select public.user_has_module_pqrs('sst')));
DROP POLICY IF EXISTS "sst_empresas_update" ON public.sst_empresas;
CREATE POLICY "sst_empresas_update" ON public.sst_empresas FOR UPDATE TO authenticated
  USING ((select public.user_has_module_pqrs('sst')))
  WITH CHECK ((select public.user_has_module_pqrs('sst')));
DROP POLICY IF EXISTS "sst_empresas_delete" ON public.sst_empresas;
CREATE POLICY "sst_empresas_delete" ON public.sst_empresas FOR DELETE TO authenticated
  USING (get_user_role_pqrs() = 'admin');

DROP POLICY IF EXISTS "sst_trabajadores_select" ON public.sst_trabajadores;
CREATE POLICY "sst_trabajadores_select" ON public.sst_trabajadores FOR SELECT TO authenticated
  USING ((select public.user_has_module_pqrs('sst')));
DROP POLICY IF EXISTS "sst_trabajadores_insert" ON public.sst_trabajadores;
CREATE POLICY "sst_trabajadores_insert" ON public.sst_trabajadores FOR INSERT TO authenticated
  WITH CHECK ((select public.user_has_module_pqrs('sst')));
DROP POLICY IF EXISTS "sst_trabajadores_update" ON public.sst_trabajadores;
CREATE POLICY "sst_trabajadores_update" ON public.sst_trabajadores FOR UPDATE TO authenticated
  USING ((select public.user_has_module_pqrs('sst')))
  WITH CHECK ((select public.user_has_module_pqrs('sst')));
DROP POLICY IF EXISTS "sst_trabajadores_delete" ON public.sst_trabajadores;
CREATE POLICY "sst_trabajadores_delete" ON public.sst_trabajadores FOR DELETE TO authenticated
  USING (get_user_role_pqrs() = 'admin');

DROP POLICY IF EXISTS "sst_evidencias_select" ON public.sst_evidencias;
CREATE POLICY "sst_evidencias_select" ON public.sst_evidencias FOR SELECT TO authenticated
  USING ((select public.user_has_module_pqrs('sst')));
DROP POLICY IF EXISTS "sst_evidencias_insert" ON public.sst_evidencias;
CREATE POLICY "sst_evidencias_insert" ON public.sst_evidencias FOR INSERT TO authenticated
  WITH CHECK ((select public.user_has_module_pqrs('sst')));
DROP POLICY IF EXISTS "sst_evidencias_update" ON public.sst_evidencias;
CREATE POLICY "sst_evidencias_update" ON public.sst_evidencias FOR UPDATE TO authenticated
  USING ((select public.user_has_module_pqrs('sst')))
  WITH CHECK ((select public.user_has_module_pqrs('sst')));
DROP POLICY IF EXISTS "sst_evidencias_delete" ON public.sst_evidencias;
CREATE POLICY "sst_evidencias_delete" ON public.sst_evidencias FOR DELETE TO authenticated
  USING (get_user_role_pqrs() = 'admin');

NOTIFY pgrst, 'reload schema';

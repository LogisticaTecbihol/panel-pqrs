-- ============================================================
-- RPC: consecutivo/folio atómico por empresa.
-- Mismo patrón que generar_consecutivo_muestra del panel de pedidos
-- (supabase/migrations/add_generar_consecutivo_muestra.sql):
-- SECURITY DEFINER + pg_advisory_xact_lock + MAX(...)+1.
--
-- Se llama SOLO desde el Edge Function ingest-formulario y desde el script
-- de importación histórica, ambos con el cliente service_role -- por eso
-- NO se otorga GRANT EXECUTE a anon ni a authenticated.
-- ============================================================

CREATE OR REPLACE FUNCTION public.generar_consecutivo_pqrs(p_empresa_sigla text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_nuevo int;
BEGIN
  IF p_empresa_sigla IS NULL OR p_empresa_sigla NOT IN ('PARCELAR','GREEN','RESO','IASO','IAS') THEN
    RAISE EXCEPTION 'Empresa inválida: %', p_empresa_sigla;
  END IF;

  -- Serializa las creaciones simultáneas de la misma empresa para que dos
  -- llamadas seguidas no lean el mismo máximo.
  PERFORM pg_advisory_xact_lock(hashtext('pqrs_consec:' || p_empresa_sigla));

  SELECT COALESCE(MAX(split_part(folio, '-', 3)::int), 0) + 1
    INTO v_nuevo
    FROM pqrs
   WHERE empresa_sigla = p_empresa_sigla
     AND split_part(folio, '-', 3) ~ '^[0-9]+$';

  RETURN 'PQRS-' || p_empresa_sigla || '-' || lpad(v_nuevo::text, 6, '0');
END;
$$;

REVOKE ALL ON FUNCTION public.generar_consecutivo_pqrs(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.generar_consecutivo_pqrs(text) TO service_role;

NOTIFY pgrst, 'reload schema';

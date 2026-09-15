-- ============================================================
-- Bucket de Storage para adjuntos de GESTIÓN INTERNA (evidencia de
-- resolución, soportes, correspondencia) -- solo lo suben usuarios
-- authenticated, nunca un cliente externo. Los adjuntos que llega el
-- cliente vía el Form/Drive NUNCA pasan por este bucket (quedan
-- referenciados en pqrs_adjuntos.drive_url).
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('pqrs-gestion-adjuntos', 'pqrs-gestion-adjuntos', false, 26214400) -- 25MB
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "pqrs_gestion_adjuntos_select" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'pqrs-gestion-adjuntos');

CREATE POLICY "pqrs_gestion_adjuntos_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'pqrs-gestion-adjuntos');

CREATE POLICY "pqrs_gestion_adjuntos_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'pqrs-gestion-adjuntos' AND get_user_role_pqrs() = 'admin');

BEGIN;

WITH signer AS (
  SELECT
    p.id AS prescricao_id,
    COALESCE(
      p.signed_by,
      CASE
        WHEN EXISTS (SELECT 1 FROM auth.users au WHERE au.id = p.professional_id)
          THEN p.professional_id
        ELSE NULL
      END,
      CASE
        WHEN EXISTS (SELECT 1 FROM auth.users au WHERE au.id = c.user_id)
          THEN c.user_id
        ELSE NULL
      END
    ) AS resolved_signed_by
  FROM public.prescricoes p
  LEFT JOIN public.clinicas c ON c.id = p.clinic_id
  WHERE lower(COALESCE(p.status, '')) = 'signed'
)
UPDATE public.prescricoes p
SET
  signed_at = COALESCE(p.signed_at, p.created_at, now()),
  signed_by = COALESCE(p.signed_by, s.resolved_signed_by),
  signature_payload = COALESCE(
    p.signature_payload,
    jsonb_build_object(
      'version', 1,
      'source', 'backfill_migration_20260302000004',
      'backfilled_at', now(),
      'notes', 'legacy signed prescription metadata backfilled'
    )
  ),
  signature_hash = COALESCE(
    p.signature_hash,
    md5(
      concat_ws('|',
        p.id::text,
        COALESCE(p.clinic_id::text, ''),
        COALESCE(p.paciente_id::text, ''),
        COALESCE(p.atendimento_id::text, ''),
        COALESCE(p.professional_id::text, ''),
        COALESCE(p.tipo, ''),
        COALESCE(p.conteudo_texto, ''),
        COALESCE(p.created_at::text, ''),
        COALESCE(COALESCE(p.signed_at, p.created_at, now())::text, ''),
        COALESCE(COALESCE(p.signed_by, s.resolved_signed_by)::text, '')
      )
    )
  )
FROM signer s
WHERE p.id = s.prescricao_id
  AND lower(COALESCE(p.status, '')) = 'signed'
  AND (
    p.signed_at IS NULL
    OR p.signed_by IS NULL
    OR p.signature_hash IS NULL
    OR p.signature_payload IS NULL
  );

COMMIT;

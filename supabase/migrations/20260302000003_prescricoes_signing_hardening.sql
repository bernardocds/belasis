BEGIN;

ALTER TABLE IF EXISTS public.prescricoes
  ADD COLUMN IF NOT EXISTS signed_at timestamptz,
  ADD COLUMN IF NOT EXISTS signed_by uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS signature_hash text,
  ADD COLUMN IF NOT EXISTS signature_payload jsonb;

CREATE INDEX IF NOT EXISTS idx_prescricoes_signed_at ON public.prescricoes (signed_at);
CREATE INDEX IF NOT EXISTS idx_prescricoes_signed_by ON public.prescricoes (signed_by);

CREATE OR REPLACE FUNCTION public.lock_signed_prescricao_edits()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- After signature, content and signature metadata become immutable.
  IF lower(COALESCE(OLD.status, '')) = 'signed' THEN
    IF NEW.conteudo_texto IS DISTINCT FROM OLD.conteudo_texto
      OR NEW.tipo IS DISTINCT FROM OLD.tipo
      OR COALESCE(NEW.status, '') IS DISTINCT FROM COALESCE(OLD.status, '')
      OR NEW.signed_at IS DISTINCT FROM OLD.signed_at
      OR NEW.signed_by IS DISTINCT FROM OLD.signed_by
      OR NEW.signature_hash IS DISTINCT FROM OLD.signature_hash
      OR NEW.signature_payload IS DISTINCT FROM OLD.signature_payload THEN
      RAISE EXCEPTION 'Prescrição assinada não pode ser alterada.';
    END IF;

    RETURN NEW;
  END IF;

  -- To mark as signed, immutable signature metadata is mandatory.
  IF lower(COALESCE(NEW.status, '')) = 'signed' THEN
    IF NEW.signed_at IS NULL OR NEW.signed_by IS NULL OR COALESCE(NEW.signature_hash, '') = '' OR NEW.signature_payload IS NULL THEN
      RAISE EXCEPTION 'Assinatura inválida: signed_at, signed_by, signature_hash e signature_payload são obrigatórios.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lock_signed_prescricao_edits ON public.prescricoes;

CREATE TRIGGER trg_lock_signed_prescricao_edits
BEFORE UPDATE ON public.prescricoes
FOR EACH ROW
EXECUTE FUNCTION public.lock_signed_prescricao_edits();

COMMIT;

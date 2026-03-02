BEGIN;

ALTER TABLE IF EXISTS public.financeiro_lancamentos
  ADD COLUMN IF NOT EXISTS repasse_status text,
  ADD COLUMN IF NOT EXISTS repasse_paid_at timestamptz,
  ADD COLUMN IF NOT EXISTS repasse_paid_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS repasse_reference text;

UPDATE public.financeiro_lancamentos
SET repasse_status = CASE
  WHEN status <> 'pago' THEN 'nao_aplicavel'
  WHEN professional_id IS NULL THEN 'nao_aplicavel'
  WHEN COALESCE(percentual_repasse, 0) <= 0 THEN 'nao_aplicavel'
  ELSE 'pendente'
END
WHERE repasse_status IS NULL;

ALTER TABLE public.financeiro_lancamentos
  ALTER COLUMN repasse_status SET DEFAULT 'pendente';

ALTER TABLE public.financeiro_lancamentos
  ALTER COLUMN repasse_status SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'financeiro_lancamentos_repasse_status_check'
  ) THEN
    ALTER TABLE public.financeiro_lancamentos
      ADD CONSTRAINT financeiro_lancamentos_repasse_status_check
      CHECK (repasse_status IN ('pendente', 'liquidado', 'nao_aplicavel'));
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_financeiro_lancamentos_repasse_status
  ON public.financeiro_lancamentos (repasse_status);

CREATE OR REPLACE FUNCTION public.normalize_financeiro_repasse_status()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_repasse_valor numeric;
BEGIN
  v_repasse_valor := round((COALESCE(NEW.valor_bruto, 0) * COALESCE(NEW.percentual_repasse, 0) / 100.0)::numeric, 2);

  IF NEW.status <> 'pago'
    OR NEW.professional_id IS NULL
    OR v_repasse_valor <= 0 THEN
    NEW.repasse_status := 'nao_aplicavel';
    NEW.repasse_paid_at := NULL;
    NEW.repasse_paid_by := NULL;
    NEW.repasse_reference := NULL;
    RETURN NEW;
  END IF;

  IF NEW.repasse_status IS NULL OR NEW.repasse_status = 'nao_aplicavel' THEN
    NEW.repasse_status := 'pendente';
  END IF;

  IF NEW.repasse_status = 'liquidado' THEN
    IF NEW.repasse_paid_at IS NULL THEN
      NEW.repasse_paid_at := now();
    END IF;
  ELSE
    NEW.repasse_paid_at := NULL;
    NEW.repasse_paid_by := NULL;
    NEW.repasse_reference := NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_normalize_financeiro_repasse_status ON public.financeiro_lancamentos;

CREATE TRIGGER trg_normalize_financeiro_repasse_status
BEFORE INSERT OR UPDATE ON public.financeiro_lancamentos
FOR EACH ROW
EXECUTE FUNCTION public.normalize_financeiro_repasse_status();

COMMIT;

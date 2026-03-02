BEGIN;

ALTER TABLE IF EXISTS public.configuracoes_clinica
  ADD COLUMN IF NOT EXISTS memed_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS memed_launch_url text;

CREATE OR REPLACE FUNCTION public.current_user_has_clinic_role(
  p_clinic_id uuid,
  p_roles text[] DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $function$
  SELECT auth.uid() IS NOT NULL
    AND (
      EXISTS (
        SELECT 1
        FROM public.clinicas c
        WHERE c.id = p_clinic_id
          AND c.user_id = auth.uid()
      )
      OR EXISTS (
        SELECT 1
        FROM public.clinic_users cu
        WHERE cu.clinic_id = p_clinic_id
          AND cu.user_id = auth.uid()
          AND (p_roles IS NULL OR cu.role = ANY(p_roles))
      )
    );
$function$;

GRANT EXECUTE ON FUNCTION public.current_user_has_clinic_role(uuid, text[]) TO authenticated;

CREATE TABLE IF NOT EXISTS public.financeiro_regras_repasse (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES public.clinicas(id) ON DELETE CASCADE,
  professional_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  categoria text NOT NULL DEFAULT 'consulta',
  percentual_repasse numeric(5,2) NOT NULL DEFAULT 0,
  ativo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, professional_id, categoria)
);

CREATE TABLE IF NOT EXISTS public.financeiro_lancamentos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES public.clinicas(id) ON DELETE CASCADE,
  paciente_id uuid REFERENCES public.pacientes(id) ON DELETE SET NULL,
  agendamento_id uuid REFERENCES public.agendamentos(id) ON DELETE SET NULL,
  atendimento_id uuid REFERENCES public.atendimentos(id) ON DELETE SET NULL,
  professional_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  procedimento_id uuid REFERENCES public.procedimentos(id) ON DELETE SET NULL,
  descricao text NOT NULL,
  categoria text NOT NULL DEFAULT 'consulta',
  forma_pagamento text NOT NULL DEFAULT 'pix',
  status text NOT NULL DEFAULT 'pago',
  valor_bruto numeric(12,2) NOT NULL,
  percentual_repasse numeric(5,2) NOT NULL DEFAULT 0,
  valor_repasse numeric(12,2) GENERATED ALWAYS AS (
    round((valor_bruto * percentual_repasse / 100.0)::numeric, 2)
  ) STORED,
  valor_clinica numeric(12,2) GENERATED ALWAYS AS (
    round((valor_bruto - (valor_bruto * percentual_repasse / 100.0))::numeric, 2)
  ) STORED,
  pago_em timestamptz NOT NULL DEFAULT now(),
  observacoes text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'financeiro_regras_repasse_percentual_check'
  ) THEN
    ALTER TABLE public.financeiro_regras_repasse
      ADD CONSTRAINT financeiro_regras_repasse_percentual_check
      CHECK (percentual_repasse >= 0 AND percentual_repasse <= 100);
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'financeiro_lancamentos_percentual_check'
  ) THEN
    ALTER TABLE public.financeiro_lancamentos
      ADD CONSTRAINT financeiro_lancamentos_percentual_check
      CHECK (percentual_repasse >= 0 AND percentual_repasse <= 100);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'financeiro_lancamentos_valor_bruto_check'
  ) THEN
    ALTER TABLE public.financeiro_lancamentos
      ADD CONSTRAINT financeiro_lancamentos_valor_bruto_check
      CHECK (valor_bruto >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'financeiro_lancamentos_status_check'
  ) THEN
    ALTER TABLE public.financeiro_lancamentos
      ADD CONSTRAINT financeiro_lancamentos_status_check
      CHECK (status IN ('pago', 'pendente', 'estornado'));
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_financeiro_lancamentos_clinic_pago_em
  ON public.financeiro_lancamentos (clinic_id, pago_em DESC);

CREATE INDEX IF NOT EXISTS idx_financeiro_lancamentos_professional
  ON public.financeiro_lancamentos (professional_id);

CREATE INDEX IF NOT EXISTS idx_financeiro_lancamentos_status
  ON public.financeiro_lancamentos (status);

CREATE INDEX IF NOT EXISTS idx_financeiro_regras_repasse_clinic_prof
  ON public.financeiro_regras_repasse (clinic_id, professional_id);

ALTER TABLE public.financeiro_lancamentos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.financeiro_regras_repasse ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS financeiro_lancamentos_select ON public.financeiro_lancamentos;
DROP POLICY IF EXISTS financeiro_lancamentos_insert ON public.financeiro_lancamentos;
DROP POLICY IF EXISTS financeiro_lancamentos_update ON public.financeiro_lancamentos;
DROP POLICY IF EXISTS financeiro_lancamentos_delete ON public.financeiro_lancamentos;

DROP POLICY IF EXISTS financeiro_regras_repasse_select ON public.financeiro_regras_repasse;
DROP POLICY IF EXISTS financeiro_regras_repasse_insert ON public.financeiro_regras_repasse;
DROP POLICY IF EXISTS financeiro_regras_repasse_update ON public.financeiro_regras_repasse;
DROP POLICY IF EXISTS financeiro_regras_repasse_delete ON public.financeiro_regras_repasse;

CREATE POLICY financeiro_lancamentos_select
ON public.financeiro_lancamentos
FOR SELECT
TO authenticated
USING (
  public.current_user_has_clinic_role(clinic_id, NULL)
);

CREATE POLICY financeiro_lancamentos_insert
ON public.financeiro_lancamentos
FOR INSERT
TO authenticated
WITH CHECK (
  public.current_user_has_clinic_role(clinic_id, ARRAY['owner', 'admin', 'attendant'])
);

CREATE POLICY financeiro_lancamentos_update
ON public.financeiro_lancamentos
FOR UPDATE
TO authenticated
USING (
  public.current_user_has_clinic_role(clinic_id, ARRAY['owner', 'admin', 'attendant'])
)
WITH CHECK (
  public.current_user_has_clinic_role(clinic_id, ARRAY['owner', 'admin', 'attendant'])
);

CREATE POLICY financeiro_lancamentos_delete
ON public.financeiro_lancamentos
FOR DELETE
TO authenticated
USING (
  public.current_user_has_clinic_role(clinic_id, ARRAY['owner', 'admin'])
);

CREATE POLICY financeiro_regras_repasse_select
ON public.financeiro_regras_repasse
FOR SELECT
TO authenticated
USING (
  public.current_user_has_clinic_role(clinic_id, NULL)
);

CREATE POLICY financeiro_regras_repasse_insert
ON public.financeiro_regras_repasse
FOR INSERT
TO authenticated
WITH CHECK (
  public.current_user_has_clinic_role(clinic_id, ARRAY['owner', 'admin'])
);

CREATE POLICY financeiro_regras_repasse_update
ON public.financeiro_regras_repasse
FOR UPDATE
TO authenticated
USING (
  public.current_user_has_clinic_role(clinic_id, ARRAY['owner', 'admin'])
)
WITH CHECK (
  public.current_user_has_clinic_role(clinic_id, ARRAY['owner', 'admin'])
);

CREATE POLICY financeiro_regras_repasse_delete
ON public.financeiro_regras_repasse
FOR DELETE
TO authenticated
USING (
  public.current_user_has_clinic_role(clinic_id, ARRAY['owner', 'admin'])
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.financeiro_lancamentos TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.financeiro_regras_repasse TO authenticated;

CREATE OR REPLACE FUNCTION public.get_financeiro_repasse_resumo(
  p_clinic_id uuid,
  p_start timestamptz DEFAULT NULL,
  p_end timestamptz DEFAULT NULL
)
RETURNS TABLE (
  professional_id uuid,
  professional_email text,
  lancamentos_count bigint,
  valor_bruto_total numeric,
  valor_repasse_total numeric,
  valor_clinica_total numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $function$
BEGIN
  IF NOT public.current_user_has_clinic_role(p_clinic_id, ARRAY['owner', 'admin', 'doctor', 'attendant']) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    fl.professional_id,
    au.email::text AS professional_email,
    COUNT(*)::bigint AS lancamentos_count,
    COALESCE(SUM(fl.valor_bruto), 0)::numeric AS valor_bruto_total,
    COALESCE(SUM(fl.valor_repasse), 0)::numeric AS valor_repasse_total,
    COALESCE(SUM(fl.valor_clinica), 0)::numeric AS valor_clinica_total
  FROM public.financeiro_lancamentos fl
  LEFT JOIN auth.users au ON au.id = fl.professional_id
  WHERE fl.clinic_id = p_clinic_id
    AND fl.status = 'pago'
    AND fl.pago_em >= COALESCE(p_start, '1970-01-01'::timestamptz)
    AND fl.pago_em <= COALESCE(p_end, now())
  GROUP BY fl.professional_id, au.email
  ORDER BY valor_repasse_total DESC;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_financeiro_repasse_resumo(uuid, timestamptz, timestamptz) TO authenticated;

COMMIT;

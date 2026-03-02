BEGIN;

CREATE OR REPLACE FUNCTION public.default_permission_for_role(
  p_role text,
  p_permission text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
  v_role text := lower(COALESCE(p_role, ''));
  v_permission text := COALESCE(p_permission, '');
BEGIN
  IF v_role IN ('owner', 'admin') THEN
    RETURN true;
  END IF;

  IF v_role = 'doctor' THEN
    RETURN v_permission = ANY (ARRAY[
      'dashboard.view',
      'schedule.view',
      'patients.view',
      'encounters.view',
      'encounters.edit',
      'prescriptions.manage',
      'memed.launch',
      'procedimentos.view',
      'relatorios.view',
      'settings.view'
    ]);
  END IF;

  IF v_role = 'attendant' THEN
    RETURN v_permission = ANY (ARRAY[
      'dashboard.view',
      'schedule.view',
      'patients.view',
      'conversas.view',
      'financeiro.view',
      'financeiro.manage',
      'relatorios.view',
      'settings.view'
    ]);
  END IF;

  RETURN false;
END;
$function$;

CREATE OR REPLACE FUNCTION public.current_user_has_permission(
  p_clinic_id uuid,
  p_permission text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $function$
DECLARE
  v_role text;
  v_custom_permissions jsonb := '{}'::jsonb;
  v_raw text;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.clinicas c
    WHERE c.id = p_clinic_id
      AND c.user_id = auth.uid()
  ) THEN
    RETURN true;
  END IF;

  SELECT cu.role::text, COALESCE(cu.custom_permissions, '{}'::jsonb)
  INTO v_role, v_custom_permissions
  FROM public.clinic_users cu
  WHERE cu.clinic_id = p_clinic_id
    AND cu.user_id = auth.uid()
  LIMIT 1;

  IF v_role IS NULL THEN
    RETURN false;
  END IF;

  IF v_custom_permissions ? p_permission THEN
    v_raw := lower(COALESCE(v_custom_permissions ->> p_permission, ''));
    IF v_raw IN ('true', 'false') THEN
      RETURN v_raw = 'true';
    END IF;
  END IF;

  RETURN public.default_permission_for_role(v_role, p_permission);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.default_permission_for_role(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_user_has_permission(uuid, text) TO authenticated;

-- Configurações: leitura por permissionamento de settings/memed, escrita só com settings.manage.
DROP POLICY IF EXISTS configuracoes_clinica_select ON public.configuracoes_clinica;
DROP POLICY IF EXISTS configuracoes_clinica_insert ON public.configuracoes_clinica;
DROP POLICY IF EXISTS configuracoes_clinica_update ON public.configuracoes_clinica;
DROP POLICY IF EXISTS configuracoes_clinica_delete ON public.configuracoes_clinica;

CREATE POLICY configuracoes_clinica_select
ON public.configuracoes_clinica
FOR SELECT
TO authenticated
USING (
  public.current_user_has_permission(clinic_id, 'settings.view')
  OR public.current_user_has_permission(clinic_id, 'memed.launch')
);

CREATE POLICY configuracoes_clinica_insert
ON public.configuracoes_clinica
FOR INSERT
TO authenticated
WITH CHECK (
  public.current_user_has_permission(clinic_id, 'settings.manage')
);

CREATE POLICY configuracoes_clinica_update
ON public.configuracoes_clinica
FOR UPDATE
TO authenticated
USING (
  public.current_user_has_permission(clinic_id, 'settings.manage')
)
WITH CHECK (
  public.current_user_has_permission(clinic_id, 'settings.manage')
);

CREATE POLICY configuracoes_clinica_delete
ON public.configuracoes_clinica
FOR DELETE
TO authenticated
USING (
  public.current_user_has_permission(clinic_id, 'settings.manage')
);

-- Financeiro alinhado com permissionamento dinâmico.
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
  public.current_user_has_permission(clinic_id, 'financeiro.view')
  OR public.current_user_has_permission(clinic_id, 'relatorios.financeiro_view')
);

CREATE POLICY financeiro_lancamentos_insert
ON public.financeiro_lancamentos
FOR INSERT
TO authenticated
WITH CHECK (
  public.current_user_has_permission(clinic_id, 'financeiro.manage')
);

CREATE POLICY financeiro_lancamentos_update
ON public.financeiro_lancamentos
FOR UPDATE
TO authenticated
USING (
  public.current_user_has_permission(clinic_id, 'financeiro.manage')
)
WITH CHECK (
  public.current_user_has_permission(clinic_id, 'financeiro.manage')
);

CREATE POLICY financeiro_lancamentos_delete
ON public.financeiro_lancamentos
FOR DELETE
TO authenticated
USING (
  public.current_user_has_permission(clinic_id, 'financeiro.manage')
);

CREATE POLICY financeiro_regras_repasse_select
ON public.financeiro_regras_repasse
FOR SELECT
TO authenticated
USING (
  public.current_user_has_permission(clinic_id, 'financeiro.view')
  OR public.current_user_has_permission(clinic_id, 'relatorios.financeiro_view')
  OR public.current_user_has_permission(clinic_id, 'financeiro.repasses_manage')
);

CREATE POLICY financeiro_regras_repasse_insert
ON public.financeiro_regras_repasse
FOR INSERT
TO authenticated
WITH CHECK (
  public.current_user_has_permission(clinic_id, 'financeiro.repasses_manage')
);

CREATE POLICY financeiro_regras_repasse_update
ON public.financeiro_regras_repasse
FOR UPDATE
TO authenticated
USING (
  public.current_user_has_permission(clinic_id, 'financeiro.repasses_manage')
)
WITH CHECK (
  public.current_user_has_permission(clinic_id, 'financeiro.repasses_manage')
);

CREATE POLICY financeiro_regras_repasse_delete
ON public.financeiro_regras_repasse
FOR DELETE
TO authenticated
USING (
  public.current_user_has_permission(clinic_id, 'financeiro.repasses_manage')
);

-- RPCs sensíveis de equipe também passam pelo permissionamento dinâmico.
CREATE OR REPLACE FUNCTION public.create_invited_user(
  p_email text,
  p_password text,
  p_name text,
  p_role text,
  p_clinic_id uuid
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, extensions
AS $function$
DECLARE
  v_user_id uuid;
  v_can_manage_team boolean;
  v_actor_role text;
  v_encrypted_password text;
  v_current_users int;
  v_max_users int;
BEGIN
  v_can_manage_team := public.current_user_has_permission(p_clinic_id, 'team.manage');

  IF NOT v_can_manage_team THEN
    RETURN json_build_object('error', 'Sem permissão para adicionar usuários nesta clínica');
  END IF;

  SELECT cu.role::text
  INTO v_actor_role
  FROM public.clinic_users cu
  WHERE cu.clinic_id = p_clinic_id
    AND cu.user_id = auth.uid()
  LIMIT 1;

  IF v_actor_role IS NULL AND EXISTS (
    SELECT 1 FROM public.clinicas c WHERE c.id = p_clinic_id AND c.user_id = auth.uid()
  ) THEN
    v_actor_role := 'owner';
  END IF;

  IF p_role NOT IN ('owner', 'admin', 'doctor', 'attendant') THEN
    RETURN json_build_object('error', 'Cargo inválido');
  END IF;

  IF v_actor_role <> 'owner' AND p_role IN ('owner', 'admin') THEN
    RETURN json_build_object('error', 'Somente owner pode convidar owner/admin');
  END IF;

  SELECT count(*) INTO v_current_users
  FROM public.clinic_users
  WHERE clinic_id = p_clinic_id;

  SELECT COALESCE(c.custom_max_users, p.max_users, 3) INTO v_max_users
  FROM public.clinicas c
  LEFT JOIN public.plans p ON c.plano = p.id
  WHERE c.id = p_clinic_id;

  IF v_current_users >= v_max_users THEN
    RETURN json_build_object('error', 'Limite de acessos (seats) do seu plano atingido. Contate o suporte para aumentar.');
  END IF;

  IF EXISTS (SELECT 1 FROM auth.users WHERE email = p_email) THEN
    SELECT id INTO v_user_id FROM auth.users WHERE email = p_email;

    IF EXISTS (
      SELECT 1 FROM public.clinic_users
      WHERE clinic_id = p_clinic_id
        AND user_id = v_user_id
    ) THEN
      RETURN json_build_object('error', 'Usuário já pertence a esta clínica');
    END IF;

    INSERT INTO public.clinic_users (clinic_id, user_id, role)
    VALUES (p_clinic_id, v_user_id, p_role);

    RETURN json_build_object('success', true, 'message', 'Usuário já existia no sistema e foi vinculado à clínica');
  END IF;

  v_user_id := gen_random_uuid();
  v_encrypted_password := extensions.crypt(p_password, extensions.gen_salt('bf'));

  INSERT INTO auth.users (
    id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change
  ) VALUES (
    v_user_id,
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    p_email,
    v_encrypted_password,
    now(),
    '{"provider": "email", "providers": ["email"]}',
    json_build_object('nome', p_name, 'force_password_change', true),
    now(), now(), '', '', '', ''
  );

  INSERT INTO auth.identities (
    id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at
  ) VALUES (
    v_user_id,
    v_user_id,
    format('{"sub": "%s", "email": "%s"}', v_user_id, p_email)::jsonb,
    'email',
    p_email,
    now(),
    now(),
    now()
  );

  INSERT INTO public.clinic_users (clinic_id, user_id, role)
  VALUES (p_clinic_id, v_user_id, p_role);

  INSERT INTO public.clinic_invites (clinic_id, email, role, temp_password, temp_password_hash)
  VALUES (
    p_clinic_id,
    p_email,
    p_role,
    NULL,
    extensions.crypt(p_password, extensions.gen_salt('bf'))
  );

  RETURN json_build_object('success', true, 'user_id', v_user_id);
EXCEPTION
  WHEN OTHERS THEN
    RETURN json_build_object('error', SQLERRM);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_clinic_professionals_report(p_clinic_id uuid)
RETURNS TABLE (
  user_id uuid,
  email text,
  role text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN;
  END IF;

  IF NOT (
    public.current_user_has_permission(p_clinic_id, 'schedule.view')
    OR public.current_user_has_permission(p_clinic_id, 'relatorios.view')
    OR public.current_user_has_permission(p_clinic_id, 'financeiro.view')
    OR public.current_user_has_permission(p_clinic_id, 'financeiro.repasses_manage')
    OR public.current_user_has_permission(p_clinic_id, 'settings.view')
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    cu.user_id,
    au.email::text,
    cu.role::text
  FROM public.clinic_users cu
  JOIN auth.users au ON au.id = cu.user_id
  WHERE cu.clinic_id = p_clinic_id
    AND cu.role IN ('owner', 'admin', 'doctor');
END;
$function$;

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
  IF NOT (
    public.current_user_has_permission(p_clinic_id, 'financeiro.view')
    OR public.current_user_has_permission(p_clinic_id, 'relatorios.financeiro_view')
    OR public.current_user_has_permission(p_clinic_id, 'financeiro.repasses_manage')
  ) THEN
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

-- Triggers defensivos para escrita sensível.
CREATE OR REPLACE FUNCTION public.assert_atendimento_write_permission()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, auth
AS $function$
DECLARE
  v_clinic_id uuid;
BEGIN
  IF auth.uid() IS NULL OR current_setting('request.jwt.claim.role', true) = 'service_role' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  v_clinic_id := COALESCE(NEW.clinic_id, OLD.clinic_id);
  IF NOT public.current_user_has_permission(v_clinic_id, 'encounters.edit') THEN
    RAISE EXCEPTION 'Sem permissão para alterar prontuário';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_assert_atendimento_write_permission ON public.atendimentos;
CREATE TRIGGER trg_assert_atendimento_write_permission
BEFORE INSERT OR UPDATE OR DELETE ON public.atendimentos
FOR EACH ROW
EXECUTE FUNCTION public.assert_atendimento_write_permission();

CREATE OR REPLACE FUNCTION public.assert_prescricao_write_permission()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, auth
AS $function$
DECLARE
  v_clinic_id uuid;
BEGIN
  IF auth.uid() IS NULL OR current_setting('request.jwt.claim.role', true) = 'service_role' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  v_clinic_id := COALESCE(NEW.clinic_id, OLD.clinic_id);
  IF NOT public.current_user_has_permission(v_clinic_id, 'prescriptions.manage') THEN
    RAISE EXCEPTION 'Sem permissão para alterar prescrições';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_assert_prescricao_write_permission ON public.prescricoes;
CREATE TRIGGER trg_assert_prescricao_write_permission
BEFORE INSERT OR UPDATE OR DELETE ON public.prescricoes
FOR EACH ROW
EXECUTE FUNCTION public.assert_prescricao_write_permission();

CREATE OR REPLACE FUNCTION public.assert_clinic_invite_write_permission()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, auth
AS $function$
DECLARE
  v_clinic_id uuid;
BEGIN
  IF auth.uid() IS NULL OR current_setting('request.jwt.claim.role', true) = 'service_role' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  v_clinic_id := COALESCE(NEW.clinic_id, OLD.clinic_id);
  IF NOT public.current_user_has_permission(v_clinic_id, 'team.manage') THEN
    RAISE EXCEPTION 'Sem permissão para gerenciar convites';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_assert_clinic_invite_write_permission ON public.clinic_invites;
CREATE TRIGGER trg_assert_clinic_invite_write_permission
BEFORE INSERT OR UPDATE OR DELETE ON public.clinic_invites
FOR EACH ROW
EXECUTE FUNCTION public.assert_clinic_invite_write_permission();

GRANT EXECUTE ON FUNCTION public.get_clinic_professionals_report(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_financeiro_repasse_resumo(uuid, timestamptz, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_invited_user(text, text, text, text, uuid) TO authenticated;

COMMIT;

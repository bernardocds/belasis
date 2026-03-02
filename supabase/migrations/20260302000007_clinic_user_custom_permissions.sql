BEGIN;

ALTER TABLE IF EXISTS public.clinic_users
  ADD COLUMN IF NOT EXISTS custom_permissions jsonb;

CREATE OR REPLACE FUNCTION public.get_clinic_members_with_permissions(p_clinic_id uuid)
RETURNS TABLE (
  user_id uuid,
  email text,
  role text,
  custom_permissions jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $function$
DECLARE
  v_actor_role text;
  v_actor_custom_permissions jsonb;
  v_can_manage boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN;
  END IF;

  SELECT cu.role::text, COALESCE(cu.custom_permissions, '{}'::jsonb)
  INTO v_actor_role, v_actor_custom_permissions
  FROM public.clinic_users cu
  WHERE cu.clinic_id = p_clinic_id
    AND cu.user_id = auth.uid()
  LIMIT 1;

  IF v_actor_role IS NULL AND EXISTS (
    SELECT 1
    FROM public.clinicas c
    WHERE c.id = p_clinic_id
      AND c.user_id = auth.uid()
  ) THEN
    v_actor_role := 'owner';
    v_actor_custom_permissions := '{}'::jsonb;
  END IF;

  v_can_manage := false;

  IF v_actor_role = 'owner' THEN
    v_can_manage := true;
  ELSIF v_actor_role = 'admin' THEN
    IF v_actor_custom_permissions ? 'team.manage' THEN
      v_can_manage := lower(COALESCE(v_actor_custom_permissions ->> 'team.manage', '')) = 'true';
    ELSE
      v_can_manage := true;
    END IF;
  ELSIF v_actor_custom_permissions ? 'team.manage' THEN
    v_can_manage := lower(COALESCE(v_actor_custom_permissions ->> 'team.manage', '')) = 'true';
  END IF;

  IF NOT v_can_manage THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    cu.user_id,
    au.email::text,
    cu.role::text,
    cu.custom_permissions
  FROM public.clinic_users cu
  LEFT JOIN auth.users au ON au.id = cu.user_id
  WHERE cu.clinic_id = p_clinic_id
  ORDER BY COALESCE(au.email::text, cu.user_id::text);
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_clinic_user_permissions(
  p_clinic_id uuid,
  p_target_user_id uuid,
  p_custom_permissions jsonb DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $function$
DECLARE
  v_actor_role text;
  v_actor_custom_permissions jsonb := '{}'::jsonb;
  v_actor_can_manage_team boolean := false;
  v_target_role text;
  v_sanitized jsonb := '{}'::jsonb;
  v_key text;
  v_raw text;
  v_allowed_keys text[] := ARRAY[
    'dashboard.view',
    'schedule.view',
    'patients.view',
    'encounters.view',
    'encounters.edit',
    'prescriptions.manage',
    'memed.launch',
    'conversas.view',
    'procedimentos.view',
    'financeiro.view',
    'financeiro.manage',
    'financeiro.repasses_manage',
    'relatorios.view',
    'relatorios.financeiro_view',
    'whatsapp.manage',
    'settings.view',
    'settings.manage',
    'team.manage',
    'plans.manage'
  ];
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN json_build_object('error', 'Unauthorized');
  END IF;

  SELECT cu.role::text, COALESCE(cu.custom_permissions, '{}'::jsonb)
  INTO v_actor_role, v_actor_custom_permissions
  FROM public.clinic_users cu
  WHERE cu.clinic_id = p_clinic_id
    AND cu.user_id = auth.uid()
  LIMIT 1;

  IF v_actor_role IS NULL AND EXISTS (
    SELECT 1 FROM public.clinicas c WHERE c.id = p_clinic_id AND c.user_id = auth.uid()
  ) THEN
    v_actor_role := 'owner';
  END IF;

  IF v_actor_role = 'owner' THEN
    v_actor_can_manage_team := true;
  ELSIF v_actor_role = 'admin' THEN
    IF v_actor_custom_permissions ? 'team.manage' THEN
      v_actor_can_manage_team := lower(COALESCE(v_actor_custom_permissions ->> 'team.manage', '')) = 'true';
    ELSE
      v_actor_can_manage_team := true;
    END IF;
  ELSIF v_actor_custom_permissions ? 'team.manage' THEN
    v_actor_can_manage_team := lower(COALESCE(v_actor_custom_permissions ->> 'team.manage', '')) = 'true';
  END IF;

  IF NOT v_actor_can_manage_team THEN
    RETURN json_build_object('error', 'Sem permissão para alterar permissões');
  END IF;

  SELECT cu.role::text
  INTO v_target_role
  FROM public.clinic_users cu
  WHERE cu.clinic_id = p_clinic_id
    AND cu.user_id = p_target_user_id
  LIMIT 1;

  IF v_target_role IS NULL THEN
    RETURN json_build_object('error', 'Usuário não pertence à clínica');
  END IF;

  IF v_actor_role <> 'owner' AND v_target_role IN ('owner', 'admin') THEN
    RETURN json_build_object('error', 'Somente owner pode alterar permissões de owner/admin');
  END IF;

  IF v_target_role = 'owner' AND auth.uid() <> p_target_user_id AND v_actor_role <> 'owner' THEN
    RETURN json_build_object('error', 'Somente owner pode alterar permissões do owner');
  END IF;

  IF p_custom_permissions IS NULL OR jsonb_typeof(p_custom_permissions) <> 'object' THEN
    UPDATE public.clinic_users
    SET custom_permissions = NULL
    WHERE clinic_id = p_clinic_id
      AND user_id = p_target_user_id;

    RETURN json_build_object('success', true, 'custom_permissions', NULL);
  END IF;

  FOREACH v_key IN ARRAY v_allowed_keys LOOP
    IF p_custom_permissions ? v_key THEN
      v_raw := lower(COALESCE(p_custom_permissions ->> v_key, ''));
      IF v_raw IN ('true', 'false') THEN
        v_sanitized := v_sanitized || jsonb_build_object(v_key, v_raw = 'true');
      END IF;
    END IF;
  END LOOP;

  UPDATE public.clinic_users
  SET custom_permissions = CASE WHEN v_sanitized = '{}'::jsonb THEN NULL ELSE v_sanitized END
  WHERE clinic_id = p_clinic_id
    AND user_id = p_target_user_id;

  RETURN json_build_object(
    'success', true,
    'custom_permissions', CASE WHEN v_sanitized = '{}'::jsonb THEN NULL ELSE v_sanitized END
  );
EXCEPTION
  WHEN OTHERS THEN
    RETURN json_build_object('error', SQLERRM);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_clinic_members_with_permissions(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_clinic_user_permissions(uuid, uuid, jsonb) TO authenticated;

COMMIT;

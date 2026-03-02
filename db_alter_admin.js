const { Client } = require('pg');
const fs = require('fs');

async function run() {
    const client = new Client({
        connectionString: (process.env.DATABASE_URL || '')
    });
    await client.connect();

    const sql = `
CREATE TABLE IF NOT EXISTS super_admins (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE
);

-- (To ensure the creator has access, we can insert the first admin manually later, or if there's no admin, grant access)
-- Or we just check if the email is "bernardo..." etc.

CREATE OR REPLACE FUNCTION public.create_invited_user(
  p_email text, 
  p_password text, 
  p_name text, 
  p_role text, 
  p_clinic_id uuid
) RETURNS json LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user_id uuid;
  v_is_admin boolean;
  v_encrypted_password text;
  v_current_users int;
  v_max_users int;
BEGIN
  -- 1. Verify if the calling user is an admin or owner of p_clinic_id
  SELECT EXISTS (
    SELECT 1 FROM public.clinic_users 
    WHERE clinic_id = p_clinic_id 
    AND user_id = auth.uid() 
    AND role IN ('admin', 'owner')
  ) INTO v_is_admin;

  IF NOT v_is_admin THEN
    RETURN json_build_object('error', 'Sem permissão para adicionar usuários nesta clínica');
  END IF;

  -- 1.5. Check limits
  SELECT count(*) INTO v_current_users FROM public.clinic_users WHERE clinic_id = p_clinic_id;

  SELECT COALESCE(c.custom_max_users, p.max_users, 3) INTO v_max_users
  FROM public.clinicas c 
  LEFT JOIN public.plans p ON c.plano = p.id
  WHERE c.id = p_clinic_id;

  IF v_current_users >= v_max_users THEN
    RETURN json_build_object('error', 'Limite de acessos (seats) do seu plano atingido. Contate o suporte para aumentar.');
  END IF;

  -- 2. Check if user email already exists
  IF EXISTS (SELECT 1 FROM auth.users WHERE email = p_email) THEN
    SELECT id INTO v_user_id FROM auth.users WHERE email = p_email;
    
    IF EXISTS (SELECT 1 FROM public.clinic_users WHERE clinic_id = p_clinic_id AND user_id = v_user_id) THEN
      RETURN json_build_object('error', 'Usuário já pertence a esta clínica');
    END IF;

    INSERT INTO public.clinic_users (clinic_id, user_id, role)
    VALUES (p_clinic_id, v_user_id, p_role);
    
    RETURN json_build_object('success', true, 'message', 'Usuário já existia no sistema e foi vinculado à clínica');
  END IF;

  -- 3. Create new user in auth.users
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
    v_user_id, v_user_id, format('{"sub": "%s", "email": "%s"}', v_user_id, p_email)::jsonb, 'email', p_email, now(), now(), now()
  );

  -- 4. Add to clinic
  INSERT INTO public.clinic_users (clinic_id, user_id, role)
  VALUES (p_clinic_id, v_user_id, p_role);

  -- 5. Add to pending invites to track them until they change their password
  INSERT INTO public.clinic_invites (clinic_id, email, role, temp_password)
  VALUES (p_clinic_id, p_email, p_role, p_password);

  RETURN json_build_object('success', true, 'user_id', v_user_id);
EXCEPTION
  WHEN OTHERS THEN
    RETURN json_build_object('error', SQLERRM);
END;
$$;


CREATE OR REPLACE FUNCTION public.get_all_clinics_admin()
RETURNS json LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_is_super boolean;
  v_result json;
BEGIN
  -- Allow any authenticated user to view this FOR NOW during development, OR check if email matches the founder's ID.
  -- Actually let's assume if there are ANY super_admins, we enforce it. 
  -- If table is empty, anyone can use it.
  SELECT EXISTS (SELECT 1 FROM super_admins) INTO v_is_super;
  
  IF v_is_super THEN
    IF NOT EXISTS (SELECT 1 FROM super_admins WHERE user_id = auth.uid()) THEN
      RETURN json_build_object('error', 'Forbidden');
    END IF;
  END IF;

  SELECT json_agg(
    json_build_object(
      'id', c.id,
      'nome', c.nome,
      'plano', p.nome,
      'max_users', COALESCE(c.custom_max_users, p.max_users, 3),
      'custom_max_users', c.custom_max_users,
      'custom_max_clinics', c.custom_max_clinics,
      'owner_email', au.email,
      'users_count', (SELECT count(*) FROM clinic_users cu WHERE cu.clinic_id = c.id)
    )
  ) INTO v_result
  FROM public.clinicas c
  LEFT JOIN public.plans p ON c.plano = p.id
  LEFT JOIN auth.users au ON c.user_id = au.id;
  
  RETURN json_build_object('success', true, 'data', COALESCE(v_result, '[]'::json));
END;
$$;


CREATE OR REPLACE FUNCTION public.update_clinic_limits(p_clinic_id uuid, p_custom_users int, p_custom_clinics int)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_is_super boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM super_admins) INTO v_is_super;
  IF v_is_super THEN
    IF NOT EXISTS (SELECT 1 FROM super_admins WHERE user_id = auth.uid()) THEN
      RETURN json_build_object('error', 'Forbidden');
    END IF;
  END IF;

  UPDATE public.clinicas 
  SET custom_max_users = p_custom_users, 
      custom_max_clinics = p_custom_clinics
  WHERE id = p_clinic_id;

  RETURN json_build_object('success', true);
END;
$$;

`;

    try {
        await client.query(sql);
        console.log("Functions and tables updated successfully.");
    } catch (e) {
        console.error(e);
    }

    await client.end();
}
run();


DECLARE
  v_user_id uuid;
  v_is_admin boolean;
  v_encrypted_password text;
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

  -- 2. Check if user email already exists
  IF EXISTS (SELECT 1 FROM auth.users WHERE email = p_email) THEN
    -- User exists, maybe just link them?
    SELECT id INTO v_user_id FROM auth.users WHERE email = p_email;
    
    -- Check if they are already in the clinic
    IF EXISTS (SELECT 1 FROM public.clinic_users WHERE clinic_id = p_clinic_id AND user_id = v_user_id) THEN
      RETURN json_build_object('error', 'Usuário já pertence a esta clínica');
    END IF;

    -- Add to clinic_users
    INSERT INTO public.clinic_users (clinic_id, user_id, role)
    VALUES (p_clinic_id, v_user_id, p_role);
    
    RETURN json_build_object('success', true, 'message', 'Usuário já existia no sistema e foi vinculado à clínica');
  END IF;

  -- 3. Create new user in auth.users
  v_user_id := gen_random_uuid();
  -- Use extensions.crypt and extensions.gen_salt specifically
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
    now(), -- Confirms email immediately
    '{"provider": "email", "providers": ["email"]}',
    json_build_object('nome', p_name, 'force_password_change', true),
    now(), 
    now(),
    '',
    '',
    '',
    ''
  );

  INSERT INTO auth.identities (
    id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at
  ) VALUES (
    v_user_id, v_user_id, format('{"sub": "%s", "email": "%s"}', v_user_id, p_email)::jsonb, 'email', p_email, now(), now(), now()
  );

  -- 4. Add to clinic
  INSERT INTO public.clinic_users (clinic_id, user_id, role)
  VALUES (p_clinic_id, v_user_id, p_role);

  -- 5. Track invite without storing plaintext password
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

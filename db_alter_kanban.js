const { Client } = require('pg');

async function run() {
    const client = new Client({
        connectionString: (process.env.DATABASE_URL || '')
    });
    await client.connect();

    // Add crm_status column
    await client.query(`
      ALTER TABLE clinicas ADD COLUMN IF NOT EXISTS crm_status text DEFAULT 'novos';
    `);

    // Update the get_all_clinics_admin RPC to return crm_status and created_at
    const sql = `
CREATE OR REPLACE FUNCTION public.get_all_clinics_admin()
RETURNS json LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_is_super boolean;
  v_result json;
BEGIN
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
      'users_count', (SELECT count(*) FROM clinic_users cu WHERE cu.clinic_id = c.id),
      'crm_status', COALESCE(c.crm_status, 'novos'),
      'created_at', c.created_at
    )
  ) INTO v_result
  FROM public.clinicas c
  LEFT JOIN public.plans p ON c.plano = p.id
  LEFT JOIN auth.users au ON c.user_id = au.id;
  
  RETURN json_build_object('success', true, 'data', COALESCE(v_result, '[]'::json));
END;
$$;

CREATE OR REPLACE FUNCTION public.update_clinic_crm_status(p_clinic_id uuid, p_status text)
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
  SET crm_status = p_status
  WHERE id = p_clinic_id;

  RETURN json_build_object('success', true);
END;
$$;
`;

    try {
        await client.query(sql);
        console.log("Functions and table updated successfully for Kanban.");
    } catch (e) {
        console.error(e);
    }

    await client.end();
}
run();

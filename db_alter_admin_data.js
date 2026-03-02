const { Client } = require('pg');

async function run() {
    const client = new Client({
        connectionString: (process.env.DATABASE_URL || '')
    });
    await client.connect();

    // Update the get_all_clinics_admin RPC to return subscription cycle and users array
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
      'billing_cycle', (SELECT billing_cycle FROM subscriptions s WHERE s.clinic_id = c.id ORDER BY created_at DESC LIMIT 1),
      'users_count', (SELECT count(*) FROM clinic_users cu WHERE cu.clinic_id = c.id),
      'users', (
        SELECT COALESCE(json_agg(
          json_build_object(
            'id', u.id,
            'email', u.email,
            'role', cu.role
          )
        ), '[]'::json)
        FROM clinic_users cu
        JOIN auth.users u ON cu.user_id = u.id
        WHERE cu.clinic_id = c.id
      ),
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
`;

    try {
        await client.query(sql);
        console.log("get_all_clinics_admin RPC updated successfully.");
    } catch (e) {
        console.error(e);
    }

    await client.end();
}
run();

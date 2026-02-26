const fs = require('fs');
const { Client } = require('./db_setup/node_modules/pg');

const envFile = fs.readFileSync('.env.local', 'utf8');
let dbUrl = '';
for (const line of envFile.split('\n')) {
    if (line.startsWith('DATABASE_URL=')) {
        dbUrl = line.split('=')[1].replace(/["']/g, '').trim();
        break;
    }
}

async function main() {
    const client = new Client({
        connectionString: dbUrl,
        ssl: { rejectUnauthorized: false }
    });

    await client.connect();
    console.log("Connected to database...");

    const sql = `
-- Drop the recursive policies
DROP POLICY IF EXISTS "Users can see clinic users" ON public.clinic_users;
DROP POLICY IF EXISTS "Admins can manage clinic invites" ON public.clinic_invites;

-- Create security definer function to avoid recursion
CREATE OR REPLACE FUNCTION public.get_user_clinics_for_rls()
RETURNS SETOF uuid
SECURITY DEFINER
SET search_path = public
LANGUAGE sql
AS $$
  SELECT clinic_id FROM clinic_users WHERE user_id = auth.uid();
$$;

-- Create the non-recursive select policy
CREATE POLICY "Users can see clinic users" ON public.clinic_users
  FOR SELECT USING (
    clinic_id IN (SELECT public.get_user_clinics_for_rls())
  );

-- Create the admin invite policy using the new approach
CREATE POLICY "Admins can manage clinic invites" ON public.clinic_invites
  FOR ALL USING (
    clinic_id IN (
        SELECT clinic_id FROM public.clinic_users 
        WHERE user_id = auth.uid() AND role IN ('admin', 'owner')
    )
  );

-- Ensure RLS is enabled
ALTER TABLE public.clinic_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clinic_invites ENABLE ROW LEVEL SECURITY;
  `;

    try {
        console.log("Executing fix...");
        await client.query(sql);
        console.log("RLS Fix applied successfully!");
    } catch (err) {
        console.error("Error executing SQL:", err);
    } finally {
        await client.end();
    }
}

main().catch(console.error);

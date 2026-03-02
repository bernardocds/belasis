import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders })
    }

    try {
        // 1. Authenticate User
        const authHeader = req.headers.get('Authorization');
        if (!authHeader) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 401,
            })
        }
        const supabaseClient = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_ANON_KEY') ?? '',
            { global: { headers: { Authorization: authHeader! } } }
        )

        const { data: { user }, error: userError } = await supabaseClient.auth.getUser()

        if (userError || !user) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 401,
            })
        }

        // 2. Get User's Clinic
        const supabaseAdmin = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
        )

        const { data: clinicMember, error: clinicMemberError } = await supabaseAdmin
            .from('clinic_users')
            .select('clinic_id, role')
            .eq('user_id', user.id)
            .in('role', ['owner', 'admin', 'doctor'])
            .limit(1)
            .maybeSingle();

        if (clinicMemberError) {
            throw clinicMemberError;
        }

        let clinicId = clinicMember?.clinic_id ?? null;
        if (!clinicId) {
            const { data: ownerClinic, error: ownerClinicError } = await supabaseAdmin
                .from('clinicas')
                .select('id')
                .eq('user_id', user.id)
                .limit(1)
                .maybeSingle();

            if (ownerClinicError) {
                throw ownerClinicError;
            }

            clinicId = ownerClinic?.id ?? null;
        }

        if (!clinicId) {
            return new Response(JSON.stringify({ error: 'Clínica não encontrada.' }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 404,
            })
        }

        // 3. Instance name in Evolution API follows clinic UUID
        const instanceName = clinicId;

        // 4. Call Evolution API to logout
        const evolutionUrl = Deno.env.get('EVOLUTION_API_URL');
        const evolutionKey = Deno.env.get('EVOLUTION_API_KEY');

        if (!evolutionUrl || !evolutionKey) {
            throw new Error("Missing Evolution API configurations");
        }

        const headers = {
            'Content-Type': 'application/json',
            'apikey': evolutionKey
        };

        // Logout the instance
        const logoutRes = await fetch(`${evolutionUrl}/instance/logout/${instanceName}`, {
            method: 'DELETE',
            headers: headers
        });

        const logoutData = await logoutRes.json();
        console.log('Logout result:', JSON.stringify(logoutData));

        // 5. Update clinic status
        await supabaseAdmin
            .from('clinicas')
            .update({ whatsapp_status: 'disconnected', whatsapp_qr_code: null })
            .eq('id', clinicId);

        return new Response(JSON.stringify({ status: 'disconnected', details: logoutData }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200,
        });

    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("Disconnect Error:", error);
        return new Response(JSON.stringify({ error: message }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 500,
        })
    }
})

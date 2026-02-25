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

        const { data: clinicasList, error: clinicaError } = await supabaseAdmin
            .from('clinicas')
            .select('id')
            .eq('user_id', user.id)
            .limit(1);

        if (clinicaError || !clinicasList || clinicasList.length === 0) {
            return new Response(JSON.stringify({ error: 'Clínica não encontrada.' }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 404,
            })
        }

        const clinicId = clinicasList[0].id;

        // 3. Map clinic_id to Evolution API instance name
        const CLINIC_TO_INSTANCE: Record<string, string> = {
            '06a40c64-48a4-4836-a3ea-8a8ced0492e4': 'ca57fb17-5661-4c85-9d1a-853720c8acff',
        };
        const instanceName = CLINIC_TO_INSTANCE[clinicId] || clinicId;

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

    } catch (error: any) {
        console.error("Disconnect Error:", error);
        return new Response(JSON.stringify({ error: error.message || String(error) }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 500,
        })
    }
})

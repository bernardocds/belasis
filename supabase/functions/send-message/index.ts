import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

// Edge Function to send a message from the dashboard to a WhatsApp number
// Called by the Conversas page when an attendant sends a manual reply

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders })
    }

    try {
        const authHeader = req.headers.get('Authorization');
        if (!authHeader) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 401,
            });
        }

        const supabaseAuth = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_ANON_KEY') ?? '',
            { global: { headers: { Authorization: authHeader } } }
        );

        const { data: { user }, error: userError } = await supabaseAuth.auth.getUser();
        if (userError || !user) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 401,
            });
        }

        const { conversa_id, mensagem } = await req.json();

        if (!conversa_id || !mensagem) {
            return new Response(JSON.stringify({ error: 'conversa_id and mensagem are required' }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 400,
            });
        }

        const supabaseAdmin = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
        );

        // Fetch the conversation to get clinic_id and phone
        const { data: conversa, error: convError } = await supabaseAdmin
            .from('conversas')
            .select('clinic_id, paciente_telefone')
            .eq('id', conversa_id)
            .single();

        if (convError || !conversa) {
            throw new Error('Conversa não encontrada');
        }

        const { data: clinicOwner } = await supabaseAdmin
            .from('clinicas')
            .select('id')
            .eq('id', conversa.clinic_id)
            .eq('user_id', user.id)
            .maybeSingle();

        let hasClinicAccess = !!clinicOwner;
        if (!hasClinicAccess) {
            const { data: clinicMember } = await supabaseAdmin
                .from('clinic_users')
                .select('clinic_id')
                .eq('clinic_id', conversa.clinic_id)
                .eq('user_id', user.id)
                .maybeSingle();
            hasClinicAccess = !!clinicMember;
        }

        if (!hasClinicAccess) {
            return new Response(JSON.stringify({ error: 'Forbidden' }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 403,
            });
        }

        // A instância na Evolution API usa o próprio clinic_id como nome
        const instanceName = conversa.clinic_id;

        const evolutionUrl = Deno.env.get('EVOLUTION_API_URL');
        const evolutionKey = Deno.env.get('EVOLUTION_API_KEY');

        if (!evolutionUrl || !evolutionKey) {
            throw new Error("Missing Evolution API configurations");
        }

        // Send via Evolution API
        const sendRes = await fetch(`${evolutionUrl}/message/sendText/${instanceName}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': evolutionKey },
            body: JSON.stringify({
                number: conversa.paciente_telefone,
                text: mensagem,
                delay: 1000,
            }),
        });

        const sendData = await sendRes.json();
        console.log('Send result status:', sendRes.status);

        if (!sendRes.ok) {
            throw new Error(`Evolution API error: ${JSON.stringify(sendData)}`);
        }

        return new Response(JSON.stringify({ ok: true, details: sendData }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200,
        });

    } catch (error: any) {
        console.error("Send Error:", error);
        return new Response(JSON.stringify({ error: error.message || String(error) }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 500,
        });
    }
})

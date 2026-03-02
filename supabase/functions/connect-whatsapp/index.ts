
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
    // Handle CORS
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
        console.log("Auth header received:", authHeader ? "Present" : "Missing");

        const supabaseClient = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_ANON_KEY') ?? '',
            { global: { headers: { Authorization: authHeader! } } }
        )

        const { data: { user }, error: userError } = await supabaseClient.auth.getUser()

        if (userError || !user) {
            console.log("Unauthorized request rejected.");
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
            return new Response(JSON.stringify({ error: 'Clínica não encontrada para este usuário.' }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 404,
            })
        }

        const { data: clinica, error: clinicaError } = await supabaseAdmin
            .from('clinicas')
            .select('*')
            .eq('id', clinicId)
            .maybeSingle();

        if (clinicaError || !clinica) {
            return new Response(JSON.stringify({ error: 'Clínica não encontrada para este usuário.' }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 404,
            })
        }
        const instanceName = clinica.id; // Using UUID as Instance Name for uniqueness

        // 3. Evolution API Configuration
        const evolutionUrl = Deno.env.get('EVOLUTION_API_URL'); // e.g., http://178.X.X.X:8080
        const evolutionKey = Deno.env.get('EVOLUTION_API_KEY');

        if (!evolutionUrl || !evolutionKey) {
            throw new Error("Missing Evolution API configurations");
        }

        const headers = {
            'Content-Type': 'application/json',
            'apikey': evolutionKey
        };

        const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
        const webhookUrl = `${supabaseUrl}/functions/v1/webhook-evolution`;

        // 4. Force Webhook Configuration (This guarantees Manager-created instances are fixed!)
        try {
            await fetch(`${evolutionUrl}/webhook/set/${instanceName}`, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({
                    webhook: {
                        enabled: true,
                        url: webhookUrl,
                        webhookByEvents: false,
                        webhookBase64: true,
                        readMessage: true,
                        events: [
                            "APPLICATION_STARTUP",
                            "QRCODE_UPDATED",
                            "MESSAGES_UPSERT",
                            "MESSAGES_UPDATE",
                            "MESSAGES_DELETE",
                            "SEND_MESSAGE",
                            "CONNECTION_UPDATE",
                            "CALL"
                        ]
                    }
                })
            });
            console.log("Webhook forcefully configured for", instanceName);
        } catch (we) {
            console.warn("Could not set webhook immediately, instance might not exist yet", we);
        }

        // 5. Check Instance State
        const fetchRes = await fetch(`${evolutionUrl}/instance/connectionState/${instanceName}`, {
            method: 'GET',
            headers: headers
        });

        const stateData = await fetchRes.json();

        // If it exists and is open, just return connected
        if (stateData?.instance?.state === 'open' || stateData?.state === 'open') {
            await supabaseAdmin.from('clinicas').update({ whatsapp_status: 'connected', whatsapp_qr_code: null }).eq('id', clinica.id);
            return new Response(JSON.stringify({ status: 'connected', state: { state: 'open' } }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 200,
            });
        }

        let base64Output = null;

        if (fetchRes.status === 404 || stateData.error === "Not Found") {
            // Create Instance
            const createRes = await fetch(`${evolutionUrl}/instance/create`, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({
                    instanceName: instanceName,
                    token: instanceName,
                    qrcode: true,
                    integration: "WHATSAPP-BAILEYS"
                })
            });
            const createData = await createRes.json();
            if (createData?.qrcode?.base64) {
                base64Output = createData.qrcode.base64;
            } else if (createData?.hash?.qrcode?.base64) {
                base64Output = createData.hash.qrcode.base64;
            }

            // Re-apply webhook just to be safe after creation
            await fetch(`${evolutionUrl}/webhook/set/${instanceName}`, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({
                    webhook: {
                        enabled: true,
                        url: webhookUrl,
                        webhookByEvents: false,
                        webhookBase64: true,
                        readMessage: true,
                        events: ["QRCODE_UPDATED", "MESSAGES_UPSERT", "CONNECTION_UPDATE"]
                    }
                })
            });
        } else {
            // Already exists but not connected (state is close/connecting), get the QR Code
            const connectRes = await fetch(`${evolutionUrl}/instance/connect/${instanceName}`, {
                method: 'GET',
                headers: headers
            });
            const connectData = await connectRes.json();
            if (connectData?.base64) {
                base64Output = connectData.base64;
            }
        }

        if (base64Output) {
            // Save to DB and return immediately
            await supabaseAdmin.from('clinicas').update({ whatsapp_qr_code: base64Output, whatsapp_status: 'qr_code_ready' }).eq('id', clinica.id);
            return new Response(JSON.stringify({ status: 'qr_code_ready', base64: base64Output }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 200,
            });
        } else {
            return new Response(JSON.stringify({ error: "Failed to generate QR Code from Evolution API", details: stateData }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 500,
            });
        }

    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("Connect Error:", error);
        return new Response(JSON.stringify({ error: message }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 500,
        })
    }
})

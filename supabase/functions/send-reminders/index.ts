import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

// This function is called by pg_cron every hour to send 24h appointment reminders.
// It can also be called manually via POST.

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders })
    }

    try {
        const supabaseAdmin = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
        );

        const evolutionUrl = Deno.env.get('EVOLUTION_API_URL');
        const evolutionKey = Deno.env.get('EVOLUTION_API_KEY');

        if (!evolutionUrl || !evolutionKey) {
            throw new Error("Missing Evolution API configurations");
        }

        // Find appointments in the next 24 hours that haven't been reminded
        const now = new Date();
        const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

        const { data: agendamentos, error } = await supabaseAdmin
            .from('agendamentos')
            .select('id, paciente_nome, paciente_telefone, data_hora, observacao, clinic_id')
            .in('status', ['marcado', 'confirmado'])
            .gte('data_hora', now.toISOString())
            .lte('data_hora', in24h.toISOString())
            .eq('lembrete_enviado', false);

        if (error) throw new Error('Error fetching agendamentos: ' + error.message);

        if (!agendamentos || agendamentos.length === 0) {
            console.log('No upcoming appointments to remind.');
            return new Response(JSON.stringify({ sent: 0 }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 200,
            });
        }

        console.log(`Found ${agendamentos.length} appointments to remind.`);

        // Map clinic_id to Evolution API instance name
        const CLINIC_TO_INSTANCE: Record<string, string> = {
            '06a40c64-48a4-4836-a3ea-8a8ced0492e4': 'ca57fb17-5661-4c85-9d1a-853720c8acff',
        };

        let sentCount = 0;

        for (const ag of agendamentos) {
            try {
                const instanceName = CLINIC_TO_INSTANCE[ag.clinic_id] || ag.clinic_id;
                const dataFormatada = new Date(ag.data_hora).toLocaleDateString('pt-BR', {
                    day: '2-digit', month: '2-digit', year: 'numeric',
                    hour: '2-digit', minute: '2-digit',
                    timeZone: 'America/Sao_Paulo'
                });

                // Buscar nome da clínica
                const { data: clinicaData } = await supabaseAdmin
                    .from('clinicas')
                    .select('nome')
                    .eq('id', ag.clinic_id)
                    .single();

                const nomeClinica = clinicaData?.nome || 'nossa clínica';

                const message = `Olá, ${ag.paciente_nome?.split(' ')[0] || 'paciente'}! 😊\n\n` +
                    `Passando para confirmar sua consulta:\n\n` +
                    `📅 *${dataFormatada}*\n` +
                    `📋 ${ag.observacao || 'Consulta'}\n` +
                    `🏥 ${nomeClinica}\n\n` +
                    `Pode confirmar sua presença? Basta responder esta mensagem! 💬`;

                const sendRes = await fetch(`${evolutionUrl}/message/sendText/${instanceName}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'apikey': evolutionKey },
                    body: JSON.stringify({
                        number: ag.paciente_telefone,
                        text: message,
                        delay: 1000,
                    }),
                });

                if (sendRes.ok) {
                    await supabaseAdmin
                        .from('agendamentos')
                        .update({ lembrete_enviado: true })
                        .eq('id', ag.id);

                    sentCount++;
                    console.log(`✅ Reminder sent to ${ag.paciente_telefone}`);
                } else {
                    console.error(`❌ Failed to send to ${ag.paciente_telefone}:`, await sendRes.text());
                }
            } catch (e) {
                console.error(`Error sending reminder for ${ag.id}:`, e);
            }
        }

        return new Response(JSON.stringify({ sent: sentCount, total: agendamentos.length }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200,
        });

    } catch (error: any) {
        console.error("Reminder Error:", error);
        return new Response(JSON.stringify({ error: error.message || String(error) }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 500,
        })
    }
})

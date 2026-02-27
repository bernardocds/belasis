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
        const internalCronSecret = Deno.env.get('INTERNAL_CRON_SECRET');
        if (internalCronSecret) {
            const providedSecret = req.headers.get('x-internal-secret');
            if (!providedSecret || providedSecret !== internalCronSecret) {
                return new Response(JSON.stringify({ error: 'Unauthorized' }), {
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                    status: 401,
                });
            }
        } else {
            console.warn('INTERNAL_CRON_SECRET not configured. send-reminders is not protected by internal secret.');
        }

        const supabaseAdmin = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
        );

        const evolutionUrl = Deno.env.get('EVOLUTION_API_URL');
        const evolutionKey = Deno.env.get('EVOLUTION_API_KEY');

        if (!evolutionUrl || !evolutionKey) {
            throw new Error("Missing Evolution API configurations");
        }

        // Find appointments in the next 24 hours
        const now = new Date();
        const in1h = new Date(now.getTime() + 1 * 60 * 60 * 1000);
        const in3h = new Date(now.getTime() + 3 * 60 * 60 * 1000);
        const in4h = new Date(now.getTime() + 4 * 60 * 60 * 1000);
        const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

        const { data: agendamentos, error } = await supabaseAdmin
            .from('agendamentos')
            .select('id, paciente_nome, paciente_telefone, data_hora, observacao, clinic_id, lembrete_enviado, lembrete_3h_enviado, lembrete_1h_enviado, status')
            .in('status', ['marcado', 'confirmado'])
            .gte('data_hora', now.toISOString())
            .lte('data_hora', in24h.toISOString());

        if (error) throw new Error('Error fetching agendamentos: ' + error.message);

        // Filter out those that already received all necessary reminders/cancellations
        const pendingReminders = agendamentos?.filter(ag => {
            if (ag.status === 'confirmado') {
                return !ag.lembrete_3h_enviado; // Só precisa do lembrete de 3h (soon) se já confirmou
            } else {
                return !ag.lembrete_enviado || !ag.lembrete_3h_enviado || !ag.lembrete_1h_enviado;
            }
        }) || [];

        if (pendingReminders.length === 0) {
            console.log('No upcoming appointments to process.');
            return new Response(JSON.stringify({ sent: 0 }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 200,
            });
        }

        console.log(`Found ${pendingReminders.length} appointments pending processing.`);

        // Map clinic_id to Evolution API instance name
        const CLINIC_TO_INSTANCE: Record<string, string> = {
            '06a40c64-48a4-4836-a3ea-8a8ced0492e4': 'ca57fb17-5661-4c85-9d1a-853720c8acff',
        };

        let sentCount = 0;

        for (const ag of pendingReminders) {
            try {
                const dataAgendamento = new Date(ag.data_hora);
                const isWithin1h = dataAgendamento <= in1h;
                const isWithin3h = dataAgendamento > in1h && dataAgendamento <= in3h;
                const isWithin4h = dataAgendamento > in1h && dataAgendamento <= in4h;

                let actionType: '1h_cancel' | '3h_confirmed_reminder' | '4h_warning' | '24h_reminder' | null = null;

                if (ag.status === 'confirmado') {
                    if (isWithin3h && !ag.lembrete_3h_enviado) {
                        actionType = '3h_confirmed_reminder';
                    }
                } else if (ag.status === 'marcado') {
                    if (isWithin1h && !ag.lembrete_1h_enviado) {
                        actionType = '1h_cancel';
                    } else if (isWithin4h && !ag.lembrete_3h_enviado) {
                        // Usamos o flag lembrete_3h_enviado para o aviso de 4h dos "não confirmados"
                        actionType = '4h_warning';
                    } else if (!isWithin4h && !ag.lembrete_enviado) {
                        actionType = '24h_reminder';
                    }
                }

                if (!actionType) continue;

                const instanceName = CLINIC_TO_INSTANCE[ag.clinic_id] || ag.clinic_id;
                const dataFormatada = dataAgendamento.toLocaleDateString('pt-BR', {
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
                const fN = ag.paciente_nome?.split(' ')[0] || 'paciente';

                let message = "";
                let shouldCancelAppointment = false;

                if (actionType === '1h_cancel') {
                    message = `Olá, ${fN}. Poxa, como não recebemos a confirmação da sua presença ao longo do dia, **sua consulta das ${dataFormatada.split(' ')[1]} foi cancelada** e a vaga liberada.\n\nSe quiser remarcar para outro dia, é só me chamar aqui! 😊`;
                    shouldCancelAppointment = true;
                } else if (actionType === '4h_warning') {
                    message = `Olá, ${fN}! 😊\n\n` +
                        `Passando para dar um último aviso: precisamos da sua confirmação para a consulta de hoje às ${dataFormatada.split(' ')[1]}.\n\n` +
                        `*Se não recebermos sua confirmação em breve, a consulta será cancelada automaticamente* para liberar a vaga.\n\n` +
                        `Pode confirmar sua presença agora respondendo esta mensagem? 💬`;
                } else if (actionType === '3h_confirmed_reminder') {
                    message = `Olá, ${fN}! 😊\n\n` +
                        `Sua consulta é DAQUI A POUQUINHO, hoje às ${dataFormatada.split(' ')[1]}! ⏰\n\n` +
                        `🏥 Estamos te esperando aqui na ${nomeClinica}!\n` +
                        `📍 Lembre-se de verificar o endereço certinho se for a primeira vez. Até logo! ✨`;
                } else if (actionType === '24h_reminder') {
                    message = `Olá, ${fN}! 😊\n\n` +
                        `Passando para lembrar e confirmar sua consulta:\n\n` +
                        `📅 *${dataFormatada}*\n` +
                        `📋 ${ag.observacao || 'Consulta'}\n` +
                        `🏥 ${nomeClinica}\n\n` +
                        `Pode confirmar sua presença? Basta responder esta mensagem com um "sim"! 💬`;
                }

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
                    const updateData: any = {};
                    if (actionType === '1h_cancel') {
                        updateData.lembrete_1h_enviado = true;
                        updateData.status = 'cancelado';
                        updateData.observacao = ag.observacao ? `${ag.observacao} [Cancelado por falta de confirmação]` : '[Cancelado por falta de confirmação]';
                    } else if (actionType === '4h_warning' || actionType === '3h_confirmed_reminder') {
                        updateData.lembrete_3h_enviado = true;
                    } else if (actionType === '24h_reminder') {
                        updateData.lembrete_enviado = true;
                    }

                    await supabaseAdmin
                        .from('agendamentos')
                        .update(updateData)
                        .eq('id', ag.id);

                    sentCount++;
                    console.log(`✅ ${actionType} sent to ${ag.paciente_telefone}`);
                } else {
                    console.error(`❌ Failed to send to ${ag.paciente_telefone}:`, await sendRes.text());
                }
            } catch (e) {
                console.error(`Error sending reminder for ${ag.id}:`, e);
            }
        }

        return new Response(JSON.stringify({ sent: sentCount, total: pendingReminders.length }), {
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

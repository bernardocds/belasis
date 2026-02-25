import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

    try {
        const supabase = createClient(
            Deno.env.get("SUPABASE_URL")!,
            Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
        );

        // Find agendamentos that were completed (atendido) and need follow-up
        // where: status = 'atendido', followup_enviado = false,
        // and created_at + followup_dias days < now
        const { data: agendamentos, error } = await supabase
            .from("agendamentos")
            .select("id, paciente_nome, paciente_telefone, clinic_id, followup_dias, data_hora")
            .eq("status", "atendido")
            .eq("followup_enviado", false);

        if (error) throw error;

        let sent = 0;

        for (const ag of agendamentos || []) {
            const followupDias = ag.followup_dias || 3;
            const dataAtendimento = new Date(ag.data_hora);
            const followupDate = new Date(dataAtendimento.getTime() + followupDias * 24 * 60 * 60 * 1000);

            if (new Date() < followupDate) continue; // Not yet time for follow-up

            // Get clinic info for Evolution API instance name
            const { data: clinica } = await supabase
                .from("clinicas")
                .select("nome, evolution_instance")
                .eq("id", ag.clinic_id)
                .single();

            if (!clinica?.evolution_instance || !ag.paciente_telefone) continue;

            // Send follow-up via Evolution API
            const evolutionUrl = Deno.env.get("EVOLUTION_API_URL") || "https://api.belasis.cloud";
            const evolutionKey = Deno.env.get("EVOLUTION_API_KEY") || "";

            const followupMessage = `Olá ${ag.paciente_nome}! 😊\n\n` +
                `Passando para saber como você está após a sua consulta na ${clinica.nome}.\n\n` +
                `Está tudo bem? Precisa de algo? Fique à vontade para nos enviar uma mensagem!\n\n` +
                `Equipe ${clinica.nome} 💙`;

            try {
                const sendRes = await fetch(`${evolutionUrl}/message/sendText/${clinica.evolution_instance}`, {
                    method: "POST",
                    headers: {
                        "apikey": evolutionKey,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        number: ag.paciente_telefone,
                        text: followupMessage,
                    }),
                });

                if (sendRes.ok) {
                    // Mark as sent
                    await supabase
                        .from("agendamentos")
                        .update({ followup_enviado: true })
                        .eq("id", ag.id);

                    sent++;
                    console.log(`✅ Follow-up sent to ${ag.paciente_nome} (${ag.paciente_telefone})`);
                } else {
                    console.error(`Failed to send follow-up to ${ag.paciente_telefone}:`, await sendRes.text());
                }
            } catch (sendErr) {
                console.error(`Error sending follow-up to ${ag.paciente_telefone}:`, String(sendErr));
            }
        }

        return new Response(
            JSON.stringify({ ok: true, followups_sent: sent, total_checked: agendamentos?.length || 0 }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    } catch (err: any) {
        console.error("Follow-up error:", err);
        return new Response(JSON.stringify({ error: err.message }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }
});

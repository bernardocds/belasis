import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

    try {
        const authHeader = req.headers.get("Authorization");
        if (!authHeader) {
            return new Response(JSON.stringify({ error: "Unauthorized" }), {
                status: 401,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }

        const supabaseAuth = createClient(
            Deno.env.get("SUPABASE_URL")!,
            Deno.env.get("SUPABASE_ANON_KEY")!,
            { global: { headers: { Authorization: authHeader } } }
        );

        const { data: { user }, error: userError } = await supabaseAuth.auth.getUser();
        if (userError || !user) {
            return new Response(JSON.stringify({ error: "Unauthorized" }), {
                status: 401,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }

        const supabaseAdmin = createClient(
            Deno.env.get("SUPABASE_URL")!,
            Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
        );

        const { atendimento_id } = await req.json();
        if (!atendimento_id) {
            return new Response(JSON.stringify({ error: "atendimento_id required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        // Fetch atendimento
        const { data: atendimento, error } = await supabaseAdmin
            .from("atendimentos")
            .select("clinic_id, queixa_principal, anamnese, evolucao, conduta, pacientes(nome)")
            .eq("id", atendimento_id)
            .single();

        if (error || !atendimento) {
            return new Response(JSON.stringify({ error: "Atendimento not found" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        const clinicId = (atendimento as any).clinic_id;
        const { data: ownerClinic } = await supabaseAdmin
            .from("clinicas")
            .select("id")
            .eq("id", clinicId)
            .eq("user_id", user.id)
            .maybeSingle();

        let hasClinicAccess = !!ownerClinic;
        if (!hasClinicAccess) {
            const { data: clinicMember } = await supabaseAdmin
                .from("clinic_users")
                .select("clinic_id")
                .eq("clinic_id", clinicId)
                .eq("user_id", user.id)
                .maybeSingle();
            hasClinicAccess = !!clinicMember;
        }

        if (!hasClinicAccess) {
            return new Response(JSON.stringify({ error: "Forbidden" }), {
                status: 403,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }

        const pacienteNome = (atendimento as any).pacientes?.nome || "Paciente";

        // Build prompt for GPT
        const prompt = `Você é um assistente médico. Gere um resumo clínico estruturado e profissional do seguinte atendimento. O resumo deve ser conciso, objetivo e em português brasileiro.

Paciente: ${pacienteNome}

Queixa Principal: ${atendimento.queixa_principal || "Não informada"}

Anamnese: ${atendimento.anamnese || "Não informada"}

Evolução: ${atendimento.evolucao || "Não informada"}

Conduta: ${atendimento.conduta || "Não informada"}

Gere o resumo no formato:
## Resumo Clínico
**Paciente:** [nome]
**Queixa:** [resumo da queixa]
**Achados:** [principais achados do exame/anamnese]
**Conduta:** [plano terapêutico resumido]
**Observações:** [notas adicionais relevantes, se houver]`;

        const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${Deno.env.get("OPENAI_API_KEY")}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [{ role: "user", content: prompt }],
                max_tokens: 500,
                temperature: 0.3,
            }),
        });

        if (!openaiRes.ok) {
            const err = await openaiRes.text();
            throw new Error(`OpenAI error: ${err}`);
        }

        const result = await openaiRes.json();
        const resumo = result.choices[0].message.content;

        // Save to atendimento
        await supabaseAdmin.from("atendimentos").update({ resumo_ia: resumo }).eq("id", atendimento_id);

        return new Response(JSON.stringify({ resumo }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    } catch (err: any) {
        console.error("Summary error:", err);
        return new Response(JSON.stringify({ error: err.message }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }
});

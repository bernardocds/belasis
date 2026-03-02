import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type OutputFormat = "summary" | "soap";

interface GenerateSummaryPayload {
  atendimento_id?: string;
  free_text?: string;
  output_format?: OutputFormat;
}

interface SoapOutput {
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
  summary: string;
}

function normalizeOutputFormat(value: unknown): OutputFormat {
  return value === "soap" ? "soap" : "summary";
}

function safeString(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

function buildSoapText(soap: SoapOutput): string {
  return [
    "## Evolução SOAP",
    "",
    `**S (Subjetivo):** ${soap.subjective || "Não informado"}`,
    `**O (Objetivo):** ${soap.objective || "Não informado"}`,
    `**A (Avaliação):** ${soap.assessment || "Não informado"}`,
    `**P (Plano):** ${soap.plan || "Não informado"}`,
    "",
    `**Resumo Clínico:** ${soap.summary || "Não informado"}`,
  ].join("\n");
}

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

    const payload = (await req.json()) as GenerateSummaryPayload;
    const atendimentoId = safeString(payload?.atendimento_id);
    const freeText = safeString(payload?.free_text);
    const outputFormat = normalizeOutputFormat(payload?.output_format);

    if (!atendimentoId) {
      return new Response(JSON.stringify({ error: "atendimento_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: atendimento, error } = await supabaseAdmin
      .from("atendimentos")
      .select("clinic_id, queixa_principal, anamnese, evolucao, conduta, pacientes(nome)")
      .eq("id", atendimentoId)
      .single();

    if (error || !atendimento) {
      return new Response(JSON.stringify({ error: "Atendimento not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const clinicId = (atendimento as { clinic_id: string }).clinic_id;
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

    const pacienteNome = (atendimento as { pacientes?: { nome?: string } | null }).pacientes?.nome || "Paciente";
    const clinicalContext = `Paciente: ${pacienteNome}\n\nQueixa Principal: ${(atendimento as { queixa_principal?: string | null }).queixa_principal || "Não informada"}\n\nAnamnese: ${(atendimento as { anamnese?: string | null }).anamnese || "Não informada"}\n\nEvolução: ${(atendimento as { evolucao?: string | null }).evolucao || "Não informada"}\n\nConduta: ${(atendimento as { conduta?: string | null }).conduta || "Não informada"}`;

    const freeTextSection = freeText
      ? `\n\nNotas livres adicionais (ditado/anotações não estruturadas):\n${freeText}`
      : "";

    let prompt = "";
    let requestBody: Record<string, unknown> = {
      model: "gpt-4o-mini",
      max_tokens: 700,
      temperature: 0.2,
    };

    if (outputFormat === "soap") {
      prompt = `Você é um assistente clínico para prontuário eletrônico em português brasileiro.\n\nConverta as informações abaixo em evolução no formato SOAP.\n\n${clinicalContext}${freeTextSection}\n\nResponda SOMENTE em JSON válido com exatamente estas chaves:\n{\n  "subjective": "texto objetivo",\n  "objective": "texto objetivo",\n  "assessment": "hipóteses e avaliação clínica",\n  "plan": "conduta e plano",\n  "summary": "resumo curto final"\n}\n\nRegras:\n- Não inventar dados ausentes.\n- Se faltar dado, escrever "Não informado" no campo correspondente.\n- Linguagem clínica direta e profissional.`;

      requestBody = {
        ...requestBody,
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
      };
    } else {
      prompt = `Você é um assistente médico. Gere um resumo clínico estruturado, conciso e objetivo em português brasileiro.\n\n${clinicalContext}${freeTextSection}\n\nGere no formato:\n## Resumo Clínico\n**Paciente:** [nome]\n**Queixa:** [resumo da queixa]\n**Achados:** [principais achados]\n**Conduta:** [plano terapêutico resumido]\n**Observações:** [notas adicionais relevantes, se houver]`;

      requestBody = {
        ...requestBody,
        messages: [{ role: "user", content: prompt }],
      };
    }

    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    if (!openaiRes.ok) {
      const err = await openaiRes.text();
      throw new Error(`OpenAI error: ${err}`);
    }

    const result = await openaiRes.json();
    const content = result?.choices?.[0]?.message?.content;
    if (!content || typeof content !== "string") {
      throw new Error("Resposta inválida do modelo");
    }

    if (outputFormat === "soap") {
      let soap: SoapOutput;
      try {
        const parsed = JSON.parse(content) as Partial<SoapOutput>;
        soap = {
          subjective: safeString(parsed.subjective) || "Não informado",
          objective: safeString(parsed.objective) || "Não informado",
          assessment: safeString(parsed.assessment) || "Não informado",
          plan: safeString(parsed.plan) || "Não informado",
          summary: safeString(parsed.summary) || "Não informado",
        };
      } catch {
        throw new Error("IA retornou SOAP inválido");
      }

      const soapText = buildSoapText(soap);
      await supabaseAdmin.from("atendimentos").update({ resumo_ia: soapText }).eq("id", atendimentoId);

      return new Response(JSON.stringify({ resumo: soapText, soap, output_format: "soap" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    await supabaseAdmin.from("atendimentos").update({ resumo_ia: content }).eq("id", atendimentoId);

    return new Response(JSON.stringify({ resumo: content, output_format: "summary" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Erro interno";
    console.error("Summary error:", err);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

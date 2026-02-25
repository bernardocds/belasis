import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Interfaces for our extracted tool data
interface AgendarConsultaData {
  nome_paciente: string;
  telefone_paciente: string;
  data_hora_iso: string;
  duracao_minutos: number;
  procedimento_esperado: string;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  if (payload.type !== 'INSERT' || !payload.record) {
    console.log('Ignored: not an INSERT event.');
    return new Response(JSON.stringify({ ignored: 'not_insert' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });
  }

  const { id: messageId, conversa_id, role, conteudo } = payload.record;

  if (role !== 'user') {
    return new Response(JSON.stringify({ ignored: 'not_user_role' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });
  }

  console.log('=== Processing message ===', { messageId, conversa_id, conteudo: conteudo?.substring(0, 80) });

  try {
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // ── 0. Message concatenation debounce ──────────────────────────────────
    // Wait 15 seconds to allow multiple rapid messages to arrive
    await new Promise(resolve => setTimeout(resolve, 15000));

    // Check if THIS message is still the latest user message in the conversation
    const { data: latestMsg } = await supabaseAdmin
      .from('mensagens')
      .select('id')
      .eq('conversa_id', conversa_id)
      .eq('role', 'user')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (latestMsg && latestMsg.id !== messageId) {
      // A newer message exists — skip this one, the newer one will handle the batch
      console.log('Skipping: newer message exists, this will be concatenated.');
      return new Response(JSON.stringify({ ignored: 'concatenated' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      });
    }

    // ── 1. Fetch the conversation ────────────────────────────────────────────
    const { data: conversa, error: conversaError } = await supabaseAdmin
      .from('conversas')
      .select('*')
      .eq('id', conversa_id)
      .single();

    if (conversaError || !conversa) {
      throw new Error('Conversa not found: ' + conversa_id);
    }

    // ── HANDOFF GUARD: skip AI if conversation is transferred to human ────
    if (conversa.status === 'handoff') {
      console.log('Conversa in handoff mode, skipping AI processing.');
      return new Response(JSON.stringify({ ignored: 'handoff_mode' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      });
    }

    // ── 2. Fetch the clinic's custom AI prompt ───────────────────────────────
    const { data: clinica } = await supabaseAdmin
      .from('clinicas')
      .select('prompt, nome')
      .eq('id', conversa.clinic_id)
      .single();

    // Adiciona instruções sistêmicas para a IA saber agendar
    const systemPromptBase = clinica?.prompt ||
      `Você é um assistente virtual atencioso e prestativo da clínica "${clinica?.nome ?? 'médica'}". ` +
      `Responda de forma clara, humanizada e profissional. ` +
      `Ajude com agendamentos, informações e dúvidas gerais.`;

    const systemPrompt = systemPromptBase +
      `\n\nINSTRUÇÕES DE AGENDAMENTO:
Quando o paciente quiser marcar uma consulta, você DEVE coletar: 1) Nome completo, 2) Data e hora, 3) Procedimento/motivo.
O telefone já possuímos. Com tudo confirmado, EXECUTE "agendar_consulta".
Nunca invente horários. Formato ISO 8601 (ex: 2024-03-10T14:30:00-03:00). Data atual: ${new Date().toISOString()}.

CONSULTA E CANCELAMENTO:
- Para ver consultas: USE "consultar_agendamentos"
- Para cancelar: PRIMEIRO consulte, mostre a lista (SEM o código ref), peça confirmação, depois use "cancelar_agendamento"
- Para reagendar: PRIMEIRO consulte, identifique qual, peça a nova data/hora, depois use "reagendar_consulta"

HANDOFF PARA HUMANO:
Se o paciente pedir para falar com um humano/atendente, ou se você não souber resolver o problema, USE "solicitar_atendente".
Após transferir, diga que um atendente vai entrar em contato em breve.`;

    // ── 3. Fetch conversation history (last 15 messages for context) ─────────
    const { data: history, error: historyError } = await supabaseAdmin
      .from('mensagens')
      .select('role, conteudo')
      .eq('conversa_id', conversa_id)
      .order('created_at', { ascending: true })
      .limit(15);

    if (historyError) throw new Error('History fetch error: ' + historyError.message);

    const messagesForAI: any[] = [
      { role: 'system', content: systemPrompt },
      ...(history ?? []).map((m: any) => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.conteudo,
      })),
    ];

    // ── 4. Call OpenAI API with Tools ─────────────────────────────────────────
    const openAiKey = Deno.env.get('OPENAI_API_KEY');
    if (!openAiKey) {
      throw new Error('Secret OPENAI_API_KEY is not configured');
    }

    const tools = [
      {
        type: "function",
        function: {
          name: "agendar_consulta",
          description: "Salva o agendamento de uma consulta no banco de dados da clínica, quando paciente definir nome, data, hora e motivo.",
          parameters: {
            type: "object",
            properties: {
              nome_paciente: { type: "string", description: "Nome completo do paciente" },
              data_hora_iso: { type: "string", description: "Data e hora do agendamento em formato ISO 8601" },
              duracao_minutos: { type: "number", description: "Duração aproximada em minutos (padrão 30)", default: 30 },
              procedimento_esperado: { type: "string", description: "O que o paciente quer fazer ou motivo da consulta" }
            },
            required: ["nome_paciente", "data_hora_iso", "procedimento_esperado"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "consultar_agendamentos",
          description: "Busca os agendamentos existentes do paciente na clínica pelo número de telefone. Use quando o paciente perguntar quais consultas tem agendadas ou quiser cancelar.",
          parameters: {
            type: "object",
            properties: {},
            required: []
          }
        }
      },
      {
        type: "function",
        function: {
          name: "cancelar_agendamento",
          description: "Cancela um agendamento específico pelo seu ID. Use SOMENTE após consultar os agendamentos e o paciente confirmar qual deseja cancelar.",
          parameters: {
            type: "object",
            properties: {
              agendamento_id: { type: "string", description: "O ID (UUID) do agendamento a ser cancelado" },
              motivo: { type: "string", description: "Motivo do cancelamento informado pelo paciente" }
            },
            required: ["agendamento_id"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "reagendar_consulta",
          description: "Altera a data/hora de um agendamento existente. Use após consultar os agendamentos e o paciente informar a nova data.",
          parameters: {
            type: "object",
            properties: {
              agendamento_id: { type: "string", description: "O ID do agendamento a ser reagendado" },
              nova_data_hora_iso: { type: "string", description: "Nova data e hora em formato ISO 8601" }
            },
            required: ["agendamento_id", "nova_data_hora_iso"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "solicitar_atendente",
          description: "Transfere a conversa para um atendente humano. Use quando o paciente pedir explicitamente para falar com uma pessoa ou quando você não conseguir resolver o problema.",
          parameters: {
            type: "object",
            properties: {
              motivo: { type: "string", description: "Motivo da transferência" }
            },
            required: ["motivo"]
          }
        }
      }
    ];

    console.log('Calling OpenAI with', messagesForAI.length, 'messages...');

    let aiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openAiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: messagesForAI,
        temperature: 0.7,
        tools: tools,
        tool_choice: "auto",
        max_tokens: 500,
      }),
    });

    if (!aiResponse.ok) {
      const errBody = await aiResponse.text();
      throw new Error(`OpenAI API Error (${aiResponse.status}): ${errBody}`);
    }

    let aiData = await aiResponse.json();
    let responseMessage = aiData.choices?.[0]?.message;
    let replyText: string = responseMessage?.content || "";

    // ── 5. Handle Function Calling (Agendamento no BD) ────────────────────────
    if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
      console.log('AI invoked tools:', responseMessage.tool_calls);

      messagesForAI.push(responseMessage); // append assistant tool call message to history

      for (const toolCall of responseMessage.tool_calls) {
        let toolResponseText = "";
        const recipientPhone = conversa.paciente_telefone.replace('@s.whatsapp.net', '').replace('@c.us', '');

        if (toolCall.function.name === 'agendar_consulta') {
          const args: AgendarConsultaData = JSON.parse(toolCall.function.arguments);

          try {
            let paciente_id = null;

            let { data: patientData } = await supabaseAdmin
              .from('pacientes')
              .select('id')
              .eq('clinic_id', conversa.clinic_id)
              .eq('telefone', recipientPhone)
              .maybeSingle();

            if (!patientData) {
              const { data: newPatient, error: newPatientError } = await supabaseAdmin
                .from('pacientes')
                .insert({ clinic_id: conversa.clinic_id, nome: args.nome_paciente, telefone: recipientPhone })
                .select('id')
                .single();
              if (newPatientError) throw new Error("Erro ao criar paciente: " + newPatientError.message);
              paciente_id = newPatient.id;
            } else {
              paciente_id = patientData.id;
              await supabaseAdmin.from('pacientes').update({ nome: args.nome_paciente }).eq('id', paciente_id);
            }

            const { error: insertErr } = await supabaseAdmin
              .from('agendamentos')
              .insert({
                clinic_id: conversa.clinic_id, conversa_id, paciente_id,
                duracao_min: args.duracao_minutos || 30, observacao: args.procedimento_esperado,
                data_hora: args.data_hora_iso, status: 'marcado',
                paciente_nome: args.nome_paciente, paciente_telefone: recipientPhone
              });
            if (insertErr) throw new Error("Erro ao agendar: " + insertErr.message);

            toolResponseText = `O agendamento foi realizado com sucesso no sistema para o dia ${args.data_hora_iso}.`;
            console.log("Agendamento criado via Tool com sucesso!");
          } catch (e: any) {
            console.error("Tool agendar_consulta failed:", e);
            toolResponseText = "Falha ao gravar agendamento. Diga que ocorreu um erro interno e peça para tentar mais tarde.";
          }

        } else if (toolCall.function.name === 'consultar_agendamentos') {
          try {
            const { data: agendamentos, error: agError } = await supabaseAdmin
              .from('agendamentos')
              .select('id, data_hora, status, observacao, paciente_nome, duracao_min')
              .eq('clinic_id', conversa.clinic_id)
              .eq('paciente_telefone', recipientPhone)
              .in('status', ['marcado', 'confirmado'])
              .order('data_hora', { ascending: true });

            if (agError) throw new Error("Erro ao buscar agendamentos: " + agError.message);

            if (!agendamentos || agendamentos.length === 0) {
              toolResponseText = "O paciente não possui nenhum agendamento ativo no momento.";
            } else {
              const lista = agendamentos.map((a: any, i: number) => {
                const dt = new Date(a.data_hora);
                const dataFormatada = dt.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
                return `${i + 1}. Data: ${dataFormatada} | Procedimento: ${a.observacao || 'Consulta'} [ref:${a.id}]`;
              }).join('\n');
              toolResponseText = `Agendamentos encontrados:\n${lista}\n\nIMPORTANTE: Ao apresentar ao paciente, mostre APENAS o número, data e procedimento. NÃO mostre o código [ref:...], ele é apenas para uso interno.`;
            }
            console.log("Consulta de agendamentos realizada!");
          } catch (e: any) {
            console.error("Tool consultar_agendamentos failed:", e);
            toolResponseText = "Falha ao buscar agendamentos. Diga que ocorreu um erro interno.";
          }

        } else if (toolCall.function.name === 'cancelar_agendamento') {
          const args = JSON.parse(toolCall.function.arguments);
          try {
            const { data: agendamento, error: findErr } = await supabaseAdmin
              .from('agendamentos')
              .select('id, paciente_telefone, data_hora, observacao')
              .eq('id', args.agendamento_id)
              .eq('clinic_id', conversa.clinic_id)
              .single();

            if (findErr || !agendamento) throw new Error("Agendamento não encontrado.");
            if (agendamento.paciente_telefone !== recipientPhone) throw new Error("Agendamento pertence a outro paciente.");

            const { error: updateErr } = await supabaseAdmin
              .from('agendamentos')
              .update({ status: 'cancelado', observacao: `${agendamento.observacao || ''} [CANCELADO: ${args.motivo || 'a pedido do paciente'}]` })
              .eq('id', args.agendamento_id);

            if (updateErr) throw new Error("Erro ao cancelar: " + updateErr.message);

            toolResponseText = `Agendamento cancelado com sucesso.`;
            console.log("Agendamento cancelado via Tool!");
          } catch (e: any) {
            console.error("Tool cancelar_agendamento failed:", e);
            toolResponseText = `Falha ao cancelar agendamento: ${e.message}`;
          }

        } else if (toolCall.function.name === 'reagendar_consulta') {
          const args = JSON.parse(toolCall.function.arguments);
          try {
            const { data: agendamento, error: findErr } = await supabaseAdmin
              .from('agendamentos')
              .select('id, paciente_telefone, data_hora, observacao')
              .eq('id', args.agendamento_id)
              .eq('clinic_id', conversa.clinic_id)
              .single();

            if (findErr || !agendamento) throw new Error("Agendamento não encontrado.");
            if (agendamento.paciente_telefone !== recipientPhone) throw new Error("Agendamento pertence a outro paciente.");

            const { error: updateErr } = await supabaseAdmin
              .from('agendamentos')
              .update({ data_hora: args.nova_data_hora_iso, observacao: `${agendamento.observacao || ''} [Reagendado de ${agendamento.data_hora}]` })
              .eq('id', args.agendamento_id);

            if (updateErr) throw new Error("Erro ao reagendar: " + updateErr.message);
            toolResponseText = `Agendamento reagendado com sucesso para ${args.nova_data_hora_iso}.`;
            console.log("Agendamento reagendado via Tool!");
          } catch (e: any) {
            console.error("Tool reagendar_consulta failed:", e);
            toolResponseText = `Falha ao reagendar: ${e.message}`;
          }

        } else if (toolCall.function.name === 'solicitar_atendente') {
          const args = JSON.parse(toolCall.function.arguments);
          try {
            await supabaseAdmin
              .from('conversas')
              .update({ status: 'handoff', handoff_motivo: args.motivo || 'Solicitado pelo paciente' })
              .eq('id', conversa_id);

            toolResponseText = `Conversa transferida para atendente humano. Motivo: ${args.motivo || 'solicitado pelo paciente'}`;
            console.log("Handoff realizado!");
          } catch (e: any) {
            console.error("Tool solicitar_atendente failed:", e);
            toolResponseText = `Falha ao transferir: ${e.message}`;
          }
        }

        // Push the tool result to OpenAI
        messagesForAI.push({
          tool_call_id: toolCall.id,
          role: "tool",
          name: toolCall.function.name,
          content: toolResponseText,
        });
      }

      // Second call to OpenAI with tool results
      aiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openAiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: messagesForAI,
          temperature: 0.7,
        }),
      });

      aiData = await aiResponse.json();
      replyText = aiData.choices?.[0]?.message?.content;
    }

    if (!replyText) {
      throw new Error('OpenAI returned an empty reply after tools processing');
    }

    console.log('Final AI reply generated:', replyText.substring(0, 80));

    // ── 6. Save Final AI reply to DB ─────────────────────────────────────────
    const { error: insertRepError } = await supabaseAdmin
      .from('mensagens')
      .insert({
        conversa_id,
        role: 'assistant',
        conteudo: replyText,
      });

    if (insertRepError) throw new Error('Error saving AI reply: ' + insertRepError.message);

    // ── 7. Send reply back via Evolution API ─────────────────────────────────
    const evolutionUrl = Deno.env.get('EVOLUTION_API_URL');
    const evolutionKey = Deno.env.get('EVOLUTION_API_KEY');

    if (!evolutionUrl || !evolutionKey) {
      throw new Error('Secrets EVOLUTION_API_URL or EVOLUTION_API_KEY are not configured');
    }

    const recipientFormatPhone = conversa.paciente_telefone.replace('@s.whatsapp.net', '').replace('@c.us', '');

    // Map clinic_id back to the Evolution API instance name
    const CLINIC_TO_INSTANCE: Record<string, string> = {
      '06a40c64-48a4-4836-a3ea-8a8ced0492e4': 'ca57fb17-5661-4c85-9d1a-853720c8acff',
    };
    const instanceName = CLINIC_TO_INSTANCE[conversa.clinic_id] || conversa.clinic_id;

    const sendRes = await fetch(`${evolutionUrl}/message/sendText/${instanceName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': evolutionKey,
      },
      body: JSON.stringify({
        number: recipientFormatPhone,
        text: replyText,
        delay: 1500,
      }),
    });

    const sendBody = await sendRes.text();

    if (!sendRes.ok) {
      console.error(`Evolution API send failed (${sendRes.status}):`, sendBody);
      return new Response(JSON.stringify({
        success: false,
        warning: `Message saved in DB but WhatsApp delivery failed: ${sendBody}`,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      });
    }

    console.log('✅ Reply sent successfully via WhatsApp. conversa_id:', conversa_id);

    return new Response(JSON.stringify({ success: true, replyText }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });

  } catch (error) {
    console.error('process-message Error:', String(error));
    return new Response(JSON.stringify({ error: String(error) }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });
  }
})

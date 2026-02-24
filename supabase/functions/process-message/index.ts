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

    // ── 1. Fetch the conversation ────────────────────────────────────────────
    const { data: conversa, error: conversaError } = await supabaseAdmin
      .from('conversas')
      .select('*')
      .eq('id', conversa_id)
      .single();

    if (conversaError || !conversa) {
      throw new Error('Conversa not found: ' + conversa_id);
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
Quando o paciente quiser marcar uma consulta, você DEVE coletar as seguintes informações:
1. Nome completo.
2. Data e hora desejada para o agendamento.
3. Qual o procedimento ou motivo da consulta.
O telefone já possuímos. Assim que você tiver todas essas informações confirmadas pelo paciente, VOCÊ DEVE EXECUTAR A FUNÇÃO "agendar_consulta" para salvar o agendamento no sistema. 
IMPORTANTE: Nunca invente horários. Confirme sempre o horário exato que o paciente quer antes de invocar a função.
A data e hora enviadas para a função devem estar no formato ISO 8601 (ex: 2024-03-10T14:30:00-03:00). A data atual é ${new Date().toISOString()}.`;

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
        if (toolCall.function.name === 'agendar_consulta') {
          const args: AgendarConsultaData = JSON.parse(toolCall.function.arguments);
          let toolResponseText = "";

          try {
            // Check if patient exists by phone
            let paciente_id = null;
            const recipientPhone = conversa.paciente_telefone.replace('@s.whatsapp.net', '').replace('@c.us', '');
            
            let { data: patientData, error: patientSearchError } = await supabaseAdmin
              .from('pacientes')
              .select('id')
              .eq('clinic_id', conversa.clinic_id)
              .eq('telefone', recipientPhone)
              .maybeSingle();
              
            if (!patientData) {
              // Create new patient
               const { data: newPatient, error: newPatientError } = await supabaseAdmin
                .from('pacientes')
                .insert({
                  clinic_id: conversa.clinic_id,
                  nome: args.nome_paciente,
                  telefone: recipientPhone
                })
                .select('id')
                .single();
                
              if (newPatientError) throw new Error("Erro ao criar paciente: " + newPatientError.message);
              paciente_id = newPatient.id;
            } else {
              paciente_id = patientData.id;
              // update existing patient name if provided
              await supabaseAdmin.from('pacientes').update({ nome: args.nome_paciente }).eq('id', paciente_id);
            }

            // Insert Appointment
            const { error: insertAppointmentError } = await supabaseAdmin
              .from('agendamentos')
              .insert({
                clinic_id: conversa.clinic_id,
                conversa_id: conversa_id,
                paciente_id: paciente_id,
                duracao_min: args.duracao_minutos || 30,
                observacao: args.procedimento_esperado,
                data_hora: args.data_hora_iso,
                status: 'marcado',
                paciente_nome: args.nome_paciente, // fallback 
                paciente_telefone: recipientPhone // fallback
              });

            if (insertAppointmentError) {
              throw new Error("Erro de banco de dados ao agendar: " + insertAppointmentError.message);
            }
            
            toolResponseText = `O agendamento foi realizado com sucesso no sistema para o dia ${args.data_hora_iso}.`;
            console.log("Agendamento criado via Tool com sucesso!");

          } catch (e: any) {
            console.error("Tool execution failed: ", e);
            toolResponseText = "Falha ao gravar agendamento no sistema. Diga que ocorreu um erro interno e peça para tentar mais tarde.";
          }

          // Push the tool result to OpenAI to get the final humanized text response
          messagesForAI.push({
            tool_call_id: toolCall.id,
            role: "tool",
            name: toolCall.function.name,
            content: toolResponseText,
          });
        }
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
    const instanceName = conversa.clinic_id;

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

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

interface SaoPauloDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekdayLong: string;
  weekdayKey: string;
  dateKey: string;
  timeKey: string;
}

const SAO_PAULO_TZ = 'America/Sao_Paulo';

const WEEKDAY_TO_CONFIG_KEY: Record<string, string> = {
  'segunda-feira': 'segunda',
  'segunda': 'segunda',
  'terça-feira': 'terca',
  'terca-feira': 'terca',
  'terça': 'terca',
  'terca': 'terca',
  'quarta-feira': 'quarta',
  'quarta': 'quarta',
  'quinta-feira': 'quinta',
  'quinta': 'quinta',
  'sexta-feira': 'sexta',
  'sexta': 'sexta',
  'sábado': 'sabado',
  'sabado': 'sabado',
  'domingo': 'domingo',
};

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return NaN;
  return h * 60 + m;
}

function timeRangesOverlap(startA: number, endA: number, startB: number, endB: number): boolean {
  return startA < endB && endA > startB;
}

function parseIsoInputToDate(isoInput: string): Date {
  const normalized = (isoInput ?? '').trim().replace(' ', 'T');
  const hasOffset = /(?:[zZ]|[+-]\d{2}:\d{2})$/.test(normalized);
  return new Date(hasOffset ? normalized : `${normalized}-03:00`);
}

function getSaoPauloParts(date: Date): SaoPauloDateParts {
  const formatter = new Intl.DateTimeFormat('pt-BR', {
    timeZone: SAO_PAULO_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'long',
    hour12: false,
    hourCycle: 'h23',
  });

  const map = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );

  const weekdayLong = String(map.weekday ?? '').toLowerCase();
  const year = Number(map.year);
  const month = Number(map.month);
  const day = Number(map.day);
  const hour = Number(map.hour);
  const minute = Number(map.minute);
  const second = Number(map.second);

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    weekdayLong,
    weekdayKey: WEEKDAY_TO_CONFIG_KEY[weekdayLong] || weekdayLong,
    dateKey: `${map.year}-${map.month}-${map.day}`,
    timeKey: `${map.hour}:${map.minute}`,
  };
}

function buildSaoPauloIso(year: number, month: number, day: number, hour: number, minute: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:00-03:00`;
}

function formatDateTimeSP(date: Date): string {
  return date.toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: SAO_PAULO_TZ,
  });
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
    // Wait for more messages to arrive (concatenation)
    const jitter = Math.floor(Math.random() * 1500);
    await new Promise(resolve => setTimeout(resolve, 4000 + jitter));

    // Check if there are any NEWER user messages since this one started
    const { data: newerMsg } = await supabaseAdmin
      .from('mensagens')
      .select('id')
      .eq('conversa_id', conversa_id)
      .eq('role', 'user')
      .gt('created_at', payload.record.created_at) // Check if anything arrived AFTER this message
      .limit(1)
      .maybeSingle();

    if (newerMsg) {
      console.log('Debounced: a newer message was found.', { messageId, newerId: newerMsg.id });
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

    // ── 2. Fetch the clinic's custom AI prompt & Agenda Config ───────────────
    const { data: clinica } = await supabaseAdmin
      .from('clinicas')
      .select('prompt, nome, cobrar_sinal, valor_sinal, chave_pix')
      .eq('id', conversa.clinic_id)
      .single();

    const { data: configAgenda } = await supabaseAdmin
      .from('configuracoes_clinica')
      .select('*')
      .eq('clinic_id', conversa.clinic_id)
      .single();

    // ── 2.1 Fetch patient's active appointments to provide immediate context ─
    const recipientPhoneContext = conversa.paciente_telefone.replace('@s.whatsapp.net', '').replace('@c.us', '');
    const { data: agendamentosAtivos } = await supabaseAdmin
      .from('agendamentos')
      .select('id, data_hora, status, observacao')
      .eq('clinic_id', conversa.clinic_id)
      .eq('paciente_telefone', recipientPhoneContext)
      .in('status', ['marcado', 'confirmado'])
      .order('data_hora', { ascending: true });

    let agendamentosContextText = "O paciente NÃO possui consultas ativas agendadas no momento.";
    if (agendamentosAtivos && agendamentosAtivos.length > 0) {
      const listAgs = agendamentosAtivos.map((a: any, i: number) => {
        const dt = new Date(a.data_hora);
        const dataFormatada = formatDateTimeSP(dt);
        return `${i + 1}. Data: ${dataFormatada} | Procedimento: ${a.observacao || 'Consulta'} [ref:${a.id}] | Status: ${a.status}`;
      }).join('\n');
      agendamentosContextText = `CONSULTAS AGENDADAS ATIVAS DO PACIENTE:\n${listAgs}\n* IMPORTANTE: Não revele o código [ref:...], use-o apenas se for cancelar/reagendar.`;
    }

    // ── 2.2 Fetch patient's registration to recognize them instantly ──────────
    const { data: pacienteRecord, error: pacienteError } = await supabaseAdmin
      .from('pacientes')
      .select('nome')
      .eq('clinic_id', conversa.clinic_id)
      .eq('telefone', recipientPhoneContext)
      .limit(1)
      .maybeSingle();

    if (pacienteError) {
      console.warn("Aviso: Falha ao buscar paciente:", pacienteError);
    }

    const pacienteContextText = pacienteRecord
      ? `DADOS DE CADASTRO DO PACIENTE:\nO paciente já é cliente da clínica. O nome dele(a) no nosso cadastro é: ${pacienteRecord.nome}. Se ele(a) quiser agendar algo, você NÃO precisa perguntar o nome novamente, basta confirmar se o agendamento é para ele(a) mesmo(a).`
      : `DADOS DE CADASTRO DO PACIENTE:\nPaciente novo, ainda não possui cadastro.`;

    // Adiciona instruções sistêmicas para a IA saber agendar
    const diasSemanaOrdenados = ['segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado', 'domingo'];
    const diasNomesMap: Record<string, string> = {
      segunda: 'Segunda-feira', terca: 'Terça-feira', quarta: 'Quarta-feira',
      quinta: 'Quinta-feira', sexta: 'Sexta-feira', sabado: 'Sábado', domingo: 'Domingo'
    };

    let hoursStr = 'Segunda a Sexta: 08:00-18:00';
    if (configAgenda?.horarios_trabalho) {
      hoursStr = diasSemanaOrdenados
        .map(d => {
          const h = configAgenda.horarios_trabalho[d];
          return h ? `${diasNomesMap[d]}: ${h.inicio}-${h.fim}` : `${diasNomesMap[d]}: Fechado`;
        })
        .join(', ');
    }

    const conveniosStr = configAgenda?.convenios_aceitos?.join(', ') || 'Particular';

    const nowSP = getSaoPauloParts(new Date());
    const configHoje = configAgenda?.horarios_trabalho?.[nowSP.weekdayKey];

    let isClosedNow = true;
    if (configHoje && configHoje.inicio && configHoje.fim) {
      const minAgora = nowSP.hour * 60 + nowSP.minute;
      const inicioMin = toMinutes(configHoje.inicio);
      const fimMin = toMinutes(configHoje.fim);
      const emIntervalo = (configAgenda?.intervalos || []).some((intervalo: any) => {
        const intervaloInicio = toMinutes(intervalo.inicio);
        const intervaloFim = toMinutes(intervalo.fim);
        if (!Number.isFinite(intervaloInicio) || !Number.isFinite(intervaloFim)) return false;
        return minAgora >= intervaloInicio && minAgora < intervaloFim;
      });

      if (Number.isFinite(inicioMin) && Number.isFinite(fimMin) && minAgora >= inicioMin && minAgora < fimMin && !emIntervalo) {
        isClosedNow = false;
      }
    }

    let pixConfig = "";
    if (clinica?.cobrar_sinal && !isClosedNow) {
      pixConfig = `\n\nREGRAS DE PAGAMENTO (SINAL ANTI-FALTA ATIVADO):\n` +
        `Sempre que você criar um NOVO agendamento, INFORME EXPLICITAMENTE o paciente que ele precisa pagar um sinal de R$ ${clinica.valor_sinal} para garantir a consulta.\n` +
        `Envie a chave PIX: ${clinica.chave_pix} e peça para o paciente enviar o comprovante de pagamento no chat. A vaga ficará como "Pré-agendada" até a recepção confirmar.`;
    } else if (clinica?.cobrar_sinal && isClosedNow) {
      pixConfig = `\n\nREGRAS DE PAGAMENTO (MADRUGADA/FECHADO):\n` +
        `A clínica cobra sinal, MAS como estamos FORA DO EXPEDIENTE AGORA, você NÃO deve pedir o PIX nem enviar a chave.\n` +
        `Apenas informe que o agendamento foi pré-reservado e que a equipe enviará o PIX para confirmação assim que a clínica abrir.`;
    }

    const systemPromptBase = clinica?.prompt ||
      `Você é um assistente virtual da clínica "${clinica?.nome ?? 'médica'}". ` +
      `Responda de forma direta, resolutiva e natural. Não seja robótico e NÃO repita frases clichês de atendimento como "Estou aqui para ajudar", aja como uma recepcionista humana normal. ` +
      `Ajude com agendamentos, informações e dúvidas gerais.`;

    const systemPrompt = systemPromptBase +
      `\n\n${pacienteContextText}` +
      `\n\nCONTEXTO IMEDIATO DO PACIENTE:\n${agendamentosContextText}` +
      `\n\nHORÁRIOS DA CLÍNICA: ${hoursStr}` +
      `\nCONVÊNIOS ACEITOS: ${conveniosStr}` +
      pixConfig +
      `\n\nINSTRUÇÕES DE AGENDAMENTO E PROATIVIDADE:
- Quando o paciente quiser marcar uma consulta, você DEVE coletar as informações pendentes, MAS seja ágil.
- REGRAS DE CONVÊNIO: NENHUM procedimento estético (Botox, Limpeza de Pele, Preenchimento, Depilação, etc) tem cobertura de convênio. Portanto, SE o paciente pedir um desses, NUNCA pergunte se ele tem convênio! Assuma que é particular.
- DADOS OBRIGATÓRIOS PARA AGENDAR: 1) Nome (se não tiver no cadastro, peça apenas o nome), 2) Convênio (apenas para consultas dermatológicas), 3) Data/Hora desejada, 4) Procedimento.
- PROATIVIDADE COM AGENDA: Se o paciente já disse o que quer e a data, use IMEDIATAMENTE "buscar_horarios_disponiveis" e mostre 3 opções de horário livres de forma animada e direta.
- ESTADO ATUAL DA CLÍNICA: ${isClosedNow ? 'FECHADA' : 'ABERTA'}.
- REGRAS SE ESTADO FOR FECHADA AGORA:
  1. No final do atendimento, informe que deixou pré-reservado e que a atendente chamará para confirmar o PIX quando abrirem.
  2. **PROIBIDO** enviar chave PIX agora.
- O telefone já possuímos.
- DATA E HORA EM SP (USE PARA NÃO SE PERDER NO CALENDÁRIO): ${nowSP.weekdayLong}, ${pad2(nowSP.day)}/${pad2(nowSP.month)}/${nowSP.year} às ${pad2(nowSP.hour)}:${pad2(nowSP.minute)}.
- Formato ISO 8601 exigido pelas ferramentas.

CONSULTA E CANCELAMENTO:
- O paciente JÁ PODE TER consultas listadas no "CONTEXTO IMEDIATO". Se ele perguntar se tem consulta, apenas leia os dados do contexto (O que, Quando, Onde e Com Quem). Não invente nem chame ferramentas extras para consultar se os dados já estiverem ali.
- IMPORTANTE: NÃO existe ferramenta para cancelar agendamentos!
- Se o paciente pedir para CANCELAR uma consulta, seja empático e humano. ** NÃO faça o handoff imediatamente ** e NÃO diga frases robóticas como "preciso verificar horários para possível remarcação".
- PASSO 1 (Retenção humana): A forma correta de agir na primeira resposta é ser atencioso e sugerir a remarcação de forma natural, sem chamar nenhuma ferramenta ainda. Exemplo: "Poxa, que pena que não vai dar pra você ir na data marcada! 😔 Podemos tentar remarcar para uma data ou horário que fique melhor pra você, o que acha?".
- PASSO 2 (Espera): ** ESPERE O PACIENTE RESPONDER **. Não ofereça encaminhar para o atendente ainda e não cite que está fazendo testes / procedimentos do sistema.
- PASSO 3 (Decisão):
  - Se ele aceitar a sugestão de remarcar ou perguntar as datas: ÓTIMO! Agora sim você usa a ferramenta "buscar_horarios_disponiveis", mostra opções e depois usa "reagendar_consulta".
  - Se ele recusar (disser "não", "quero cancelar mesmo", "agora não posso", etc.): "Entendo! Tudo bem. 😊 Vou transferir para uma de nossas atendentes para prosseguir com o cancelamento pra você, só um minutinho!" e USE "solicitar_atendente" with the reason "Paciente deseja cancelar consulta (recusou remarcação)".

CONFIRMAÇÃO DE CONSULTA (FLUXO PRINCIPAL APÓS LEMBRETE):
- Quando o paciente responder confirmando presença, USE "confirmar_consulta".
- Interprete a INTENÇÃO naturalmente.
- Após confirmar, agradeça e diga que esperamos o paciente.

HANDOFF PARA HUMANO:
Se o paciente pedir para cancelar, pedir para falar com um humano, ou se você não souber resolver o problema, USE "solicitar_atendente".`;

    // ── 3. Fetch conversation history (last 15 messages for context) ─────────
    const { data: history, error: historyError } = await supabaseAdmin
      .from('mensagens')
      .select('role, conteudo')
      .eq('conversa_id', conversa_id)
      .order('created_at', { ascending: false })
      .limit(15);

    if (history) {
      history.reverse();
    }

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
          description: "Busca os agendamentos existentes do paciente na clínica pelo número de telefone. Use quando o paciente perguntar quais consultas tem agendadas.",
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
      },
      {
        type: "function",
        function: {
          name: "confirmar_consulta",
          description: "Confirma a presença do paciente em uma consulta agendada. Use quando o paciente responder afirmativamente a um lembrete de consulta (ex: sim, ok, confirmado, pode ser, vou sim, beleza, show, bora, combinado, etc).",
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
          name: "buscar_horarios_disponiveis",
          description: "Busca os próximos horários disponíveis na agenda da clínica para reagendamento. Use quando o paciente quiser remarcar uma consulta, para sugerir as datas mais próximas.",
          parameters: {
            type: "object",
            properties: {
              dias_a_frente: { type: "number", description: "Quantos dias à frente buscar (padrão 5)", default: 5 }
            },
            required: []
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
      throw new Error(`OpenAI API Error(${aiResponse.status}): ${errBody}`);
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
            // ── VALIDATION: Work Hours & Conflicts ──
            const dataAgendamento = parseIsoInputToDate(args.data_hora_iso);
            if (Number.isNaN(dataAgendamento.getTime())) {
              toolResponseText = 'ERRO: data/hora inválida. Peça ao paciente para informar novamente o horário desejado.';
              console.log('Validation failed: invalid date input.', args.data_hora_iso);
              continue;
            }

            const duracaoMinutos = Number(args.duracao_minutos) > 0 ? Number(args.duracao_minutos) : 30;
            const agendamentoSP = getSaoPauloParts(dataAgendamento);
            const diaSemana = agendamentoSP.weekdayKey;
            const horaAgendamento = agendamentoSP.timeKey;
            const inicioSolicitadoMin = agendamentoSP.hour * 60 + agendamentoSP.minute;
            const fimSolicitadoMin = inicioSolicitadoMin + duracaoMinutos;

            const configDia = configAgenda?.horarios_trabalho?.[diaSemana];
            const inicioExpedienteMin = configDia?.inicio ? toMinutes(configDia.inicio) : NaN;
            const fimExpedienteMin = configDia?.fim ? toMinutes(configDia.fim) : NaN;

            // 1. Check if it's a workday and within hours
            if (!configDia || !configDia.inicio || !configDia.fim) {
              toolResponseText = `ERRO: A clínica não atende neste horário(${diaSemana}, ${horaAgendamento}). Na ${diaSemana}, não atendemos nesse dia. Peça ao paciente para escolher outro horário.`;
              console.log('Validation failed: no workday configuration.');
            } else if (!Number.isFinite(inicioExpedienteMin) || !Number.isFinite(fimExpedienteMin)) {
              toolResponseText = 'ERRO: A agenda da clínica está com horário inválido para este dia. Oriente o paciente a falar com a recepção.';
              console.log('Validation failed: invalid schedule configuration.');
            } else if (inicioSolicitadoMin < inicioExpedienteMin || fimSolicitadoMin > fimExpedienteMin) {
              const infoHours = configDia ? `atendemos das ${configDia.inicio} às ${configDia.fim} ` : "não atendemos nesse dia";
              toolResponseText = `ERRO: A clínica não atende neste horário(${diaSemana}, ${horaAgendamento}).Na ${diaSemana}, ${infoHours}. Peça ao paciente para escolher outro horário.`;
              console.log("Validation failed: Outside work hours.");
            }
            // 2. Check Lunch Break (Intervalos)
            else if ((configAgenda?.intervalos || []).some((int: any) => {
              const intervaloInicio = toMinutes(int.inicio);
              const intervaloFim = toMinutes(int.fim);
              if (!Number.isFinite(intervaloInicio) || !Number.isFinite(intervaloFim)) return false;
              return timeRangesOverlap(inicioSolicitadoMin, fimSolicitadoMin, intervaloInicio, intervaloFim);
            })) {
              toolResponseText = `ERRO: O horário solicitado(${horaAgendamento}) cai no intervalo da clínica.Peça ao paciente para escolher outro horário.`;
              console.log("Validation failed: Lunch break.");
            }
            // 3. Check for Conflicts
            else {
              const janelaInicio = new Date(dataAgendamento.getTime() - 24 * 60 * 60 * 1000).toISOString();
              const janelaFim = new Date(dataAgendamento.getTime() + 24 * 60 * 60 * 1000).toISOString();

              const { data: conflitos, error: conflitoError } = await supabaseAdmin
                .from('agendamentos')
                .select('id, data_hora, duracao_min')
                .eq('clinic_id', conversa.clinic_id)
                .gte('data_hora', janelaInicio)
                .lte('data_hora', janelaFim)
                .in('status', ['marcado', 'confirmado'])
                .order('data_hora', { ascending: true });

              if (conflitoError) {
                throw new Error('Erro ao verificar conflitos: ' + conflitoError.message);
              }

              const novoInicioMs = dataAgendamento.getTime();
              const novoFimMs = novoInicioMs + duracaoMinutos * 60 * 1000;

              const temConflito = (conflitos || []).some((existente: any) => {
                const inicioExistenteMs = parseIsoInputToDate(existente.data_hora).getTime();
                if (Number.isNaN(inicioExistenteMs)) return false;
                const duracaoExistente = Number(existente.duracao_min) > 0 ? Number(existente.duracao_min) : 30;
                const fimExistenteMs = inicioExistenteMs + duracaoExistente * 60 * 1000;
                return timeRangesOverlap(novoInicioMs, novoFimMs, inicioExistenteMs, fimExistenteMs);
              });

              if (temConflito) {
                toolResponseText = `ERRO: Já existe uma consulta marcada para este horário(${args.data_hora_iso}).Sugira outro horário ao paciente.`;
                console.log("Validation failed: Scheduling conflict.");
              } else {
                // All clear - proceed with booking
                let paciente_id = null;
                // rest of the original logic...

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

                const pagStatus = clinica?.cobrar_sinal ? 'pendente' : 'nao_aplicavel';

                const { error: insertErr } = await supabaseAdmin
                  .from('agendamentos')
                  .insert({
                    clinic_id: conversa.clinic_id, conversa_id, paciente_id,
                    duracao_min: duracaoMinutos, observacao: args.procedimento_esperado,
                    data_hora: dataAgendamento.toISOString(), status: 'marcado', pagamento_status: pagStatus,
                    paciente_nome: args.nome_paciente, paciente_telefone: recipientPhone
                  });
                if (insertErr) throw new Error("Erro ao agendar: " + insertErr.message);

                if (clinica?.cobrar_sinal) {
                  const valorSinal = clinica.valor_sinal ?? '0,00';
                  const chavePix = clinica.chave_pix ?? '[não configurada]';
                  toolResponseText = `Agendamento pré - reservado para o dia ${args.data_hora_iso}. AVISE O PACIENTE que ele precisa pagar o sinal de R$ ${valorSinal} na chave PIX ${chavePix} para garantir a vaga e peça o comprovante.`;
                } else {
                  toolResponseText = `O agendamento foi realizado com sucesso no sistema para o dia ${args.data_hora_iso}.`;
                }

                console.log("Agendamento criado via Tool com sucesso!");
              }
            }
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
                const dataFormatada = formatDateTimeSP(dt);
                return `${i + 1}.Data: ${dataFormatada} | Procedimento: ${a.observacao || 'Consulta'} [ref: ${a.id}]`;
              }).join('\n');
              toolResponseText = `Agendamentos encontrados: \n${lista} \n\nIMPORTANTE: Ao apresentar ao paciente, mostre APENAS o número, data e procedimento.NÃO mostre o código[ref:...], ele é apenas para uso interno.`;
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
              .update({ status: 'cancelado', observacao: `${agendamento.observacao || ''}[CANCELADO: ${args.motivo || 'a pedido do paciente'}]` })
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
              .update({ data_hora: args.nova_data_hora_iso, observacao: `${agendamento.observacao || ''}[Reagendado de ${agendamento.data_hora}]` })
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

            toolResponseText = `Conversa transferida para atendente humano.Motivo: ${args.motivo || 'solicitado pelo paciente'}`;
            console.log("Handoff realizado!");
          } catch (e: any) {
            console.error("Tool solicitar_atendente failed:", e);
            toolResponseText = `Falha ao transferir: ${e.message}`;
          }

        } else if (toolCall.function.name === 'confirmar_consulta') {
          try {
            // Buscar próximo agendamento do paciente
            const { data: proximoAg } = await supabaseAdmin
              .from('agendamentos')
              .select('id, data_hora, observacao')
              .eq('clinic_id', conversa.clinic_id)
              .eq('paciente_telefone', recipientPhone)
              .eq('status', 'marcado')
              .gte('data_hora', new Date().toISOString())
              .order('data_hora', { ascending: true })
              .limit(1)
              .maybeSingle();

            if (!proximoAg) {
              toolResponseText = 'Não encontrei nenhuma consulta pendente de confirmação para este paciente.';
            } else {
              await supabaseAdmin
                .from('agendamentos')
                .update({ status: 'confirmado' })
                .eq('id', proximoAg.id);

              const dtFormatada = new Date(proximoAg.data_hora).toLocaleDateString('pt-BR', {
                day: '2-digit', month: '2-digit', year: 'numeric',
                hour: '2-digit', minute: '2-digit',
                timeZone: SAO_PAULO_TZ
              });
              toolResponseText = `Consulta confirmada com sucesso! Data: ${dtFormatada}.Procedimento: ${proximoAg.observacao || 'Consulta'}.`;
              console.log('Consulta confirmada via Tool!', proximoAg.id);
            }
          } catch (e: any) {
            console.error('Tool confirmar_consulta failed:', e);
            toolResponseText = `Falha ao confirmar consulta: ${e.message}`;
          }

        } else if (toolCall.function.name === 'buscar_horarios_disponiveis') {
          try {
            const args = JSON.parse(toolCall.function.arguments || '{}');
            const diasAFrenteRaw = Number(args.dias_a_frente);
            const diasAFrente = Number.isFinite(diasAFrenteRaw) && diasAFrenteRaw > 0
              ? Math.min(Math.floor(diasAFrenteRaw), 14)
              : 5;
            const duracaoPadraoMin = 30;

            // Buscar agendamentos existentes nos próximos X dias
            const agora = new Date();
            const limite = new Date(agora.getTime() + diasAFrente * 24 * 60 * 60 * 1000);

            const { data: agExistentes, error: agExistentesError } = await supabaseAdmin
              .from('agendamentos')
              .select('data_hora, duracao_min')
              .eq('clinic_id', conversa.clinic_id)
              .in('status', ['marcado', 'confirmado'])
              .gte('data_hora', agora.toISOString())
              .lte('data_hora', limite.toISOString());

            if (agExistentesError) {
              throw new Error('Erro ao consultar agenda existente: ' + agExistentesError.message);
            }

            const intervalosOcupados = (agExistentes || []).map((agendamento: any) => {
              const inicioMs = parseIsoInputToDate(agendamento.data_hora).getTime();
              const duracaoMin = Number(agendamento.duracao_min) > 0 ? Number(agendamento.duracao_min) : duracaoPadraoMin;
              return {
                inicioMs,
                fimMs: inicioMs + duracaoMin * 60 * 1000,
              };
            }).filter((intervalo: any) => !Number.isNaN(intervalo.inicioMs) && !Number.isNaN(intervalo.fimMs));

            // Gerar slots disponíveis baseado nos horários da clínica
            const slotsDisponiveis: string[] = [];
            const diasProcessados = new Set<string>();

            for (let deslocamento = 0; diasProcessados.size < diasAFrente && slotsDisponiveis.length < 10; deslocamento++) {
              const diaRef = new Date(agora.getTime() + deslocamento * 24 * 60 * 60 * 1000);
              const diaSP = getSaoPauloParts(diaRef);
              if (diasProcessados.has(diaSP.dateKey)) continue;
              diasProcessados.add(diaSP.dateKey);

              const configDia = configAgenda?.horarios_trabalho?.[diaSP.weekdayKey];
              if (!configDia || !configDia.inicio || !configDia.fim) continue; // dia sem expediente

              const minInicioTotal = toMinutes(configDia.inicio);
              const minFimTotal = toMinutes(configDia.fim);
              if (!Number.isFinite(minInicioTotal) || !Number.isFinite(minFimTotal)) continue;

              // Gerar slots de 30 min
              for (let totalMin = minInicioTotal; totalMin + duracaoPadraoMin <= minFimTotal; totalMin += 30) {
                const h = Math.floor(totalMin / 60);
                const m = totalMin % 60;
                const inicioSlotMin = totalMin;
                const fimSlotMin = totalMin + duracaoPadraoMin;

                // Pular intervalos (almoço)
                if ((configAgenda?.intervalos || []).some((intervalo: any) => {
                  const inicioIntervalo = toMinutes(intervalo.inicio);
                  const fimIntervalo = toMinutes(intervalo.fim);
                  if (!Number.isFinite(inicioIntervalo) || !Number.isFinite(fimIntervalo)) return false;
                  return timeRangesOverlap(inicioSlotMin, fimSlotMin, inicioIntervalo, fimIntervalo);
                })) {
                  continue;
                }

                const slotDate = new Date(buildSaoPauloIso(diaSP.year, diaSP.month, diaSP.day, h, m));
                if (Number.isNaN(slotDate.getTime())) continue;

                // Se o slot for hoje, verificar se já passou do horário atual
                if (slotDate.getTime() <= agora.getTime()) {
                  continue;
                }

                const slotInicioMs = slotDate.getTime();
                const slotFimMs = slotInicioMs + duracaoPadraoMin * 60 * 1000;
                const conflita = intervalosOcupados.some((intervalo: any) =>
                  timeRangesOverlap(slotInicioMs, slotFimMs, intervalo.inicioMs, intervalo.fimMs)
                );
                if (conflita) continue;

                const dtFormatada = slotDate.toLocaleDateString('pt-BR', {
                  weekday: 'long',
                  day: '2-digit',
                  month: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                  timeZone: SAO_PAULO_TZ
                });
                slotsDisponiveis.push(`${dtFormatada}(ISO: ${slotDate.toISOString()})`);

                if (slotsDisponiveis.length >= 10) break;
              }
              if (slotsDisponiveis.length >= 10) break;
            }

            if (slotsDisponiveis.length === 0) {
              toolResponseText = 'Não encontrei horários disponíveis nos próximos dias. Sugira ao paciente entrar em contato com a clínica para verificar disponibilidade em datas mais distantes.';
            } else {
              toolResponseText = `Horários disponíveis mais próximos: \n${slotsDisponiveis.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\nApresente as 3 - 4 opções mais próximas ao paciente de forma amigável, SEM mostrar o formato ISO.Quando o paciente escolher, use reagendar_consulta com o ISO correspondente.`;
            }
            console.log('Busca de horários realizada:', slotsDisponiveis.length, 'slots encontrados');
          } catch (e: any) {
            console.error('Tool buscar_horarios_disponiveis failed:', e);
            toolResponseText = `Falha ao buscar horários: ${e.message}`;
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

    // A instância na Evolution API usa o próprio clinic_id como nome
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
      console.error(`Evolution API send failed(${sendRes.status}): `, sendBody);
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

  } catch (err: any) {
    console.error('Function execution error:', err);
    return new Response(JSON.stringify({
      error: err.message,
      stack: err.stack,
      details: err.toString()
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});

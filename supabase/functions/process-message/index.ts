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

const WEEKDAY_LABELS: Record<string, string> = {
  segunda: 'segunda-feira',
  terca: 'terça-feira',
  quarta: 'quarta-feira',
  quinta: 'quinta-feira',
  sexta: 'sexta-feira',
  sabado: 'sábado',
  domingo: 'domingo',
};

const WEEKDAY_INPUT_ALIASES: Record<string, string> = {
  seg: 'segunda',
  segunda: 'segunda',
  segundafeira: 'segunda',
  ter: 'terca',
  terca: 'terca',
  tercafeira: 'terca',
  qua: 'quarta',
  quarta: 'quarta',
  quartafeira: 'quarta',
  qui: 'quinta',
  quinta: 'quinta',
  quintafeira: 'quinta',
  sex: 'sexta',
  sexta: 'sexta',
  sextafeira: 'sexta',
  sab: 'sabado',
  sabado: 'sabado',
  dom: 'domingo',
  domingo: 'domingo',
};

const WEEKDAY_ORDER = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];

const PERIOD_INPUT_ALIASES: Record<string, 'manha' | 'tarde' | 'noite'> = {
  manha: 'manha',
  manham: 'manha',
  manhazinha: 'manha',
  matutino: 'manha',
  tarde: 'tarde',
  vespertino: 'tarde',
  noite: 'noite',
  noturno: 'noite',
};

const PERIOD_LABELS: Record<'manha' | 'tarde' | 'noite', string> = {
  manha: 'manhã',
  tarde: 'tarde',
  noite: 'noite',
};

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function normalizeTextKey(input: unknown): string {
  return String(input ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function normalizeWeekdayInput(input: unknown): string | null {
  const key = normalizeTextKey(input);
  if (!key) return null;
  return WEEKDAY_INPUT_ALIASES[key] || null;
}

function normalizePeriodInput(input: unknown): 'manha' | 'tarde' | 'noite' | null {
  const key = normalizeTextKey(input);
  if (!key) return null;
  return PERIOD_INPUT_ALIASES[key] || null;
}

function extractWeekdayFromText(input: string): string | null {
  const normalized = normalizeTextKey(input);
  if (!normalized) return null;

  for (const [alias, weekday] of Object.entries(WEEKDAY_INPUT_ALIASES)) {
    if (normalized.includes(alias)) return weekday;
  }

  return null;
}

function extractPeriodFromText(input: string): 'manha' | 'tarde' | 'noite' | null {
  const normalized = normalizeTextKey(input);
  if (!normalized) return null;

  for (const [alias, period] of Object.entries(PERIOD_INPUT_ALIASES)) {
    if (normalized.includes(alias)) return period;
  }

  return null;
}

function textLooksLikeAvailabilityIntent(input: string): boolean {
  const normalized = normalizeTextKey(input);
  if (!normalized) return false;
  return (
    normalized.includes('horariodisponivel') ||
    normalized.includes('horariosdisponiveis') ||
    normalized.includes('horarioslivres') ||
    normalized.includes('melhorhorario') ||
    normalized.includes('quantoantes') ||
    normalized.includes('maiscedo') ||
    normalized.includes('primeirohorario') ||
    normalized.includes('quaishorarios') ||
    normalized.includes('temhorario') ||
    normalized.includes('temvaga') ||
    normalized.includes('vagas') ||
    normalized.includes('disponivel') ||
    normalized.includes('agenda')
  );
}

function textLooksLikeBookingIntent(input: string): boolean {
  const normalized = normalizeTextKey(input);
  if (!normalized) return false;
  return (
    normalized.includes('agendar') ||
    normalized.includes('agendamento') ||
    normalized.includes('marcarconsulta') ||
    normalized.includes('queroagendar') ||
    normalized.includes('queromarcar') ||
    normalized.includes('queroumaconsulta') ||
    normalized.includes('quantoantes') ||
    normalized.includes('maiscedo') ||
    normalized.includes('primeirohorario') ||
    normalized.includes('melhorhorario')
  );
}

function textLooksLikeAllDaysRequest(input: string): boolean {
  const normalized = normalizeTextKey(input);
  if (!normalized) return false;
  return (
    normalized.includes('todososdias') ||
    normalized.includes('todosdias') ||
    normalized.includes('diasdasemana') ||
    normalized.includes('semanainteira') ||
    normalized.includes('semanatoda')
  );
}

function textLooksLikeNextWeekRequest(input: string): boolean {
  const normalized = normalizeTextKey(input);
  if (!normalized) return false;
  return (
    normalized.includes('semanaquevem') ||
    normalized.includes('proximasemana') ||
    normalized.includes('semanaseguinte')
  );
}

function textLooksLikeCancelIntent(input: string): boolean {
  const normalized = normalizeTextKey(input);
  if (!normalized) return false;
  return (
    normalized.includes('cancelar') ||
    normalized.includes('cancela') ||
    normalized.includes('cancelamento') ||
    normalized.includes('cancelei') ||
    normalized.includes('cancelado') ||
    normalized.includes('canceladas') ||
    normalized.includes('cancelartudo')
  );
}

function textLooksLikeAppointmentStatusIntent(input: string): boolean {
  const normalized = normalizeTextKey(input);
  if (!normalized) return false;
  return (
    normalized.includes('tenhoconsulta') ||
    normalized.includes('eutenhoconsulta') ||
    normalized.includes('consultamarcada') ||
    normalized.includes('consultasmarcadas') ||
    normalized.includes('tenhoalgumaconsulta') ||
    normalized.includes('jaestoumarcado') ||
    normalized.includes('toagendado') ||
    normalized.includes('toagendada') ||
    normalized.includes('jaestouagendado') ||
    normalized.includes('jaestouagendada') ||
    normalized.includes('consultasqueeutenho') ||
    normalized.includes('quaisconsultaseutenho') ||
    normalized.includes('quaisconsultasqueeutenho') ||
    normalized.includes('saberasconsultas') ||
    normalized.includes('minhasconsultas') ||
    normalized.includes('consultascomvcs') ||
    normalized.includes('consultascomvoces')
  );
}

function extractDateIsoFromText(input: string, referenceYear: number): string | null {
  const directIso = input.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (directIso) {
    const candidate = `${directIso[1]}-${directIso[2]}-${directIso[3]}`;
    return normalizeDateKeyInput(candidate);
  }

  const brDate = input.match(/\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\b/);
  if (!brDate) return null;

  const day = Number(brDate[1]);
  const month = Number(brDate[2]);
  let year = referenceYear;

  if (brDate[3]) {
    const rawYear = Number(brDate[3]);
    if (String(rawYear).length === 2) {
      year = rawYear + 2000;
    } else {
      year = rawYear;
    }
  }

  const candidate = `${year}-${pad2(month)}-${pad2(day)}`;
  return normalizeDateKeyInput(candidate);
}

function getWeekdayLabel(weekdayKey: string): string {
  return WEEKDAY_LABELS[weekdayKey] || weekdayKey;
}

function getPeriodLabel(period: 'manha' | 'tarde' | 'noite'): string {
  return PERIOD_LABELS[period] || period;
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

function normalizeDateKeyInput(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  const raw = String(input).trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const dt = parseIsoInputToDate(raw);
  if (Number.isNaN(dt.getTime())) return null;
  return getSaoPauloParts(dt).dateKey;
}

function getNextWeekRange(nowDate: Date): { startDateKey: string; endDateKey: string; daysUntilStart: number } {
  const nowSP = getSaoPauloParts(nowDate);
  const currentWeekdayIndex = WEEKDAY_ORDER.indexOf(nowSP.weekdayKey);
  let daysUntilNextMonday = currentWeekdayIndex >= 0 ? (8 - currentWeekdayIndex) % 7 : 7;
  if (daysUntilNextMonday === 0) {
    daysUntilNextMonday = 7;
  }

  const todayStartSP = new Date(buildSaoPauloIso(nowSP.year, nowSP.month, nowSP.day, 0, 0));
  const nextMonday = new Date(todayStartSP.getTime() + daysUntilNextMonday * 24 * 60 * 60 * 1000);
  const nextSunday = new Date(nextMonday.getTime() + 6 * 24 * 60 * 60 * 1000);

  return {
    startDateKey: getSaoPauloParts(nextMonday).dateKey,
    endDateKey: getSaoPauloParts(nextSunday).dateKey,
    daysUntilStart: daysUntilNextMonday,
  };
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

function formatDateTimeSPWithWeekday(date: Date): string {
  return date.toLocaleDateString('pt-BR', {
    weekday: 'long',
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
    const nowMs = Date.now();
    const activeWindowStartIso = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
    const { data: agendamentosAtivosRaw } = await supabaseAdmin
      .from('agendamentos')
      .select('id, data_hora, status, observacao')
      .eq('clinic_id', conversa.clinic_id)
      .eq('paciente_telefone', recipientPhoneContext)
      .in('status', ['marcado', 'confirmado'])
      .gte('data_hora', activeWindowStartIso)
      .order('data_hora', { ascending: true });

    const agendamentosAtivos = (agendamentosAtivosRaw || []).filter((a: any) => {
      const ts = parseIsoInputToDate(a.data_hora).getTime();
      return Number.isFinite(ts) && ts >= nowMs;
    });

    const { data: canceladosRecentes } = await supabaseAdmin
      .from('agendamentos')
      .select('id, data_hora, status, observacao')
      .eq('clinic_id', conversa.clinic_id)
      .eq('paciente_telefone', recipientPhoneContext)
      .eq('status', 'cancelado')
      .gte('data_hora', new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString())
      .order('data_hora', { ascending: false })
      .limit(5);

    let agendamentosContextText = "O paciente NÃO possui consultas ativas FUTURAS agendadas no momento.";
    if (agendamentosAtivos && agendamentosAtivos.length > 0) {
      const listAgs = agendamentosAtivos.map((a: any, i: number) => {
        const dt = parseIsoInputToDate(a.data_hora);
        const dataFormatada = formatDateTimeSPWithWeekday(dt);
        return `${i + 1}. Data: ${dataFormatada} | Procedimento: ${a.observacao || 'Consulta'} [ref:${a.id}] | Status: ${a.status}`;
      }).join('\n');
      agendamentosContextText = `CONSULTAS AGENDADAS ATIVAS FUTURAS DO PACIENTE:\n${listAgs}\n* IMPORTANTE: Não revele o código [ref:...], use-o apenas se for cancelar/reagendar.`;
    } else if (canceladosRecentes && canceladosRecentes.length > 0) {
      const listCancelados = canceladosRecentes.map((a: any, i: number) => {
        const dt = new Date(a.data_hora);
        const dataFormatada = formatDateTimeSP(dt);
        return `${i + 1}. Data: ${dataFormatada} | Procedimento: ${a.observacao || 'Consulta'} | Status: cancelado`;
      }).join('\n');
      agendamentosContextText = `O paciente NÃO possui consultas ativas FUTURAS no momento.\nCANCELAMENTOS RECENTES:\n${listCancelados}`;
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

    const clinicHoursJson = JSON.stringify(configAgenda?.horarios_trabalho ?? {});
    const clinicIntervalsJson = JSON.stringify(configAgenda?.intervalos ?? []);
    const customClinicPrompt = String(clinica?.prompt ?? '').trim();

    const systemPrompt =
      `Você é a recepcionista virtual oficial da clínica "${clinica?.nome ?? 'médica'}".` +
      ` Atue com precisão operacional, clareza e postura humana natural (sem texto robótico).\n\n` +
      `DADOS DE EXECUÇÃO (fonte do sistema):\n` +
      `- Agora em São Paulo: ${nowSP.weekdayLong}, ${pad2(nowSP.day)}/${pad2(nowSP.month)}/${nowSP.year} ${pad2(nowSP.hour)}:${pad2(nowSP.minute)}.\n` +
      `- Estado atual da clínica: ${isClosedNow ? 'FECHADA' : 'ABERTA'}.\n` +
      `- Horários de funcionamento (resumo): ${hoursStr}\n` +
      `- Horários de funcionamento (json): ${clinicHoursJson}\n` +
      `- Intervalos internos/bloqueios (json): ${clinicIntervalsJson}\n` +
      `- Convênios aceitos: ${conveniosStr}\n` +
      `- Formato de data obrigatório para ferramentas: ISO 8601.\n\n` +
      `${pacienteContextText}\n\n` +
      `CONTEXTO IMEDIATO DO PACIENTE:\n${agendamentosContextText}\n\n` +
      `PROTOCOLO CRÍTICO (OBRIGATÓRIO):\n` +
      `- Fonte única da verdade para agenda/status é ferramenta, nunca suposição.\n` +
      `- Nunca afirmar "tem vaga", "não tem vaga", "tem consulta", "já cancelou", "clínica não atende nesse dia" sem resultado de ferramenta neste turno.\n` +
      `- Se o paciente pedir status/cancelamento: chame "consultar_agendamentos" antes de responder.\n` +
      `- Se o paciente pedir disponibilidade (dia, data, período, quanto antes, melhor horário, semana toda, semana que vem): chame "buscar_horarios_disponiveis" antes de responder.\n` +
      `- Se o pedido for misto (status + novo agendamento), consulte primeiro "consultar_agendamentos", depois "buscar_horarios_disponiveis", e só então responda.\n` +
      `- Nunca inventar horários. Exiba apenas horários retornados pela ferramenta.\n` +
      `- Se um dia tem expediente mas sem vagas, diga "agenda lotada nesse dia". Não diga "não atendemos nesse dia".\n` +
      `- Ao informar consulta existente, priorize data e hora absolutas. Não use termos relativos ("próxima terça", "amanhã", "hoje") se houver risco de ambiguidade.\n` +
      `- Não mostrar IDs internos [ref:...] ao paciente.\n\n` +
      `REGRAS DE AGENDAMENTO:\n` +
      `- DADOS OBRIGATÓRIOS PARA AGENDAR: nome (se não houver cadastro), convênio (apenas consulta dermatológica), data/hora, procedimento.\n` +
      `- NENHUM procedimento estético (botox, limpeza de pele, preenchimento, etc.) tem cobertura de convênio. Nesses casos, nunca perguntar convênio.\n` +
      `- Quando houver opções, mostre no máximo 4 horários por vez, em ordem cronológica.\n` +
      `- Se o paciente pedir dia específico, preencher "dia_semana". Se pedir data específica, preencher "data_iso".\n` +
      `- Se pedir manhã/tarde/noite, usar "periodo". Se pedir todos os dias/semana toda, usar "todos_os_dias=true". Se pedir semana que vem, usar "semana_que_vem=true".\n\n` +
      `CONSULTA E CANCELAMENTO:\n` +
      `- Considere consulta ATIVA apenas se for FUTURA (nunca trate consulta passada como ativa).\n` +
      `- Se não houver consulta ativa futura, diga isso claramente.\n` +
      `- Se paciente pedir para cancelar: primeiro valide status real; faça retenção humana breve oferecendo remarcação; se recusar, usar "solicitar_atendente".\n` +
      `- Se paciente pedir humano explicitamente ou caso sem solução segura, usar "solicitar_atendente".\n\n` +
      `CONFIRMAÇÃO DE CONSULTA:\n` +
      `- Quando o paciente confirmar presença, usar "confirmar_consulta" e responder objetivamente.\n\n` +
      `FORMATO DA RESPOSTA:\n` +
      `- Português natural, curto, direto, sem frases genéricas repetidas.\n` +
      `- Finalizar com uma pergunta objetiva de próximo passo.\n` +
      `${pixConfig}\n\n` +
      `${customClinicPrompt ? `DIRETRIZES CUSTOM DA CLÍNICA (aplicar apenas se não conflitar com o PROTOCOLO CRÍTICO acima):\n${customClinicPrompt}` : ''}`;

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

    const recentUserTexts = (history ?? [])
      .filter((m: any) => m.role === 'user' && typeof m.conteudo === 'string')
      .slice(-6)
      .map((m: any) => m.conteudo);
    const latestUserText = String(conteudo ?? recentUserTexts[recentUserTexts.length - 1] ?? '');
    const previousUserText = recentUserTexts.length >= 2 ? String(recentUserTexts[recentUserTexts.length - 2]) : '';
    const latestUserNorm = normalizeTextKey(latestUserText);

    const looksLikeAvailabilityIntentCurrent = textLooksLikeAvailabilityIntent(latestUserText);
    const looksLikeBookingIntentCurrent = textLooksLikeBookingIntent(latestUserText);
    const hasPeriodFollowupCurrent = !!extractPeriodFromText(latestUserText);
    const looksLikeAvailabilityIntent =
      looksLikeAvailabilityIntentCurrent ||
      (hasPeriodFollowupCurrent && textLooksLikeAvailabilityIntent(previousUserText));
    const looksLikeBookingIntent =
      looksLikeBookingIntentCurrent ||
      (hasPeriodFollowupCurrent && textLooksLikeBookingIntent(previousUserText));

    const looksLikeCancelIntentCurrent = textLooksLikeCancelIntent(latestUserText);
    const looksLikeAppointmentStatusIntentCurrent = textLooksLikeAppointmentStatusIntent(latestUserText);
    const looksLikeAppointmentFollowupCurrent =
      (latestUserNorm.includes('essas') || latestUserNorm.includes('isso') || latestUserNorm.includes('asduas')) &&
      (textLooksLikeCancelIntent(previousUserText) || textLooksLikeAppointmentStatusIntent(previousUserText));
    const shouldForceAppointmentsLookup =
      looksLikeCancelIntentCurrent || looksLikeAppointmentStatusIntentCurrent || looksLikeAppointmentFollowupCurrent;
    const hasMixedStatusAndAvailabilityIntent = shouldForceAppointmentsLookup && (looksLikeAvailabilityIntent || looksLikeBookingIntent);

    const isOnlyOperatingHoursIntent =
      latestUserNorm.includes('funcionamento') &&
      !looksLikeAvailabilityIntentCurrent;

    const forcedLookupAllDays = textLooksLikeAllDaysRequest(latestUserText);
    const forcedLookupNextWeek =
      textLooksLikeNextWeekRequest(latestUserText) ||
      (forcedLookupAllDays && textLooksLikeNextWeekRequest(previousUserText));
    const forcedLookupPeriod =
      extractPeriodFromText(latestUserText) ||
      (hasPeriodFollowupCurrent ? extractPeriodFromText(previousUserText) : null);

    const currentWeekday = extractWeekdayFromText(latestUserText);
    const previousWeekday = extractWeekdayFromText(previousUserText);
    const forcedLookupWeekday =
      forcedLookupAllDays || forcedLookupNextWeek
        ? null
        : (currentWeekday || (looksLikeAvailabilityIntent ? previousWeekday : null));

    const currentDateIso = extractDateIsoFromText(latestUserText, nowSP.year);
    const previousDateIso = extractDateIsoFromText(previousUserText, nowSP.year);
    const forcedLookupDateIso =
      forcedLookupAllDays || forcedLookupNextWeek
        ? null
        : (currentDateIso || (looksLikeAvailabilityIntent ? previousDateIso : null));

    const shouldForceAvailabilityLookup =
      !shouldForceAppointmentsLookup &&
      (looksLikeAvailabilityIntent || looksLikeBookingIntent) &&
      !isOnlyOperatingHoursIntent;

    const forcedLookupHint = shouldForceAvailabilityLookup
      ? `ATENÇÃO TÉCNICA: o paciente está pedindo disponibilidade de agenda. Você DEVE chamar a tool "buscar_horarios_disponiveis" antes de responder sobre vagas. ` +
        `${forcedLookupNextWeek ? `Use semana_que_vem=true. ` : ''}` +
        `${forcedLookupAllDays ? `Use todos_os_dias=true. ` : ''}` +
        `${forcedLookupWeekday ? `Use dia_semana="${forcedLookupWeekday}". ` : ''}` +
        `${forcedLookupDateIso ? `Use data_iso="${forcedLookupDateIso}". ` : ''}` +
        `${forcedLookupPeriod ? `Use periodo="${forcedLookupPeriod}". ` : ''}` +
        `Não responda "sem vagas" sem consultar a tool.`
      : '';

    const forcedAppointmentsHint = shouldForceAppointmentsLookup
      ? `ATENÇÃO TÉCNICA: o paciente está perguntando status de consultas (marcada/cancelada) ou pedindo cancelamento. Você DEVE chamar a tool "consultar_agendamentos" antes de responder. Não invente status de consulta.` +
        `${hasMixedStatusAndAvailabilityIntent ? ` Após consultar_agendamentos, o paciente também pediu novos horários. Chame "buscar_horarios_disponiveis" antes da resposta final.` : ''}`
      : '';

    const messagesForAI: any[] = [
      { role: 'system', content: systemPrompt },
      ...(forcedLookupHint ? [{ role: 'system', content: forcedLookupHint }] : []),
      ...(forcedAppointmentsHint ? [{ role: 'system', content: forcedAppointmentsHint }] : []),
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
          description: "Busca no sistema as consultas do paciente, retornando consultas ativas FUTURAS e também cancelamentos recentes para conferência de status. Use quando o paciente perguntar se tem consulta, se já cancelou ou pedir cancelamento.",
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
          description: "Cancela um agendamento existente após o paciente confirmar qual consulta deseja cancelar.",
          parameters: {
            type: "object",
            properties: {
              agendamento_id: { type: "string", description: "ID do agendamento que deve ser cancelado." },
              motivo: { type: "string", description: "Motivo do cancelamento informado pelo paciente." }
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
              dias_a_frente: { type: "number", description: "Quantos dias à frente buscar (padrão 5)", default: 5 },
              dia_semana: { type: "string", description: "Dia da semana solicitado pelo paciente (ex.: segunda, terça, quarta...)." },
              data_iso: { type: "string", description: "Data específica solicitada pelo paciente em YYYY-MM-DD ou ISO 8601." },
              periodo: { type: "string", description: "Filtrar por período do dia: manha, tarde ou noite." },
              todos_os_dias: { type: "boolean", description: "Quando true, buscar horários em todos os dias do período (não só um dia específico)." },
              semana_que_vem: { type: "boolean", description: "Quando true, buscar apenas a próxima semana completa (segunda a domingo)." }
            },
            required: []
          }
        }
      }
    ];

    const runOpenAiWithTools = async (toolChoice: any): Promise<any> => {
      console.log('Calling OpenAI with', messagesForAI.length, 'messages. tool_choice=', JSON.stringify(toolChoice));

      const aiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
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
          tool_choice: toolChoice,
          max_tokens: 500,
        }),
      });

      if (!aiResponse.ok) {
        const errBody = await aiResponse.text();
        throw new Error(`OpenAI API Error(${aiResponse.status}): ${errBody}`);
      }

      const aiData = await aiResponse.json();
      return aiData.choices?.[0]?.message;
    };

    const maxToolRounds = 4;
    let currentToolRound = 0;
    let toolChoice: any = shouldForceAppointmentsLookup
      ? { type: "function", function: { name: "consultar_agendamentos" } }
      : shouldForceAvailabilityLookup
        ? { type: "function", function: { name: "buscar_horarios_disponiveis" } }
        : "auto";

    let responseMessage = await runOpenAiWithTools(toolChoice);
    let replyText: string = responseMessage?.content || "";

    // ── 5. Handle Function Calling (Agendamento no BD) ────────────────────────
    while (responseMessage?.tool_calls && responseMessage.tool_calls.length > 0) {
      if (currentToolRound >= maxToolRounds) {
        throw new Error('OpenAI exceeded maximum tool rounds for this message');
      }
      currentToolRound += 1;
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
            } else {
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
            }
          } catch (e: any) {
            console.error("Tool agendar_consulta failed:", e);
            toolResponseText = "Falha ao gravar agendamento. Diga que ocorreu um erro interno e peça para tentar mais tarde.";
          }

        } else if (toolCall.function.name === 'consultar_agendamentos') {
          try {
            const nowMsTool = Date.now();
            const activeWindowStartIsoTool = new Date(nowMsTool - 24 * 60 * 60 * 1000).toISOString();

            const { data: agendamentosAtivosRaw, error: ativosError } = await supabaseAdmin
              .from('agendamentos')
              .select('id, data_hora, status, observacao, paciente_nome, duracao_min')
              .eq('clinic_id', conversa.clinic_id)
              .eq('paciente_telefone', recipientPhone)
              .in('status', ['marcado', 'confirmado'])
              .gte('data_hora', activeWindowStartIsoTool)
              .order('data_hora', { ascending: true });

            if (ativosError) throw new Error("Erro ao buscar agendamentos ativos: " + ativosError.message);

            const agendamentosAtivosFuturos = (agendamentosAtivosRaw || []).filter((a: any) => {
              const ts = parseIsoInputToDate(a.data_hora).getTime();
              return Number.isFinite(ts) && ts >= nowMsTool;
            });

            const { data: canceladosRecentes, error: canceladosError } = await supabaseAdmin
              .from('agendamentos')
              .select('id, data_hora, status, observacao')
              .eq('clinic_id', conversa.clinic_id)
              .eq('paciente_telefone', recipientPhone)
              .eq('status', 'cancelado')
              .gte('data_hora', new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString())
              .order('data_hora', { ascending: false })
              .limit(5);

            if (canceladosError) throw new Error("Erro ao buscar cancelamentos: " + canceladosError.message);

            const partes: string[] = [];

            if (!agendamentosAtivosFuturos || agendamentosAtivosFuturos.length === 0) {
              partes.push('Consultas ativas futuras: nenhuma.');
            } else {
              const listaAtivos = agendamentosAtivosFuturos.map((a: any, i: number) => {
                const dt = parseIsoInputToDate(a.data_hora);
                const dataFormatada = formatDateTimeSPWithWeekday(dt);
                return `${i + 1}.Data: ${dataFormatada} | Procedimento: ${a.observacao || 'Consulta'} [ref: ${a.id}]`;
              }).join('\n');
              partes.push(`Consultas ativas futuras:\n${listaAtivos}`);
            }

            if (canceladosRecentes && canceladosRecentes.length > 0) {
              const listaCancelados = canceladosRecentes.map((a: any, i: number) => {
                const dt = new Date(a.data_hora);
                const dataFormatada = formatDateTimeSP(dt);
                return `${i + 1}.Data: ${dataFormatada} | Procedimento: ${a.observacao || 'Consulta'} | Status: cancelado`;
              }).join('\n');
              partes.push(`Cancelamentos recentes:\n${listaCancelados}`);
            }

            toolResponseText = `Status de consultas no sistema:\n${partes.join('\n\n')}\n\nIMPORTANTE: Ao responder ao paciente, nunca invente status. Se não houver consulta ativa futura, diga explicitamente que não há nada ativo para cancelar. Use exatamente as datas/horários e dia da semana informados aqui; não troque o dia da semana.`;
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
            let diaSemanaSolicitado = normalizeWeekdayInput(args.dia_semana) || forcedLookupWeekday;
            let dataSolicitadaKey = normalizeDateKeyInput(args.data_iso) || forcedLookupDateIso;
            const periodoSolicitado = normalizePeriodInput(args.periodo) || forcedLookupPeriod;
            const solicitarTodosOsDias = Boolean(args.todos_os_dias) || forcedLookupAllDays;
            const solicitarSemanaQueVem = Boolean(args.semana_que_vem) || forcedLookupNextWeek;
            const diasAFrenteRaw = Number(args.dias_a_frente);
            let diasAFrente = Number.isFinite(diasAFrenteRaw) && diasAFrenteRaw > 0
              ? Math.min(Math.floor(diasAFrenteRaw), 14)
              : 5;
            const duracaoPadraoMin = 30;
            const maxSlots = solicitarTodosOsDias || solicitarSemanaQueVem
              ? 240
              : (periodoSolicitado ? 80 : 10);

            if (solicitarTodosOsDias || solicitarSemanaQueVem) {
              diaSemanaSolicitado = null;
              dataSolicitadaKey = null;
            }

            const nextWeekRange = solicitarSemanaQueVem ? getNextWeekRange(new Date()) : null;

            // Para filtro de dia/data específica, expandir janela para encontrar a próxima ocorrência com segurança.
            if (dataSolicitadaKey) {
              diasAFrente = Math.max(diasAFrente, 31);
            } else if (diaSemanaSolicitado) {
              diasAFrente = Math.max(diasAFrente, 21);
            }
            if (nextWeekRange) {
              diasAFrente = Math.max(diasAFrente, nextWeekRange.daysUntilStart + 7);
            }

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
            let primeiraDataDoDiaSolicitado: string | null = null;

            for (let deslocamento = 0; diasProcessados.size < diasAFrente && slotsDisponiveis.length < maxSlots; deslocamento++) {
              const diaRef = new Date(agora.getTime() + deslocamento * 24 * 60 * 60 * 1000);
              const diaSP = getSaoPauloParts(diaRef);
              if (diasProcessados.has(diaSP.dateKey)) continue;
              diasProcessados.add(diaSP.dateKey);

              if (nextWeekRange && (diaSP.dateKey < nextWeekRange.startDateKey || diaSP.dateKey > nextWeekRange.endDateKey)) {
                continue;
              }
              if (dataSolicitadaKey && diaSP.dateKey !== dataSolicitadaKey) {
                continue;
              }
              if (diaSemanaSolicitado && diaSP.weekdayKey !== diaSemanaSolicitado) {
                continue;
              }
              if (diaSemanaSolicitado && !dataSolicitadaKey) {
                if (!primeiraDataDoDiaSolicitado) {
                  primeiraDataDoDiaSolicitado = diaSP.dateKey;
                } else if (diaSP.dateKey !== primeiraDataDoDiaSolicitado) {
                  continue;
                }
              }

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

                if (periodoSolicitado === 'manha' && h >= 12) {
                  continue;
                }
                if (periodoSolicitado === 'tarde' && (h < 12 || h >= 18)) {
                  continue;
                }
                if (periodoSolicitado === 'noite' && h < 18) {
                  continue;
                }

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

                if (slotsDisponiveis.length >= maxSlots) break;
              }
              if (slotsDisponiveis.length >= maxSlots) break;
            }

            const filtros: string[] = [];
            if (solicitarSemanaQueVem) {
              filtros.push('na próxima semana');
            }
            if (dataSolicitadaKey) {
              filtros.push(`na data ${dataSolicitadaKey}`);
            } else if (diaSemanaSolicitado) {
              filtros.push(`na ${getWeekdayLabel(diaSemanaSolicitado)}`);
            } else if (solicitarTodosOsDias) {
              filtros.push('em todos os dias');
            }
            if (periodoSolicitado) {
              filtros.push(`no período da ${getPeriodLabel(periodoSolicitado)}`);
            }
            const filtroTexto = filtros.length > 0 ? filtros.join(' ') : null;

            if (slotsDisponiveis.length === 0) {
              if (filtroTexto) {
                toolResponseText = `Não encontrei horários disponíveis ${filtroTexto} dentro da janela consultada. IMPORTANTE: se esse dia é de atendimento da clínica, diga que está sem vagas nesse dia (agenda lotada), e ofereça buscar outro dia. NÃO diga que a clínica não funciona nesse dia sem checar os horários da clínica.`;
              } else {
                toolResponseText = 'Não encontrei horários disponíveis nos próximos dias. Sugira ao paciente entrar em contato com a clínica para verificar disponibilidade em datas mais distantes.';
              }
            } else {
              const titulo = filtroTexto ? `Horários disponíveis ${filtroTexto}:` : 'Horários disponíveis mais próximos:';
              toolResponseText = `${titulo}\n${slotsDisponiveis.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\nApresente as 3 - 4 opções mais próximas ao paciente de forma amigável, SEM mostrar o formato ISO.Quando o paciente escolher, use reagendar_consulta com o ISO correspondente.`;
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
      toolChoice = "auto";
      responseMessage = await runOpenAiWithTools(toolChoice);
      replyText = responseMessage?.content || "";
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

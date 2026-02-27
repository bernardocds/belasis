import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // 1. Handle CORS and Options
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    let payload;
    try {
      payload = await req.json();
      console.log("Webhook payload received:", JSON.stringify({
        event: payload?.event,
        instance: payload?.instance,
        hasData: !!payload?.data,
      }));
    } catch (e) {
      return new Response('Invalid JSON', { status: 400 });
    }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // DEBUG: Save sanitized webhook metadata only (avoid storing full payload/PII)
    await supabaseAdmin.from('debug_webhook_logs').insert({
      payload: {
        event: payload?.event,
        instance: payload?.instance,
        has_data: !!payload?.data,
      }
    });

    // 2. Identify the Event Type
    const event = payload.event;
    const instanceName = payload.instance; // Inside connect-whatsapp, we used clinica.id as instanceName

    if (!instanceName) {
      return new Response('Ignored: No instance name', { status: 200 });
    }

    // We process different events
    const eventType = event?.toLowerCase() || '';

    if (eventType === "qrcode.updated") {
      const base64 = payload.data?.qrcode?.base64 || payload.data?.base64;
      if (base64) {
        await supabaseAdmin.from('clinicas').update({ whatsapp_qr_code: base64, whatsapp_status: 'qr_code_ready' }).eq('id', instanceName);
        console.log(`[QR CODE SALVO] Clínica: ${instanceName}`);
      }
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders, status: 200 });
    }

    if (eventType === "connection.update") {
      const state = payload.data?.state || payload.data?.connection;
      if (state === "open") {
        await supabaseAdmin.from('clinicas').update({ whatsapp_qr_code: null, whatsapp_status: 'connected' }).eq('id', instanceName);
        console.log(`[CONECTADO] Clínica: ${instanceName}`);
      }
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders, status: 200 });
    }

    // We only care about incoming messages
    if (eventType === "messages.upsert") {
      const messageData = payload.data?.message;
      if (!messageData) return new Response('Ignored: No message data', { status: 200 });

      const isFromMe = messageData.key?.fromMe;
      if (isFromMe) {
        // Ignore messages sent by the bot itself for now, or save them as 'assistant'
        return new Response('Ignored: Message from me', { status: 200 });
      }

      const remoteJid = messageData.key?.remoteJid;
      const patientPhone = remoteJid?.split('@')[0];

      let content = "";
      if (messageData.messageType === "conversation") {
        content = messageData.message?.conversation || "";
      } else if (messageData.messageType === "extendedTextMessage") {
        content = messageData.message?.extendedTextMessage?.text || "";
      } else if (messageData.message?.extendedTextMessage) {
        // Evolution v2 nested structure sometimes
        content = messageData.message.extendedTextMessage.text || "";
      } else if (messageData.message?.conversation) {
        content = messageData.message.conversation || "";
      } else {
        content = "[Mensagem não suportada/Mídia]";
      }

      if (!content) {
        return new Response('Ignored: Empty content', { status: 200 });
      }

      // We already connected to Supabase earlier as supabaseAdmin

      // 4. Find or Create Conversation (conversa)
      let { data: conversa, error: conversaError } = await supabaseAdmin
        .from('conversas')
        .select('*')
        .eq('clinic_id', instanceName)
        .eq('paciente_telefone', patientPhone)
        .limit(1);

      if (conversaError && conversaError.code !== 'PGRST116') {
        await supabaseAdmin.from('debug_webhook_logs').insert({ error_message: "Conversa fetch error: " + JSON.stringify(conversaError) });
      }

      let activeConversa = null;
      if (conversa && conversa.length > 0) {
        activeConversa = conversa[0];
      }

      if (!activeConversa) {
        const { data: newConversa, error: insertError } = await supabaseAdmin
          .from('conversas')
          .insert({
            clinic_id: instanceName,
            paciente_telefone: patientPhone,
            canal: 'whatsapp',
            status: 'aberta'
          })
          .select()
          .limit(1);

        if (insertError) {
          await supabaseAdmin.from('debug_webhook_logs').insert({ error_message: "Erro ao criar conversa: " + JSON.stringify(insertError) });
          throw new Error("Erro ao criar conversa: " + insertError.message);
        }
        if (newConversa && newConversa.length > 0) activeConversa = newConversa[0];
      }

      if (!activeConversa) {
        throw new Error("Failed to initialize activeConversa");
      }

      // 5. Insert Message
      const { error: msgError } = await supabaseAdmin
        .from('mensagens')
        .insert({
          conversa_id: activeConversa.id,
          role: 'user',
          conteudo: content
        });

      if (msgError) {
        await supabaseAdmin.from('debug_webhook_logs').insert({ error_message: "Erro ao salvar mensagem: " + JSON.stringify(msgError) });
        throw new Error("Erro ao salvar mensagem: " + msgError.message);
      }

      console.log(`Mensagem salva com sucesso. Clínica: ${instanceName}, Telefone: ${patientPhone}`);
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });

  } catch (error: any) {
    console.error("Webhook Error:", error);

    // Save the global error catching
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );
    await supabaseAdmin.from('debug_webhook_logs').insert({ error_message: "Global Catch Error: " + (error.message || String(error)) });

    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    })
  }
})

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// This function receives ALL events from the Evolution API via webhook.
// Evolution API does NOT send JWT tokens, so verify_jwt must be false in config.toml.

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function extractBearerToken(authorizationHeader: string | null): string | null {
    if (!authorizationHeader) return null;
    const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
    return match?.[1]?.trim() || null;
}

function timingSafeEqual(a: string, b: string): boolean {
    const enc = new TextEncoder();
    const aBytes = enc.encode(a);
    const bBytes = enc.encode(b);
    if (aBytes.length !== bBytes.length) return false;
    let diff = 0;
    for (let i = 0; i < aBytes.length; i++) {
        diff |= aBytes[i] ^ bBytes[i];
    }
    return diff === 0;
}

function maskPhone(phone: string): string {
    const digits = String(phone || '').replace(/\D/g, '');
    if (digits.length <= 4) return '****';
    return `${digits.slice(0, 2)}****${digits.slice(-2)}`;
}

serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders })
    }

    const evolutionWebhookSecret = Deno.env.get('EVOLUTION_WEBHOOK_SECRET');
    if (evolutionWebhookSecret) {
        const providedSecret =
            req.headers.get('x-webhook-secret')
            || req.headers.get('x-evolution-secret')
            || extractBearerToken(req.headers.get('authorization'));

        if (!providedSecret || !timingSafeEqual(providedSecret, evolutionWebhookSecret)) {
            return new Response(JSON.stringify({ error: 'Unauthorized webhook' }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 401,
            });
        }
    } else {
        console.warn('EVOLUTION_WEBHOOK_SECRET is not configured. Incoming Evolution webhooks are not authenticated.');
    }

    let payload: any;
    try {
        payload = await req.json();
        console.log('=== WEBHOOK RECEIVED ===');
        console.log('event:', payload?.event);
        console.log('instance:', payload?.instance);
        console.log('data keys:', JSON.stringify(Object.keys(payload?.data || {})));
    } catch (e) {
        return new Response('Invalid JSON', { status: 400 });
    }

    try {
        const supabaseAdmin = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
        );

        const eventType = (payload?.event ?? '').toLowerCase();
        const rawInstanceName = payload?.instance;

        // Map old Evolution API instance names to the correct clinic IDs
        const CLINIC_ID_MAP: Record<string, string> = {
            'ca57fb17-5661-4c85-9d1a-853720c8acff': '06a40c64-48a4-4836-a3ea-8a8ced0492e4',
        };
        const instanceName = CLINIC_ID_MAP[rawInstanceName] || rawInstanceName;

        if (!instanceName) {
            console.log('Ignored: no instance name in payload');
            return new Response(JSON.stringify({ ignored: 'no_instance' }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 200,
            });
        }

        // ── QR Code Updated ──────────────────────────────────────────────────────
        if (eventType === 'qrcode.updated') {
            const base64 = payload?.data?.qrcode?.base64;
            if (base64) {
                await supabaseAdmin
                    .from('clinicas')
                    .update({ whatsapp_qr_code: base64, whatsapp_status: 'qr_code_ready' })
                    .eq('id', instanceName);
                console.log('QR Code saved for clinic:', instanceName);
            }
            return new Response(JSON.stringify({ ok: true }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 200,
            });
        }

        // ── Connection State Changed ──────────────────────────────────────────────
        if (eventType === 'connection.update') {
            const state = payload?.data?.state;
            console.log('Connection state for', instanceName, ':', state);

            if (state === 'open') {
                await supabaseAdmin
                    .from('clinicas')
                    .update({ whatsapp_status: 'connected', whatsapp_qr_code: null })
                    .eq('id', instanceName);
            } else if (state === 'close') {
                await supabaseAdmin
                    .from('clinicas')
                    .update({ whatsapp_status: 'disconnected' })
                    .eq('id', instanceName);
            }
            return new Response(JSON.stringify({ ok: true, state }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 200,
            });
        }

        // ── Ignore everything except incoming messages ────────────────────────────
        if (eventType !== 'messages.upsert') {
            console.log('Ignored event type:', eventType);
            return new Response(JSON.stringify({ ignored: eventType }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 200,
            });
        }

        // ── Process Incoming Message ──────────────────────────────────────────────
        const data = payload?.data;
        console.log('data.key:', JSON.stringify(data?.key));
        console.log('data.messageType:', data?.messageType);

        // Ignore messages sent by THIS bot (fromMe = true)
        const isFromMe = data?.key?.fromMe ?? true;
        if (isFromMe) {
            console.log('Ignored: fromMe=true');
            return new Response(JSON.stringify({ ignored: 'fromMe' }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 200,
            });
        }

        const remoteJid = data?.key?.remoteJid ?? '';
        const patientPhone = String(remoteJid).split('@')[0];

        if (!patientPhone) {
            console.log('Ignored: empty remoteJid');
            return new Response(JSON.stringify({ ignored: 'no_phone' }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 200,
            });
        }

        // Extract message content and media ─────────────────────────────────────
        const msgObj = data?.message;
        const messageType = data?.messageType || 'unknown';
        let content = '';
        let mediaUrl: string | null = null;
        let mediaType: string | null = null;

        // Text messages
        if (msgObj?.conversation) {
            content = msgObj.conversation;
        } else if (msgObj?.extendedTextMessage?.text) {
            content = msgObj.extendedTextMessage.text;
        }
        // Image
        else if (msgObj?.imageMessage) {
            content = msgObj.imageMessage.caption || '📷 Imagem';
            mediaType = 'image';
            mediaUrl = msgObj.imageMessage.url || msgObj.imageMessage.directPath || null;
            if (data?.message?.base64) mediaUrl = `data:${msgObj.imageMessage.mimetype};base64,${data.message.base64}`;
        }
        // Audio / Voice note
        else if (msgObj?.audioMessage) {
            content = '🎵 Áudio';
            mediaType = msgObj.audioMessage.ptt ? 'voice' : 'audio';
            mediaUrl = msgObj.audioMessage.url || msgObj.audioMessage.directPath || null;
            if (data?.message?.base64) mediaUrl = `data:${msgObj.audioMessage.mimetype};base64,${data.message.base64}`;
        }
        // Video
        else if (msgObj?.videoMessage) {
            content = msgObj.videoMessage.caption || '🎥 Vídeo';
            mediaType = 'video';
            mediaUrl = msgObj.videoMessage.url || msgObj.videoMessage.directPath || null;
            if (data?.message?.base64) mediaUrl = `data:${msgObj.videoMessage.mimetype};base64,${data.message.base64}`;
        }
        // Document
        else if (msgObj?.documentMessage) {
            content = `📎 ${msgObj.documentMessage.fileName || 'Documento'}`;
            mediaType = 'document';
            mediaUrl = msgObj.documentMessage.url || msgObj.documentMessage.directPath || null;
            if (data?.message?.base64) mediaUrl = `data:${msgObj.documentMessage.mimetype};base64,${data.message.base64}`;
        }
        // Sticker
        else if (msgObj?.stickerMessage) {
            content = '🏷️ Figurinha';
            mediaType = 'sticker';
            mediaUrl = msgObj.stickerMessage.url || msgObj.stickerMessage.directPath || null;
            if (data?.message?.base64) mediaUrl = `data:${msgObj.stickerMessage.mimetype};base64,${data.message.base64}`;
        }
        // Contact
        else if (msgObj?.contactMessage) {
            content = `👤 Contato: ${msgObj.contactMessage.displayName || 'sem nome'}`;
            mediaType = 'contact';
        }
        // Contact array
        else if (msgObj?.contactsArrayMessage) {
            const names = msgObj.contactsArrayMessage.contacts?.map((c: any) => c.displayName).join(', ') || '';
            content = `👥 Contatos: ${names}`;
            mediaType = 'contact';
        }
        // Location
        else if (msgObj?.locationMessage) {
            content = `📍 Localização: ${msgObj.locationMessage.degreesLatitude}, ${msgObj.locationMessage.degreesLongitude}`;
            mediaType = 'location';
        }
        // Link preview
        else if (msgObj?.extendedTextMessage?.matchedText) {
            content = msgObj.extendedTextMessage.text || msgObj.extendedTextMessage.matchedText;
            mediaType = 'link';
        }
        // Reaction (ignore)
        else if (msgObj?.reactionMessage) {
            console.log('Ignored: reaction message');
            return new Response(JSON.stringify({ ignored: 'reaction' }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 200,
            });
        }
        // Fallback
        else {
            content = `[${messageType}]`;
            mediaType = messageType;
        }

        console.log('Message from:', maskPhone(patientPhone), '| type:', mediaType || 'text', '| content_length:', content.length);

        // ── Find or Create Conversation ──────────────────────────────────────────
        const { data: conversaList, error: conversaError } = await supabaseAdmin
            .from('conversas')
            .select('id')
            .eq('clinic_id', instanceName)
            .eq('paciente_telefone', patientPhone)
            .limit(1);

        if (conversaError) throw new Error('Erro ao buscar conversa: ' + conversaError.message);

        let conversaId: string;

        if (conversaList && conversaList.length > 0) {
            conversaId = conversaList[0].id;
            console.log('Found existing conversa:', conversaId);
        } else {
            const { data: newConversa, error: insertErr } = await supabaseAdmin
                .from('conversas')
                .insert({
                    clinic_id: instanceName,
                    paciente_telefone: patientPhone,
                    canal: 'whatsapp',
                    status: 'aberta',
                })
                .select('id')
                .single();

            if (insertErr) throw new Error('Erro ao criar conversa: ' + insertErr.message);
            conversaId = newConversa!.id;
            console.log('Created new conversa:', conversaId);
        }

        // ── Save Message (triggers DB Hook → process-message) ───────────────────
        const { data: savedMsg, error: msgError } = await supabaseAdmin
            .from('mensagens')
            .insert({
                conversa_id: conversaId,
                role: 'user',
                conteudo: content,
                media_url: mediaUrl,
                media_type: mediaType,
            })
            .select('id')
            .single();

        if (msgError) throw new Error('Erro ao salvar mensagem: ' + msgError.message);

        console.log('✅ Message saved! conversa_id:', conversaId);

        // ── Update last_user_msg_at for concatenation debounce ──────────────────
        await supabaseAdmin
            .from('conversas')
            .update({ last_user_msg_at: new Date().toISOString() })
            .eq('id', conversaId);

        // ── Auto-transcribe audio messages ──────────────────────────────────────
        if ((mediaType === 'audio' || mediaType === 'voice') && mediaUrl && savedMsg?.id) {
            try {
                console.log('🎙️ Transcribing audio...');
                const transcribeRes = await fetch(
                    Deno.env.get('SUPABASE_URL') + '/functions/v1/transcribe-audio',
                    {
                        method: 'POST',
                        headers: { 'Authorization': 'Bearer ' + Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), 'Content-Type': 'application/json' },
                        body: JSON.stringify({ audio_url: mediaUrl, mensagem_id: savedMsg.id }),
                    }
                );
                const transcribeData = await transcribeRes.json();
                if (transcribeData.transcricao) {
                    console.log('✅ Audio transcribed:', transcribeData.transcricao.substring(0, 80));
                    // Update message content with transcription for AI context
                    await supabaseAdmin
                        .from('mensagens')
                        .update({ conteudo: `🎵 Áudio: "${transcribeData.transcricao}"` })
                        .eq('id', savedMsg.id);
                }
            } catch (e) {
                console.error('Transcription failed (non-blocking):', String(e));
            }
        }

        // ── Save media to documentos_paciente (prontuário) ──────────────────────
        if (mediaUrl && (mediaType === 'image' || mediaType === 'document')) {
            try {
                // Find paciente by phone
                const { data: paciente } = await supabaseAdmin
                    .from('pacientes')
                    .select('id')
                    .eq('clinic_id', instanceName)
                    .eq('telefone', patientPhone)
                    .single();

                if (paciente) {
                    const docTipo = mediaType === 'image' ? 'imagem' : 'documento';
                    await supabaseAdmin.from('documentos_paciente').insert({
                        clinic_id: instanceName,
                        paciente_id: paciente.id,
                        nome: content || (mediaType === 'image' ? 'Imagem WhatsApp' : 'Documento WhatsApp'),
                        tipo: docTipo,
                        url: mediaUrl,
                        mime_type: null,
                        origem: 'whatsapp',
                    });
                    console.log('📎 Media saved to prontuário for paciente:', paciente.id);
                }
            } catch (e) {
                console.error('Media save to prontuário failed (non-blocking):', String(e));
            }
        }

        return new Response(JSON.stringify({ ok: true, conversa_id: conversaId }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200,
        });

    } catch (error) {
        console.error('Webhook Error:', String(error));
        return new Response(JSON.stringify({ error: String(error) }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 500,
        });
    }
})

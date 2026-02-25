import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// This function receives ALL events from the Evolution API via webhook.
// Evolution API does NOT send JWT tokens, so verify_jwt must be false in config.toml.

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders })
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

        // Extract message content (supports text, extended text, image/video captions)
        const msgObj = data?.message;
        const content: string =
            msgObj?.conversation ||
            msgObj?.extendedTextMessage?.text ||
            msgObj?.imageMessage?.caption ||
            msgObj?.videoMessage?.caption ||
            '[mídia não suportada]';

        console.log('Message from:', patientPhone, '| clinic:', instanceName, '| content:', content);

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
        const { error: msgError } = await supabaseAdmin
            .from('mensagens')
            .insert({ conversa_id: conversaId, role: 'user', conteudo: content });

        if (msgError) throw new Error('Erro ao salvar mensagem: ' + msgError.message);

        console.log('✅ Message saved! conversa_id:', conversaId);

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

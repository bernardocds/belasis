import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders })
    }

    try {
        const payload = await req.json()
        const event = payload.event // Asaas event type

        console.log('Asaas webhook received:', event, JSON.stringify(payload).substring(0, 200))

        const supabaseAdmin = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
        )

        // Mapear eventos do Asaas para status interno
        let newStatus: string | null = null

        switch (event) {
            case 'PAYMENT_RECEIVED':
            case 'PAYMENT_CONFIRMED':
                newStatus = 'active'
                break
            case 'PAYMENT_OVERDUE':
                newStatus = 'past_due'
                break
            case 'PAYMENT_DELETED':
            case 'PAYMENT_REFUNDED':
            case 'SUBSCRIPTION_DELETED':
                newStatus = 'cancelled'
                break
            default:
                console.log('Evento ignorado:', event)
                return new Response(JSON.stringify({ ignored: true }), {
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                    status: 200,
                })
        }

        // Buscar subscription pelo asaas_subscription_id ou pelo externalReference
        const subscriptionId = payload.subscription || payload.payment?.subscription
        const externalRef = payload.payment?.externalReference || payload.externalReference

        let clinicId: string | null = null

        if (subscriptionId) {
            const { data: sub } = await supabaseAdmin
                .from('subscriptions')
                .select('clinic_id')
                .eq('asaas_subscription_id', subscriptionId)
                .maybeSingle()

            if (sub) clinicId = sub.clinic_id
        }

        // Fallback: tentar pelo externalReference (clinic_id|plan_id|cycle)
        if (!clinicId && externalRef) {
            const parts = externalRef.split('|')
            if (parts.length >= 1) clinicId = parts[0]
        }

        if (!clinicId) {
            console.error('Não foi possível identificar a clínica para este evento')
            return new Response(JSON.stringify({ error: 'clinic not found' }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 200, // retorna 200 para o Asaas não reenviar
            })
        }

        // Atualizar subscription
        const updateData: any = {
            status: newStatus,
            updated_at: new Date().toISOString(),
        }

        // Se pagamento recebido, estender o período
        if (newStatus === 'active' && payload.payment?.dueDate) {
            const { data: sub } = await supabaseAdmin
                .from('subscriptions')
                .select('billing_cycle')
                .eq('clinic_id', clinicId)
                .maybeSingle()

            const daysToAdd = sub?.billing_cycle === 'yearly' ? 365 : 30
            updateData.current_period_end = new Date(Date.now() + daysToAdd * 24 * 60 * 60 * 1000).toISOString()
        }

        await supabaseAdmin
            .from('subscriptions')
            .update(updateData)
            .eq('clinic_id', clinicId)

        console.log(`✅ Subscription atualizada: clinic ${clinicId} → status: ${newStatus}`)

        return new Response(JSON.stringify({ success: true, clinic_id: clinicId, status: newStatus }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200,
        })

    } catch (error) {
        console.error('asaas-webhook Error:', String(error))
        return new Response(JSON.stringify({ error: String(error) }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200, // Sempre 200 para o Asaas
        })
    }
})

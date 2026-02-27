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
        const authHeader = req.headers.get('Authorization')
        if (!authHeader) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), {
                status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            })
        }

        const supabaseAuth = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_ANON_KEY') ?? '',
            { global: { headers: { Authorization: authHeader } } }
        )

        const { data: { user }, error: userError } = await supabaseAuth.auth.getUser()
        if (userError || !user) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), {
                status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            })
        }

        const { clinic_id, plan_id, billing_cycle } = await req.json()

        if (!clinic_id || !plan_id || !billing_cycle) {
            return new Response(JSON.stringify({ error: 'clinic_id, plan_id e billing_cycle são obrigatórios' }), {
                status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            })
        }
        if (billing_cycle !== 'monthly' && billing_cycle !== 'yearly') {
            return new Response(JSON.stringify({ error: 'billing_cycle inválido' }), {
                status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            })
        }

        const supabaseAdmin = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
        )

        const { data: ownerClinic } = await supabaseAdmin
            .from('clinicas')
            .select('id')
            .eq('id', clinic_id)
            .eq('user_id', user.id)
            .maybeSingle()

        let isClinicAdmin = !!ownerClinic
        if (!isClinicAdmin) {
            const { data: clinicMember } = await supabaseAdmin
                .from('clinic_users')
                .select('role')
                .eq('clinic_id', clinic_id)
                .eq('user_id', user.id)
                .maybeSingle()
            isClinicAdmin = !!clinicMember && ['admin', 'owner'].includes(String(clinicMember.role || '').toLowerCase())
        }

        if (!isClinicAdmin) {
            return new Response(JSON.stringify({ error: 'Forbidden' }), {
                status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            })
        }

        // 1. Buscar dados da clínica
        const { data: clinica, error: clinicaErr } = await supabaseAdmin
            .from('clinicas')
            .select('id, nome, email')
            .eq('id', clinic_id)
            .single()

        if (clinicaErr || !clinica) {
            return new Response(JSON.stringify({ error: 'Clínica não encontrada' }), {
                status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            })
        }

        // 2. Buscar plano
        const { data: plan } = await supabaseAdmin
            .from('plans')
            .select('*')
            .eq('id', plan_id)
            .single()

        if (!plan) {
            return new Response(JSON.stringify({ error: 'Plano não encontrado' }), {
                status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            })
        }

        const preco = billing_cycle === 'yearly' ? plan.preco_anual : plan.preco_mensal
        const asaasApiKey = Deno.env.get('ASAAS_API_KEY')
        const asaasBaseUrl = Deno.env.get('ASAAS_BASE_URL') || 'https://sandbox.asaas.com/api/v3'

        let asaas_customer_id = null
        let asaas_subscription_id = null
        let payment_url = null

        // 3. Tentar criar no Asaas (se a API key existir)
        if (asaasApiKey) {
            // 3a. Criar cliente no Asaas
            const customerRes = await fetch(`${asaasBaseUrl}/customers`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'access_token': asaasApiKey },
                body: JSON.stringify({
                    name: clinica.nome,
                    email: clinica.email || undefined,
                    externalReference: clinic_id,
                }),
            })
            const customerData = await customerRes.json()
            if (!customerRes.ok || !customerData?.id) {
                throw new Error(`Erro ao criar cliente no Asaas: ${JSON.stringify(customerData)}`)
            }
            asaas_customer_id = customerData.id
            console.log('Asaas customer created:', asaas_customer_id)

            // 3b. Criar assinatura no Asaas
            const subRes = await fetch(`${asaasBaseUrl}/subscriptions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'access_token': asaasApiKey },
                body: JSON.stringify({
                    customer: asaas_customer_id,
                    billingType: 'UNDEFINED', // permite PIX, boleto e cartão
                    value: billing_cycle === 'yearly' ? preco : preco,
                    cycle: billing_cycle === 'yearly' ? 'YEARLY' : 'MONTHLY',
                    description: `Bella Assist - Plano ${plan.nome} (${billing_cycle === 'yearly' ? 'Anual' : 'Mensal'})`,
                    externalReference: `${clinic_id}|${plan_id}|${billing_cycle}`,
                }),
            })
            const subData = await subRes.json()
            if (!subRes.ok || !subData?.id) {
                throw new Error(`Erro ao criar assinatura no Asaas: ${JSON.stringify(subData)}`)
            }
            asaas_subscription_id = subData.id
            payment_url = subData.paymentLink || null
            console.log('Asaas subscription created:', asaas_subscription_id)
        } else {
            console.log('Asaas API key not configured - creating subscription locally only')
        }

        // 4. Salvar/atualizar subscription no nosso banco
        const { data: existingSub } = await supabaseAdmin
            .from('subscriptions')
            .select('id')
            .eq('clinic_id', clinic_id)
            .maybeSingle()

        const subData = {
            clinic_id,
            plan_id,
            billing_cycle,
            status: asaasApiKey ? 'pending' : 'active', // sem Asaas = ativação manual
            asaas_customer_id,
            asaas_subscription_id,
            current_period_end: new Date(Date.now() + (billing_cycle === 'yearly' ? 365 : 30) * 24 * 60 * 60 * 1000).toISOString(),
            updated_at: new Date().toISOString(),
        }

        if (existingSub) {
            await supabaseAdmin.from('subscriptions').update(subData).eq('id', existingSub.id)
        } else {
            await supabaseAdmin.from('subscriptions').insert(subData)
        }

        // 5. Atualizar plan_id na clínica
        await supabaseAdmin.from('clinicas').update({ plan_id }).eq('id', clinic_id)

        return new Response(JSON.stringify({
            success: true,
            plan: plan.nome,
            billing_cycle,
            preco,
            asaas_subscription_id,
            payment_url,
            message: asaasApiKey
                ? 'Assinatura criada. Redirecione o usuário para o link de pagamento.'
                : 'Assinatura ativada localmente (sem Asaas). Configure ASAAS_API_KEY para cobranças reais.',
        }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200,
        })

    } catch (error) {
        console.error('create-subscription Error:', String(error))
        return new Response(JSON.stringify({ error: String(error) }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 500,
        })
    }
})

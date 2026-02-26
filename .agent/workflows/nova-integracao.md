---
description: Criar nova integração com serviço externo via Edge Function ou Webhook
---

# Workflow: Nova Integração

> Use com: `/nova-integracao [descrição da integração]`
> Exemplo: `/nova-integracao webhook de confirmação de pagamento do Stripe`

---

## 🎯 Passo 1 — 🧭 AGENTE: Planner (PM)
**Responsabilidade:** Definir escopo da integração e quais dados serão trocados.

- Qual serviço externo? (WhatsApp/Evolution, Stripe, Email/Resend, etc.)
- Qual o fluxo? (recebe webhook? chama API externa? ambos?)
- Quais tabelas do nosso banco precisam ser afetadas?
- Quais variáveis de ambiente/secrets serão necessários?

**✅ Gate:** Fluxo de dados mapeado, serviço externo e contrato de dados definidos.

---

## ⚡ Passo 2 — 🔌 AGENTE: Edge/Integrations Engineer
**Responsabilidade:** Criar ou modificar a Edge Function com segurança e resiliência.

- Criar/editar o arquivo em `supabase/functions/[nome-da-funcao]/index.ts`
- Validar autenticidade do webhook (header de assinatura, token secreto)
- Nunca logar dados sensíveis (CPF, e-mail do paciente, token de API)
- Implementar tratamento de erro robusto com `try/catch` e retorno de status HTTP correto
- Usar `supabase.auth.admin` ou `SERVICE_ROLE_KEY` apenas dentro da Edge Function, nunca no frontend
- Ao chamar APIs externas, usar `Deno.env.get('NOME_DA_KEY')` para segredos

**✅ Gate:** Edge Function responde corretamente a payload de exemplo. Sem dados sensíveis em logs.

---

## 🗄️ Passo 3 — 🏗️ AGENTE: Supabase Architect (condicional)
**Responsabilidade:** Ativar se a integração precisa de novas colunas ou tabelas.

- Criar migration para as tabelas/colunas novas (ex: `payment_status`, `whatsapp_session_id`)
- Garantir `clinic_id` e `ENABLE ROW LEVEL SECURITY` em qualquer nova tabela

**✅ Gate (condicional):** Migration executada com sucesso.

---

## 🛡️ Passo 4 — 🔐 AGENTE: RLS & Tenant Guardian
**Responsabilidade:** Validar que a Edge Function não vazará dados entre clínicas.

- A Edge Function valida o `clinic_id` recebido contra o banco antes de processar?
- O webhook usa um segredo compartilhado (`x-api-key`) ou validade de assinatura?
- Se a Edge Function grava no banco, ela usa `service_role` mas filtra por `clinic_id` explicitamente?

**✅ Gate:** Não é possível disparar a integração de uma clínica e afetar dados de outra.

---

## 🔭 Passo 5 — 🔭 AGENTE: Observability & Audit
**Responsabilidade:** Adicionar logs e alertas para monitorar a integração em produção.

- `console.info` para eventos bem sucedidos com `clinic_id` e timestamp
- `console.error` para falhas com o erro completo (sem dados do paciente)
- Garantir que a Edge Function retorna erros com status HTTP correto (400, 401, 500)
- Documentar: como verificar os logs no Supabase Dashboard > Edge Functions > Logs

**✅ Gate:** Logs visíveis no dashboard, falhas retornam status HTTP correto.

---

## 🚀 Passo 6 — 📦 AGENTE: Release/DevOps
**Responsabilidade:** Deploy da Edge Function e configuração dos secrets.

- Configurar os secrets no Supabase: `supabase secrets set NOME_DA_KEY=valor --project-ref fvxxlrzaqqewihuabcxu`
- Fazer deploy da Edge Function via Management API ou workflow `/deploy-supabase`
- Commit e push das mudanças de código: `feat: integração com [serviço]`

**✅ Gate:** Edge Function deployada, secrets configurados, integração testada com payload real.

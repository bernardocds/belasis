---
description: Resolver bug em produção com correção mínima e validação rápida
---

# Workflow: Bug em Produção

> Use com: `/bug-producao [descrição do bug]`
> Exemplo: `/bug-producao login voltando para tela de senha em loop`

---

## 🔎 Passo 1 — 🔭 AGENTE: Observability & Audit
**Responsabilidade:** Coletar logs e evidências para entender o contexto do erro.

- Ler o stack trace ou a mensagem de erro exata fornecida pelo usuário
- Verificar se o erro é frontend (console do browser) ou backend (Supabase logs/Edge Function)
- Identificar: qual tabela / qual Edge Function / qual componente está falhando?
- Verificar se o problema é isolado (um usuário) ou generalizado (todos)

**✅ Gate:** Causa raiz hipotética identificada com evidências.

---

## 🔬 Passo 2 — 🐛 AGENTE: Debugger / Triage
**Responsabilidade:** Encontrar a causa raiz exata e propor a correção mínima possível.

- Ler o arquivo exato apontado pelo stack trace/log
- Reproduzir mentalmente o fluxo que causou o erro
- Propor a menor mudança possível para corrigir (sem refatorar a função toda)
- Se o bug for em RLS: verificar a policy que está bloqueando ou permitindo errado
- Se o bug for em Edge Function: verificar o payload e o handler do erro
- Se o bug for no Frontend: verificar o hook/state/useEffect problemático

**⚠️ Regra:** Correção MÍNIMA. Não refatorar, não renomear variáveis não relacionadas, não mover arquivos.

**✅ Gate:** Correção localizada em menos de 3 arquivos.

---

## 🛡️ Passo 3 — 🔐 AGENTE: RLS & Tenant Guardian (condicional)
**Responsabilidade:** Ativar SOMENTE se o bug envolve permissões, isolamento ou RLS.

- Verificar se a correção do bug não abre uma brecha de segurança
- Garantir que o fix não deixa dados de uma clínica visíveis para outra
- Re-testar o isolamento multi-clínica após a correção

**✅ Gate (condicional):** Se há mudança em RLS/policy, validar com usuário de clínica diferente.

---

## 🧪 Passo 4 — 🔬 AGENTE: QA Smoke & Regression
**Responsabilidade:** Validar o fix e garantir que não quebrou nada existente.

- [ ] O comportamento bugado foi corrigido?
- [ ] O fluxo que continha o bug funciona ponta a ponta?
- [ ] Os 3 fluxos críticos continuam funcionando? (Login, Convite de Equipe, Agendamento)
- [ ] Build compila sem erros TypeScript?

**✅ Gate:** Todos os checkboxes marcados.

---

## 🚀 Passo 5 — 📦 AGENTE: Release/DevOps
**Responsabilidade:** Deploy rápido do hotfix em produção.

- Fazer commit semântico: `fix: [descrição curta do bug]`
- Push imediato para `origin main`
- Orientar o usuário a sincronizar no Lovable se necessário
- Documentar o bug e a solução brevemente para referência futura

**✅ Gate:** Fix em produção confirmado pelo usuário.

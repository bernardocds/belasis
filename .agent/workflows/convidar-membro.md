---
description: Convidar um novo membro para a clínica (doctor, attendant, admin)
---

# Workflow: Convidar Membro de Equipe

> Use com: `/convidar-membro`
> Exemplo: `/convidar-membro` (fluxo guiado passo a passo)

---

## 🧭 Passo 1 — 🧭 AGENTE: Orchestrator
**Responsabilidade:** Coletar as informações necessárias antes de iniciar.

Perguntar ao usuário:
- E-mail do novo membro?
- Cargo/role? (`doctor`, `attendant`, `admin`)
- O membro já tem conta no sistema? (Se sim, apenas vincula à clínica)

---

## 🔐 Passo 2 — 🔐 AGENTE: RLS & Tenant Guardian
**Responsabilidade:** Garantir que a operação é segura antes de executar.

- Verificar se o usuário logado é `admin` ou `owner` da clínica
- Confirmar que o e-mail não pertence a uma clínica concorrente
- A RPC `create_invited_user` valida o `clinic_id` contra o `auth.uid()` — não confiar cegamente no frontend

**✅ Gate:** Apenas admin/owner pode executar o convite.

---

## ⚡ Passo 3 — 💻 AGENTE: Lovable Frontend Builder (já implementado)
**Responsabilidade:** A UI em `Configuracoes.tsx` > Aba Equipe está pronta.

Lembrar o usuário:
1. Acessar `Configurações > Equipe`
2. Preencher o e-mail e selecionar o cargo
3. Clicar em **"Enviar Convite"**
4. Copiar a **senha provisória** gerada e enviar para o membro
5. Instruir o membro: fazer login com a senha provisória → sistema exige criar nova senha

---

## 🔬 Passo 4 — 🔬 AGENTE: QA Smoke & Regression
**Responsabilidade:** Confirmar que o convite funcionou corretamente.

- [ ] O membro aparece na lista "Membros Ativos" da aba Equipe?
- [ ] O convite pendente sumiu após o primeiro login do membro?
- [ ] O membro consegue acessar apenas o que seu role permite?

**✅ Gate:** Membro ativo com acesso correto conforme o cargo.

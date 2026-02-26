---
description: Auditoria de seguranca multi-clinica: RLS, roles e isolamento de dados
---

# Workflow: Auditoria de Segurança

> Use com: `/auditoria-seguranca`
> Exemplo: `/auditoria-seguranca` (rodar periodicamente ou antes de lançar nova feature)

---

## 🔭 Passo 1 — 🔭 AGENTE: Observability & Audit
**Responsabilidade:** Coletar o estado atual de todas as tabelas e policies existentes.

- Listar todas as tabelas do schema `public`
- Para cada tabela: verificar se RLS está habilitado
- Identificar tabelas sem QUALQUER policy definida (tabela com RLS habilitado mas sem policy = ninguém acessa = bug!)
- Gerar relatório: `[tabela] → RLS: sim/não → Policies: N`

**✅ Gate:** Relatório completo de todas as tabelas e suas policies gerado.

---

## 🛡️ Passo 2 — 🔐 AGENTE: RLS & Tenant Guardian
**Responsabilidade:** Revisar cada policy e validar que isolamento multi-clínica está correto.

Checklist por tabela:
- [ ] Policy SELECT: filtra por `clinic_id` usando `auth.uid()` via `clinic_users`?
- [ ] Policy INSERT: verifica se o usuário pertence à clínica antes de inserir?
- [ ] Policy DELETE/UPDATE: restrita a `admin` ou `owner` somente?
- [ ] Nenhuma policy usa `clinic_id = [valor literal]` hardcoded?
- [ ] `clinic_users` em si está protegida? (usuário não pode se adicionar livremente)
- [ ] `clinic_invites` exige que quem cria seja admin/owner da clínica?

**Antipatterns a encontrar e corrigir:**
- ❌ `USING (true)` — acesso público sem restrição
- ❌ `clinic_id = current_setting('app.clinic_id')` vindo do client
- ❌ Tabela sem nenhuma policy (inacessível para todos = bug latente)

**✅ Gate:** Nenhuma policy permissiva ou aberta. Isolamento confirmado.

---

## 🔬 Passo 3 — 🔬 AGENTE: QA Smoke & Regression
**Responsabilidade:** Testar o isolamento com cenários práticos simulados.

Testes obrigatórios:
- [ ] Query como `owner` da Clínica A: retorna apenas dados da Clínica A?
- [ ] Query como `doctor` da Clínica B: retorna apenas dados da Clínica B?
- [ ] Tentativa de INSERT na Clínica A com usuário da Clínica B: é bloqueada?
- [ ] Tentativa de DELETE de registro da Clínica A por `attendant`: é bloqueada?
- [ ] Usuário sem clínica (recém-cadastrado): não enxerga nenhum dado?

**✅ Gate:** Todos os testes de isolamento passando.

---

## 🧭 Passo 4 — 🧭 AGENTE: Orchestrator (Relatório Final)
**Responsabilidade:** Consolidar achados e gerar lista de ações corretivas priorizadas.

- Listar vulnerabilidades encontradas por grau de risco (alto/médio/baixo)
- Propor as correções em ordem de prioridade
- Apontar quais agentes executarão cada correção (Architect para schema, Guardian para RLS)
- Gerar checklist de "Pós-Auditoria" para acompanhamento

**✅ Gate:** Relatório de segurança entregue ao usuário com plano de ação claro.

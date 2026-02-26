---
description: Criar uma nova feature completa (schema → RLS → UI → testes → release)
---

# Workflow: Nova Feature

> Use com: `/nova-feature [descrição da feature]`
> Exemplo: `/nova-feature relatório de atendamentos por período`

---

## 🎯 Passo 1 — 🧭 AGENTE: Planner (PM)
**Responsabilidade:** Transformar a ideia em tarefas pequenas com critérios de pronto e prioridades.

- Entenda exatamente o que o usuário quer construir
- Liste as entidades/tabelas de dados envolvidas
- Defina os perfis (roles) que terão acesso (owner, admin, doctor, attendant)
- Divida em subtarefas menores: schema → UI → integração
- Documente os critérios de "pronto" para essa feature

**✅ Gate:** Tarefas claras, escopo fechado, roles de acesso definidos.

---

## 🗄️ Passo 2 — 🏗️ AGENTE: Supabase Architect
**Responsabilidade:** Criar/alterar tabelas, relacionamentos e índices de forma segura e versionada.

- Criar a migration SQL com a nova tabela ou colunas
- Garantir que `clinic_id` seja obrigatório (`NOT NULL`) em toda tabela multi-tenant
- Adicionar `ENABLE ROW LEVEL SECURITY` imediatamente após `CREATE TABLE`
- Criar índices para queries frequentes (ex: `CREATE INDEX ON tabela(clinic_id)`)
- NUNCA alterar tabelas core (`clinicas`, `clinic_users`, `appointments`) sem aprovação explícita

**✅ Gate:** Migration executada com sucesso, sem erros, tabela com RLS habilitado.

---

## 🛡️ Passo 3 — 🔐 AGENTE: RLS & Tenant Guardian
**Responsabilidade:** Criar/revisar todas as policies RLS garantindo isolamento multi-clínica.

- Criar políticas para cada operação: SELECT, INSERT, UPDATE, DELETE
- Toda policy DEVE validar `clinic_id` contra `clinic_users` usando `auth.uid()`
- Nunca confiar em `clinic_id` vindo do cliente (Frontend/App). Sempre derivar do `auth.uid()`
- Validar que um usuário da Clínica A JAMAIS enxerga dados da Clínica B
- Verificar se as policies por `role` estão corretas (ex: apenas `admin` insere)
- Checklist de isolamento: testar com 2 usuários de clínicas diferentes

**✅ Gate:** Queries com usuário da clínica A retornam zero resultados de dados da clínica B.

---

## 🖥️ Passo 4 — 💻 AGENTE: Lovable Frontend Builder
**Responsabilidade:** Construir a tela/componente no Frontend e integrar com Supabase.

- Criar o(s) arquivo(s) de página/componente em `lovable-frontend/src/pages/` ou `components/`
- Usar `supabase.from('tabela').select()` para queries; nunca expor `service_role_key`
- Garantir que a UI respeita as permissões: esconder botões/ações que o `role` atual não tem acesso
- Seguir o design system (glassmorphism, cores primárias, `gradient-primary` do projeto)
- Registrar a rota nova em `App.tsx` se for uma página

**✅ Gate:** Tela renderiza sem erros; ações que o usuário não tem permissão ficam invisíveis na UI.

---

## 🧪 Passo 5 — 🔬 AGENTE: QA Smoke & Regression
**Responsabilidade:** Validar a feature end-to-end e regredir os fluxos críticos.

Executar os seguintes testes antes de fazer o commit:

- [ ] Fluxo principal da nova feature funciona com `owner`?
- [ ] O `doctor`/`attendant` consegue ou é bloqueado conforme a spec?
- [ ] Dados de uma clínica não aparecem para outra (isolamento multi-tenant)?
- [ ] Fluxos críticos existentes ainda funcionam? (Login, Agendamento, Convite de Equipe)
- [ ] Build do projeto compila sem erros TypeScript? (`npm run build`)

**✅ Gate:** Todos os checkboxes marcados. Zero regressões.

---

## 🚀 Passo 6 — 📦 AGENTE: Release/DevOps
**Responsabilidade:** Fazer commit, push e garantir deploy correto no Lovable.

- Fazer commit semântico: `feat: [nome da feature]`
- Push para `origin main` no repositório `saas-assistente-ia-xxxxxx`
- Orientar o usuário a fazer "Sync" no Lovable se necessário
- Confirmar que nenhuma variável de ambiente nova foi adicionada sem estar no Supabase Secrets

**✅ Gate:** Push realizado com sucesso, Lovable atualizado ou instruções de sync fornecidas.

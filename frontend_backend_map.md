# Plano de Implementação: Frontend x Backend Supabase

Aqui está o comparativo com base no schema que já existe no Supabase (fornecido na sua primeira mensagem) e as tabelas que o Lovable vai precisar para o seu checklist final.

## 1) Auth + sessão + guard de rotas
- **STATUS:** ✅ **Pronto no Backend.**
- Supabase Auth (Email + Senha) lida perfeitamente com isso de forma nativa. É só configurar no Lovable.

## 2) Onboarding (`clinics` + `clinic_users`)
- **STATUS:** ⚠️ **Parcialmente pronto.**
- **O que temos:** Tabela `clinicas` (com `id`, `user_id`, `nome`). O `user_id` vincula o criador à clínica.
- **O que FALTA no backend:** Não temos uma tabela `clinic_users` para múltiplas permissões (ex: outro usuário acessar a mesma clínica com `role = admin`/`doctor`).
- **Sugestão para o passo 1:** Se o MVP for 1 clínica = 1 dono (logado), você pode apenas usar a tabela existente `clinicas` e checar `onde user_id = usuario_logado`. Caso contrário, precisaremos criar a tabela `clinic_users` no Supabase antes de você fazer essa parte no Lovable.

## 3) Dashboard (Sidebar e KPIs)
- **STATUS:** ✅ **Pronto no Backend (via queries).**
- Você vai usar as tabelas que já temos (`agendamentos` e `conversas`) filtrando por `clinic_id = active_clinic_id` e a data de `today`.

## 4) Pacientes (`patients`)
- **STATUS:** ❌ **Falta no Backend.**
- **O que temos:** Atualmente o nome e o telefone ficam salvos diretamente na tabela de `conversas` (`paciente_nome`, `paciente_telefone`) e `agendamentos`.
- **O que precisamos criar no Supabase:** Uma tabela separada `pacientes` (`id`, `clinic_id`, `nome`, `telefone`, `email`, `cpf`, `data_nascimento`, `created_at`). Além disso, precisaríamos linkar `conversa_id` ou `agendamentos` a um `paciente_id` para o histórico puxar certinho.

## 5) Agenda (`appointments` / `agendamentos`)
- **STATUS:** ⚠️ **Parcialmente pronto.**
- **O que temos:** Temos a tabela `agendamentos` (`id`, `clinic_id`, `conversa_id`, `paciente_nome`, `paciente_telefone`, `procedimento_id`, `data_hora`, `status`).
- **O que FALTA no backend:** Se quisermos vincular um dentista/médico, falta a coluna `professional_id`. Se criarmos a tabela `pacientes` (Passo 4), o ideal é que a tabela `agendamentos` tenha o `paciente_id` ao invés de repetir `paciente_nome` e `telefone`. Tem também a coluna `duracao` ou o horário de fim, caso o Lovable precise plotar numa agenda visual.

## 6) Atendimentos (`encounters` / `prontuarios`)
- **STATUS:** ❌ **Falta no Backend.**
- **O que precisamos criar no Supabase:** Tabela `atendimentos` (ou `encounters`) contendo `id`, `clinic_id`, `paciente_id`, `agendamento_id`, `professional_id`, `queixa_principal`, `anamnese`, `evolucao`, `conduta`, `created_at`.

## 7) Prescrições (`prescriptions`)
- **STATUS:** ❌ **Falta no Backend.**
- **O que precisamos criar no Supabase:** Tabela `prescricoes` (`id`, `clinic_id`, `paciente_id`, `atendimento_id`, `professional_id`, `tipo`, `status` [ex: draft, signed], `conteudo`, `created_at`).

---

### Resumo para seguir numa linha de raciocínio:

Para você fazer o seu front no **Lovable** exatamente da forma especificada no seu passo a passo, eu sugiro que **eu crie logo as tabelas ou adicione as colunas que faltam no Supabase**.

**Quer que eu crie agora as seguintes tabelas/relacionamentos no banco de dados para deixar 100% alinhado com o seu Lovable?**
1. Tabela `pacientes`
2. Tabela `atendimentos` (encounters)
3. Tabela `prescricoes`
4. Tabela `clinic_users` (se for querer multi-acesso por clínica)
5. Adicionar `professional_id`, `paciente_id` e `duracao` na tabela `agendamentos` existente.

Se você disser "Sim", eu escrevo o plano SQL completo, você revisa, e eu aplico. Assim o banco de dados já fica no esquema pra você plugar o Lovable e voar!

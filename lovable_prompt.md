# Objetivo
Construir o Dashboard B2B "BellAssist" para clínicas de estética e saúde. O backend e o banco de dados (Supabase) já estão 100% configurados com as tabelas e schemas necessários. Seu papel agora (Lovable) é APENAS construir o Frontend conectando com as tabelas existentes, sem alterar o schema do banco de dados ou criar tabelas novas.

# Contexto do Banco de Dados Atual (Supabase)
As seguintes tabelas já existem e devem ser utilizadas como fonte de verdade:
- `clinicas` (id, user_id, nome, prompt, whatsapp_status)
- `clinic_users` (id, clinic_id, user_id, role)
- `pacientes` (id, clinic_id, nome, telefone, email, cpf, data_nascimento)
- `agendamentos` (id, clinic_id, paciente_id, professional_id, data_hora, duracao_min, observacao, status)
- `atendimentos` / Prontuário (id, clinic_id, paciente_id, agendamento_id, professional_id, queixa_principal, anamnese, evolucao, conduta)
- `prescricoes` (id, clinic_id, paciente_id, atendimento_id, professional_id, tipo, status, conteudo_texto)
- `conversas` (id, clinic_id, paciente_nome, paciente_telefone)
- `mensagens` (id, conversa_id, role, conteudo)

**REGRA GERAL:** Em todas as queries do frontend, você DEVE obrigatoriamente filtrar os dados usando `where clinic_id = active_clinic_id`, para que o usuário veja apenas os dados da clínica que ele está gerenciando.

---

# Checklist de Implementação Frontend (Ordem de Execução)

## 1. Auth, Sessão e Rotas
- Crie as páginas `/login` e `/dashboard`.
- Configure o componente de Login utilizando Email e Senha (conectado ao Supabase Auth).
- Crie um "route guard": usuários não autenticados devem ser redirecionados para `/login`. Usuários autenticados no `/login` devem ir para `/dashboard`.
- No header de navegação (todas as páginas logadas), inclua um botão de "Sair" (`supabase.auth.signOut`).

## 2. Onboarding e Contexto de Clínica (active_clinic_id)
- Crie a página `/onboarding`.
- Se o usuário não estiver vinculado a nenhuma clínica (verifique na tabela `clinic_users` ou `clinicas` onde `user_id = usuário_logado`), exiba uma tela para "Criar Clínica" (fazendo insert na tabela `clinicas` e vinculando o usuário como admin em `clinic_users`).
- Se houver vínculo, defina a clínica como ativa (salve o `active_clinic_id` no estado global ou localStorage).
- Pelo resto do app, use esse `active_clinic_id` para todas as leituras e inserções.

## 3. Estrutura de Layout e Dashboard
- Crie uma **Sidebar** com links para: Dashboard `/dashboard`, Agenda `/schedule`, Pacientes `/patients` e Configurações (opcional).
- Na tela `/dashboard`, crie Cards de KPIs (ex: "Consultas Hoje", "Atendimentos na Semana"). Preencha-os fazendo um `COUNT` ou `SELECT` na tabela `agendamentos` filtrando por `clinic_id = active_clinic_id`.

## 4. Módulo de Pacientes (CRUD)
- Crie a página `/patients` contendo uma tabela ou lista de pacientes lendo da tabela `pacientes` (`where clinic_id = active_clinic_id`).
- Adicione um campo de busca por nome/telefone e um botão "Novo Paciente".
- O botão "Novo Paciente" deve abrir um Modal com um formulário rápido (Nome*, Telefone, CPF). Ação: `INSERT INTO pacientes`.
- Adicione a rota de detalhes `/patients/:id` separada em Abas:
  - **Dados do Paciente** (ler de `pacientes` por ID)
  - **Histórico de Atendimentos** (ler de `atendimentos` filtrando por `paciente_id`)
  - **Prescrições** (ler de `prescricoes` filtrando por `paciente_id`)

## 5. Módulo de Agenda
- Crie a página `/schedule` renderizando um calendário (semanal ou listagem por dia).
- O calendário deve ler os dados de `agendamentos` (`where clinic_id = active_clinic_id`).
- Adicione um botão "Novo Agendamento" que abre um modal para criar o `INSERT` em `agendamentos`. Campos necessários: Paciente (select puxando de `pacientes`), Data/hora de início, profissional (opcional no MVP).
- No card do agendamento dentro do calendário, permita a alteração do `status` do agendamento (ex: confirmado, cancelado, em atendimento) e um botão "Iniciar Atendimento".

## 6. Módulo Clínico (Prontuários e Prescrições)
- O botão "Iniciar Atendimento" da agenda deve fazer um `INSERT` na tabela `atendimentos` (vinculando `clinic_id`, `paciente_id` e o `agendamento_id`) e em seguida redirecionar o médico para a rota `/encounters/:id`.
- Na tela `/encounters/:id`, crie seções/textareas simples para evolução do paciente: Queixa Principal, Anamnese, Evolução e Conduta. Utilize "auto-save" ou um botão para dar `UPDATE` na tabela `atendimentos`.
- Adicione uma aba ou botão "Nova Prescrição", que permite criar textos livres para receitas ou atestados. A ação salvará um rascunho: `INSERT INTO prescricoes` (`status = 'draft'`).
- Mostre a lista de prescrições deste atendimento. No MVP 1, adicione um botão de "Assinar" que, por enquanto, é apenas um *Stub* visual e muda o `status` para `'signed'`, escondendo o botão de Editar e mostrando "Ver Documento".

---

Mantenha o design limpo, moderno e focado na facilidade de uso do profissional de saúde. Siga estritamente os nomes de tabelas fornecidos neste prompt.

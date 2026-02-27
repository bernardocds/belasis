# Threat Model (Resumo Operacional)

## Ativos criticos

- Dados de pacientes e agendamentos (PII/saude).
- Integracoes WhatsApp/webhook e tokens de API.
- Isolamento entre clinicas (`clinic_id`).
- Assinaturas e autorizacoes administrativas.

## Fronteiras de confianca

- Cliente (WhatsApp/web app) -> Edge Functions.
- Edge Functions -> Postgres (Supabase).
- Edge Functions -> APIs terceiras (Evolution/Asaas).
- GitHub Actions -> Funcoes internas por cron.

## Ameaças prioritarias

- IDOR/BOLA: acesso cruzado de dados trocando IDs.
- Bypass de RLS/policy fraca em tabelas sensiveis.
- Execucao indevida de cron/webhook sem segredo interno.
- Vazamento de segredos por log ou commit.
- Inconsistencia de data/hora gerando agendamentos incorretos.

## Mitigacoes implementadas

- RLS habilitado nas tabelas criticas e grants minimos.
- Policies tenant-scoped por `clinic_id` e `auth.uid()`.
- Segredo interno para rotas de cron (`INTERNAL_CRON_SECRET`).
- Workflow de seguranca com secret scan, audit de deps e checks.
- Teste automatizado de isolamento multi-clinica.

## Riscos residuais (monitorar)

- Permissoes `service_role` exigem controle estrito de segredos.
- Novas funcoes podem reintroduzir logs sensiveis se checklist nao for seguido.
- Dependencias podem ganhar CVEs entre releases.

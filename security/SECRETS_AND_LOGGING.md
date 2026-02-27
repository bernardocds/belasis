# Guia de Segredos e Logs

## Segredos

- Nunca commitar tokens/chaves/senhas em codigo, markdown ou scripts.
- Usar somente `Supabase Secrets` e `GitHub Actions Secrets`.
- Rotacionar segredos de integracoes criticas periodicamente.
- Limitar escopo de cada chave ao minimo necessario.

## Padrao minimo para funcoes internas

- Funcoes acionadas por cron/webhook interno exigem `x-internal-secret`.
- Header recebido deve ser comparado com `INTERNAL_CRON_SECRET`.
- Em ausencia de segredo, registrar alerta e tratar como incidente de configuracao.

## Logs seguros

- Nao logar: tokens, Authorization headers, payload completo de webhook, dados medicos sensiveis.
- Logar apenas metadados tecnicos: `clinic_id`, `request_id`, status, erro resumido.
- Mensagens de erro para cliente sem detalhes internos de stack.

## Resposta a incidente (basico)

- Vazou segredo: rotacionar imediatamente, invalidar credenciais antigas e revisar acessos.
- Comportamento suspeito: coletar `request_id`, janela temporal e endpoint afetado.
- Registrar timeline do incidente e acao corretiva antes de reabrir deploy.

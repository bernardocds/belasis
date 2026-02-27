# Security Checklist por PR

Use esta checklist em toda PR que toca backend, banco ou automacoes.

- [ ] Mudancas de dados multi-clinica sempre filtram por `clinic_id` do contexto autenticado.
- [ ] Nenhum endpoint/conf function aceita `clinic_id` confiando em input do cliente sem validacao no servidor.
- [ ] Novas tabelas com dados de negocio tem RLS habilitado e policies revisadas.
- [ ] Policies `USING (true)` para `public/authenticated` nao foram introduzidas em tabelas sensiveis.
- [ ] Segredos nao aparecem em codigo, logs, testes, exemplos ou commits.
- [ ] Logs de webhook/autenticacao nao imprimem token, senha, payload sensivel ou dados de saude.
- [ ] Rotas/funcoes de automacao possuem autenticacao interna (`x-internal-secret` ou equivalente).
- [ ] Mudancas em agendamento/cancelamento respeitam fuso horario e validacao de data/weekday no backend.
- [ ] Testes de isolamento multi-tenant foram executados (`node security/scripts/test_isolation.js`).
- [ ] Auditoria de RLS foi executada sem bloqueios (`node security/scripts/audit_security.js`).

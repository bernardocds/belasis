# Matriz de Autorizacao (Multi-Clinica)

## Perfis

- `owner`: dono da clinica.
- `admin`: administrador da clinica.
- `doctor`/`attendant`: membros operacionais.
- `service_role`: automacoes server-side.

## Regras principais

- Todo acesso de usuario autenticado deve ser limitado ao conjunto de clinicas do usuario.
- Escrita administrativa (`configuracoes_clinica`, `subscriptions`) restrita a `owner/admin`.
- `super_admins` nao permite escrita por usuarios comuns.

## Tabela por tabela (resumo)

- `clinicas`
- `owner`: CRUD da propria clinica.
- `membros`: SELECT da clinica vinculada.

- `clinic_users`
- `owner/admin`: gestao de membros por fluxo controlado (invite/RPC).
- `membros`: SELECT limitado a clinicas vinculadas.

- `agendamentos`, `pacientes`, `atendimentos`, `procedimentos`, `prescricoes`, `mensagens`, `conversas`, `documentos_paciente`, `notificacoes`
- `owner/admin/doctor/attendant`: acesso somente para registros do `clinic_id` permitido em RLS.
- Sem leitura/escrita cross-clinic.

- `configuracoes_clinica`
- `owner/admin`: INSERT/UPDATE/DELETE.
- `owner/admin/doctor/attendant`: SELECT dentro da clinica.

- `subscriptions`
- `owner/admin`: gerenciamento.
- `membros`: SELECT da propria clinica.

- `plans`
- Leitura publica (tabela de catalogo).

- `super_admins`
- Usuario autenticado: SELECT apenas da propria linha (`user_id = auth.uid()`).
- `service_role`: acesso administrativo completo.

## Validacao continua

- Auditoria: `node security/scripts/audit_security.js`.
- Isolamento: `node security/scripts/test_isolation.js`.

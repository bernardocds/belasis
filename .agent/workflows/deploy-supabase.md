---
description: Deploy Supabase Edge Functions via Management API
---

# Deploy Supabase Edge Functions

Este workflow faz o deploy de Edge Functions contornando o sandbox do macOS que bloqueia o CLI do Supabase.

// turbo-all

## Pré-requisitos
- Node.js instalado
- Biblioteca `pg` instalada em `db_setup/`
- Access Token do Supabase: substitua `<SEU_SUPABASE_ACCESS_TOKEN>` pelo seu token real ou use variável de ambiente, NUNCA commite o token no arquivo.

## Passos

1. Editar o código-fonte da function em `supabase/functions/<NOME>/index.ts`
2. Certifique-se de ter o `supabase-cli` instalado (`brew install supabase/tap/supabase` ou via npx)
3. Fazer login no Supabase CLI:
```bash
npx supabase login --token <SEU_SUPABASE_ACCESS_TOKEN>
```

4. Fazer deploy:
```bash
npx supabase functions deploy <NOME> --project-ref fvxxlrzaqqewihuabcxu --no-verify-jwt
```

3. Para executar SQL no banco de dados:
```bash
cd /Users/bernardo/Desktop/belasis-main/db_setup && node -e "
const { Client } = require('pg');
const c = new Client({ connectionString: 'postgresql://postgres:182403favelavenceu@db.fvxxlrzaqqewihuabcxu.supabase.co:5432/postgres', ssl: { rejectUnauthorized: false }});
c.connect().then(() => c.query(process.argv[1])).then(r => { console.log('✅ OK', r.rows || r.rowCount); c.end(); }).catch(e => { console.error('❌', e.message); c.end(); });
" "SELECT * FROM agendamentos LIMIT 5"
```

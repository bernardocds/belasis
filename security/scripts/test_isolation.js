/**
 * AGENTE: QA Smoke & Regression
 * Cenário de teste: Isolamento multi-clínica
 * 
 * Fluxo:
 * 1. Criar Clínica A com usuário A (owner)
 * 2. Criar Clínica B com usuário B (owner)
 * 3. Adicionar paciente à Clínica A
 * 4. Simular acesso do usuário A -> deve ver paciente da Clínica A
 * 5. Simular acesso do usuário B -> NÃO deve ver paciente da Clínica A
 * 6. Tentar INSERT de usuário B na Clínica A -> deve ser bloqueado
 * 7. Limpar todos os dados de teste
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

function parseDatabaseUrlFromEnvFile(filePath) {
    if (!fs.existsSync(filePath)) return '';
    const envFile = fs.readFileSync(filePath, 'utf8');
    for (const line of envFile.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        if (trimmed.startsWith('DATABASE_URL=')) {
            return trimmed.slice('DATABASE_URL='.length).replace(/["']/g, '').trim();
        }
    }
    return '';
}

function getDatabaseUrl() {
    if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

    const candidates = [
        path.resolve(__dirname, '../.env.local'),
        path.resolve(process.cwd(), '.env.local'),
        path.resolve(process.cwd(), '../.env.local'),
    ];

    for (const candidate of candidates) {
        const value = parseDatabaseUrlFromEnvFile(candidate);
        if (value) return value;
    }

    throw new Error('DATABASE_URL não encontrado. Defina DATABASE_URL no ambiente ou em .env.local');
}

const PASS = "✅ PASSOU";
const FAIL = "❌ FALHOU";

async function runAsUser(dbUrl, userId, testFn) {
    const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    // Simula o contexto JWT do Supabase para habilitar RLS como aquele usuário
    await client.query(`SET LOCAL role = authenticated;`);
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: userId, role: 'authenticated' })
    ]);
    const result = await testFn(client);
    await client.end();
    return result;
}

async function main() {
    const dbUrl = getDatabaseUrl();
    const adminClient = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await adminClient.connect();

    const results = [];
    let runtimeError = null;
    let userA_id, userB_id, clinicA_id, clinicB_id, paciente_id;

    console.log("\n======================================================");
    console.log("🧪 AGENTE: QA Smoke & Regression — Teste de Isolamento");
    console.log("======================================================\n");

    try {
        // ---- SETUP: Criar 2 usuários ----
        console.log("📋 SETUP: Criando usuários e clínicas de teste...");

        userA_id = (await adminClient.query(`
            INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change)
            VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'teste_user_a@isolamento.test', 'x', now(), '{}', now(), now(), '', '', '', '')
            RETURNING id;
        `)).rows[0].id;
        userB_id = (await adminClient.query(`
            INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change)
            VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'teste_user_b@isolamento.test', 'x', now(), '{}', now(), now(), '', '', '', '')
            RETURNING id;
        `)).rows[0].id;

        // Clínica A (owned by userA)
        clinicA_id = (await adminClient.query(`
            INSERT INTO public.clinicas (nome, user_id) VALUES ('Clínica A (TESTE)', $1) RETURNING id;
        `, [userA_id])).rows[0].id;

        // Clínica B (owned by userB)
        clinicB_id = (await adminClient.query(`
            INSERT INTO public.clinicas (nome, user_id) VALUES ('Clínica B (TESTE)', $1) RETURNING id;
        `, [userB_id])).rows[0].id;

        // Vincular na clinic_users
        await adminClient.query(`INSERT INTO public.clinic_users (clinic_id, user_id, role) VALUES ($1, $2, 'owner')`, [clinicA_id, userA_id]);
        await adminClient.query(`INSERT INTO public.clinic_users (clinic_id, user_id, role) VALUES ($1, $2, 'owner')`, [clinicB_id, userB_id]);

        // Paciente na Clínica A
        paciente_id = (await adminClient.query(`
            INSERT INTO public.pacientes (nome, clinic_id) VALUES ('Paciente Secreto da Clínica A', $1) RETURNING id;
        `, [clinicA_id])).rows[0].id;

        console.log(`  userA: ${userA_id}`);
        console.log(`  userB: ${userB_id}`);
        console.log(`  clinicA: ${clinicA_id}`);
        console.log(`  clinicB: ${clinicB_id}`);
        console.log(`  paciente: ${paciente_id}\n`);

        // ---- TESTE 1: userA vê sua própria clínica ----
        {
            const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
            await client.connect();
            await client.query(`BEGIN`);
            await client.query(`SET LOCAL role = authenticated`);
            await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userA_id, role: 'authenticated' })]);

            const r = await client.query(`SELECT id FROM public.clinicas WHERE id = $1`, [clinicA_id]);
            const passed = r.rows.length === 1;
            results.push({ test: "UserA lê Clínica A (sua própria)", result: passed ? PASS : FAIL });

            await client.query(`ROLLBACK`);
            await client.end();
        }

        // ---- TESTE 2: userB NÃO vê Clínica A ----
        {
            const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
            await client.connect();
            await client.query(`BEGIN`);
            await client.query(`SET LOCAL role = authenticated`);
            await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userB_id, role: 'authenticated' })]);

            const r = await client.query(`SELECT id FROM public.clinicas WHERE id = $1`, [clinicA_id]);
            const passed = r.rows.length === 0; // deve retornar 0 linhas
            results.push({ test: "UserB NÃO lê Clínica A (isolamento)", result: passed ? PASS : FAIL });

            await client.query(`ROLLBACK`);
            await client.end();
        }

        // ---- TESTE 3: userA vê paciente da sua clínica ----
        {
            const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
            await client.connect();
            await client.query(`BEGIN`);
            await client.query(`SET LOCAL role = authenticated`);
            await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userA_id, role: 'authenticated' })]);

            const r = await client.query(`SELECT id FROM public.pacientes WHERE id = $1`, [paciente_id]);
            const passed = r.rows.length === 1;
            results.push({ test: "UserA lê paciente da Clínica A", result: passed ? PASS : FAIL });

            await client.query(`ROLLBACK`);
            await client.end();
        }

        // ---- TESTE 4: userB NÃO vê paciente da Clínica A ----
        {
            const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
            await client.connect();
            await client.query(`BEGIN`);
            await client.query(`SET LOCAL role = authenticated`);
            await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userB_id, role: 'authenticated' })]);

            const r = await client.query(`SELECT id FROM public.pacientes WHERE id = $1`, [paciente_id]);
            const passed = r.rows.length === 0; // deve retornar 0 linhas
            results.push({ test: "UserB NÃO lê paciente da Clínica A (isolamento)", result: passed ? PASS : FAIL });

            await client.query(`ROLLBACK`);
            await client.end();
        }

        // ---- TESTE 5: userB NÃO consegue se adicionar à Clínica A ----
        {
            const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
            await client.connect();
            await client.query(`BEGIN`);
            await client.query(`SET LOCAL role = authenticated`);
            await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userB_id, role: 'authenticated' })]);

            let blocked = false;
            try {
                await client.query(`INSERT INTO public.clinic_users (clinic_id, user_id, role) VALUES ($1, $2, 'admin')`, [clinicA_id, userB_id]);
            } catch (e) {
                blocked = true; // RLS deve bloquear
            }
            results.push({ test: "UserB NÃO consegue se inserir na Clínica A como admin", result: blocked ? PASS : FAIL });

            await client.query(`ROLLBACK`);
            await client.end();
        }

    } catch (err) {
        console.error("Erro durante os testes:", err.message);
        runtimeError = err;
    } finally {
        // ---- CLEANUP: Remover todos os dados de teste ----
        console.log("\n🧹 CLEANUP: Removendo dados de teste...");
        if (paciente_id) await adminClient.query(`DELETE FROM public.pacientes WHERE id = $1`, [paciente_id]);
        if (userA_id) await adminClient.query(`DELETE FROM public.clinic_users WHERE user_id IN ($1, $2)`, [userA_id, userB_id]).catch(() => { });
        if (clinicA_id) await adminClient.query(`DELETE FROM public.clinicas WHERE id IN ($1, $2)`, [clinicA_id, clinicB_id]).catch(() => { });
        if (userA_id) await adminClient.query(`DELETE FROM auth.identities WHERE user_id IN ($1, $2)`, [userA_id, userB_id]).catch(() => { });
        if (userA_id) await adminClient.query(`DELETE FROM auth.users WHERE id IN ($1, $2)`, [userA_id, userB_id]).catch(() => { });
        await adminClient.end();
        console.log("🧹 Limpeza concluída.\n");
    }

    // ---- RESULTADO FINAL ----
    console.log("======================================================");
    console.log("📊 RESULTADO DOS TESTES DE ISOLAMENTO MULTI-CLÍNICA");
    console.log("======================================================");
    const failed = results.filter(r => r.result === FAIL);
    for (const r of results) {
        console.log(`${r.result}  ${r.test}`);
    }
    console.log("------------------------------------------------------");
    console.log(failed.length === 0
        ? `\n🎉 TODOS OS ${results.length} TESTES PASSARAM! Isolamento multi-clínica confirmado.`
        : `\n🚨 ${failed.length} TESTE(S) FALHARAM! Investigar imediatamente.`
    );

    if (runtimeError || failed.length > 0) {
        process.exitCode = 1;
    }
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});

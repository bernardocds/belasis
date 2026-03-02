const { Client } = require('pg');

async function run() {
    const client = new Client({
        connectionString: (process.env.DATABASE_URL || '')
    });
    await client.connect();

    // 1. Add max_users and custom override columns
    await client.query(`
      ALTER TABLE plans ADD COLUMN IF NOT EXISTS max_users integer DEFAULT 3;
      ALTER TABLE clinicas ADD COLUMN IF NOT EXISTS custom_max_users integer;
      ALTER TABLE clinicas ADD COLUMN IF NOT EXISTS custom_max_clinics integer;
    `);

    // 2. Ensure the plans exist or update them
    const plans = [
        { id: 'start', nome: 'Start', max_users: 3, max_unidades: 1, preco_mensal: 197 },
        { id: 'growth', nome: 'Growth', max_users: 5, max_unidades: 1, preco_mensal: 297 },
        { id: 'pro', nome: 'Pro', max_users: 9, max_unidades: 2, preco_mensal: 397 },
        { id: 'enterprise', nome: 'Enterprise', max_users: 20, max_unidades: 5, preco_mensal: 597 }
    ];

    for (const p of plans) {
        // Upsert plans
        await client.query(`
        INSERT INTO plans (id, nome, max_users, max_unidades, preco_mensal, preco_anual, max_medicos, max_funcionarios, ativo)
        VALUES ($1, $2, $3, $4, $5, $6, $3, $3, true)
        ON CONFLICT (id) DO UPDATE SET 
          nome = $2, max_users = $3, max_unidades = $4, preco_mensal = $5, preco_anual = $6
      `, [p.id, p.nome, p.max_users, p.max_unidades, p.preco_mensal, p.preco_mensal * 10]);
    }

    console.log("Plans updated and schema changed!");

    await client.end();
}
run();

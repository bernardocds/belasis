const { Client } = require('pg');

async function run() {
    const client = new Client({
        connectionString: (process.env.DATABASE_URL || '')
    });
    await client.connect();

    await client.query(`
    ALTER TABLE clinicas 
    ADD COLUMN IF NOT EXISTS cobrar_sinal boolean DEFAULT false,
    ADD COLUMN IF NOT EXISTS valor_sinal numeric DEFAULT 0,
    ADD COLUMN IF NOT EXISTS chave_pix varchar(255);
    
    ALTER TABLE agendamentos
    ADD COLUMN IF NOT EXISTS pagamento_status varchar(50) DEFAULT 'nao_aplicavel'; -- 'nao_aplicavel', 'pendente', 'pago'
  `);
    console.log("Columns added successfully");

    await client.end();
}
run();

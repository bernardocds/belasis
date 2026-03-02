const { Client } = require('pg');

async function run() {
    const client = new Client({
        connectionString: (process.env.DATABASE_URL || '')
    });
    await client.connect();

    await client.query(`
    ALTER TABLE agendamentos 
    ADD COLUMN IF NOT EXISTS lembrete_1h_enviado boolean DEFAULT false;
  `);
    console.log("Column lembrete_1h_enviado added successfully");

    await client.end();
}
run();

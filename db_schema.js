const { Client } = require('pg');

async function run() {
    const client = new Client({
        connectionString: (process.env.DATABASE_URL || '')
    });
    await client.connect();

    const res1 = await client.query(`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'agendamentos';
  `);
    console.log("Agendamentos columns:", res1.rows);

    const res2 = await client.query(`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'clinicas';
  `);
    console.log("Clinicas columns:", res2.rows);

    const res3 = await client.query(`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'profissionais';
  `);
    console.log("Profissionais columns:", res3.rows);

    await client.end();
}
run();

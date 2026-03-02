const { Client } = require('pg');

async function run() {
    const client = new Client({
        connectionString: (process.env.DATABASE_URL || '')
    });
    await client.connect();

    const res = await client.query(`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'clinic_users';
  `);
    console.log("clinic_users columns:", res.rows);

    const res2 = await client.query(`
    select * from agendamentos limit 1;
  `);
    console.log("sample agendamento:", res2.rows);

    await client.end();
}
run();

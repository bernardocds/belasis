const { Client } = require('pg');

async function run() {
    const client = new Client({
        connectionString: (process.env.DATABASE_URL || '')
    });
    await client.connect();

    const res1 = await client.query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public';
  `);
    console.log("Tables:", res1.rows.map(r => r.table_name));

    const res2 = await client.query(`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'clinicas';
  `);
    console.log("Clinicas columns:", res2.rows);

    const res3 = await client.query(`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'clinic_users';
  `);
    console.log("Clinic Users columns:", res3.rows);

    await client.end();
}
run();

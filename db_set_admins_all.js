const { Client } = require('pg');

async function run() {
    const client = new Client({
        connectionString: (process.env.DATABASE_URL || '')
    });
    await client.connect();

    await client.query(`
        INSERT INTO super_admins (user_id) 
        SELECT id FROM auth.users
        ON CONFLICT (user_id) DO NOTHING;
    `);

    console.log("Allowed multiple super admins");
    await client.end();
}
run();

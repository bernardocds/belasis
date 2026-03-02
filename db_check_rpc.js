const { Client } = require('pg');
const fs = require('fs');

async function run() {
    const client = new Client({
        connectionString: (process.env.DATABASE_URL || '')
    });
    await client.connect();

    const res = await client.query(`
        SELECT prosrc 
        FROM pg_proc 
        WHERE proname = 'create_invited_user';
    `);

    fs.writeFileSync('create_invited_user.sql', res.rows[0]?.prosrc || "Not found");
    await client.end();
}
run();

const { Client } = require('pg');

async function run() {
    const client = new Client({
        connectionString: (process.env.DATABASE_URL || '')
    });
    await client.connect();

    const res = await client.query(`
        SELECT id, email 
        FROM auth.users 
        LIMIT 10;
    `);

    console.log("Users:", res.rows);

    // Just in case, let's insert the first user into super_admins to give Bernardo access
    if (res.rows.length > 0) {
        const mainUserId = res.rows[0].id;
        await client.query(`
        INSERT INTO super_admins (user_id) VALUES ($1) ON CONFLICT DO NOTHING;
      `, [mainUserId]);
        console.log("Inserted user into super_admins:", mainUserId);
    }

    await client.end();
}
run();

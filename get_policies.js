const fs = require('fs');
const { Client } = require('pg');

const envFile = fs.readFileSync('.env.local', 'utf8');
let dbUrl = '';
for (const line of envFile.split('\n')) {
    if (line.startsWith('DATABASE_URL=')) {
        dbUrl = line.split('=')[1].replace(/["']/g, '').trim();
        break;
    }
}

async function main() {
    const client = new Client({
        connectionString: dbUrl,
        ssl: { rejectUnauthorized: false }
    });

    await client.connect();
    console.log("Connected to database...");

    const sql = `
SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check 
FROM pg_policies 
WHERE tablename IN ('clinic_users', 'clinics', 'clinic_invites', 'users', 'profiles');
   `;

    try {
        const res = await client.query(sql);
        console.table(res.rows);
    } catch (err) {
        console.error("Error executing SQL:", err);
    } finally {
        await client.end();
    }
}

main().catch(console.error);

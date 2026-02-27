const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_ANON_KEY || "";
const testEmail = process.env.TEST_EMAIL || "";
const testPassword = process.env.TEST_PASSWORD || "";

if (!supabaseUrl || !supabaseKey || !testEmail || !testPassword) {
    console.error("Missing SUPABASE_URL, SUPABASE_ANON_KEY, TEST_EMAIL or TEST_PASSWORD.");
    process.exit(1);
}

async function test() {
    console.log("Logging in...");
    const authRes = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: {
            'apikey': supabaseKey,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            email: testEmail,
            password: testPassword
        })
    });

    const authData = await authRes.json();
    if (!authRes.ok) {
        console.error("Login failed:", authData);
        return;
    }

    console.log("Logged in gracefully. Token:", authData.access_token.substring(0, 10) + "...");
    console.log("Invoking connect-whatsapp...");

    const response = await fetch(`${supabaseUrl}/functions/v1/connect-whatsapp`, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${authData.access_token}`
        }
    });

    console.log("RAW Status:", response.status);
    console.log("RAW Body:", await response.text());
}

test();

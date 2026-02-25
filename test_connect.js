const supabaseUrl = "https://fvxxlrzaqqewihuabcxu.supabase.co";
const supabaseKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ2eHhscnphcXFld2lodWFiY3h1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEzOTM1NDIsImV4cCI6MjA4Njk2OTU0Mn0.B053eTqCXAPJHr1P5THeOczBgIiU_21IIpS-T_qbPLY";

async function test() {
    console.log("Logging in...");
    const authRes = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: {
            'apikey': supabaseKey,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            email: "bellaassist-v3@mailinator.com",
            password: "SecurePassword123!"
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

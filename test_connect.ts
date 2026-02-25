import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Load credentials from .env file — never hardcode them here!
// Run with: deno run --allow-env --allow-net --env test_connect.ts
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const TEST_EMAIL = Deno.env.get("TEST_EMAIL") ?? "";
const TEST_PASSWORD = Deno.env.get("TEST_PASSWORD") ?? "";

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error("❌ Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env file");
    Deno.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function test() {
    console.log("🔑 Logging in...");
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
    });

    if (authError || !authData.session) {
        console.error("❌ Login failed:", authError?.message);
        return;
    }

    console.log("✅ Logged in successfully");
    console.log("📡 Invoking connect-whatsapp...");

    const response = await fetch(`${SUPABASE_URL}/functions/v1/connect-whatsapp`, {
        method: "GET",
        headers: {
            "Authorization": `Bearer ${authData.session.access_token}`,
            "Content-Type": "application/json",
        },
    });

    console.log("Status:", response.status);
    const body = await response.text();
    console.log("Body:", body);
}

test();

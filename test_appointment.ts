import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const url = Deno.env.get("SUPABASE_URL");
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!url || !key) {
    console.log("Variáveis de ambiente ausentes.");
    Deno.exit(1);
}

const supabase = createClient(url, key);

async function testHandoff() {
    console.log("Mocking database hook insert event...");

    // Mock payload exactly like Supabase DB Hook
    const payload = {
        type: "INSERT",
        record: {
            id: "mock-message-id-123",
            conversa_id: "e57eb481-42ab-4be7-ab8c-edb0e79603e8", // Sub by a valid ID in the DB
            role: "user",
            conteudo: "Olá, quero marcar um botox para amanhã às 14h. Meu nome é Bernardo!"
        }
    };

    try {
        const res = await fetch("http://localhost:54321/functions/v1/process-message", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
        });

        const data = await res.json();
        console.log("Function Response:", data);
    } catch (err) {
        console.error("Fetch Error:", err);
    }
}

testHandoff();

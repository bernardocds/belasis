import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

    try {
        const supabase = createClient(
            Deno.env.get("SUPABASE_URL")!,
            Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
        );

        const { audio_url, mensagem_id } = await req.json();
        if (!audio_url) {
            return new Response(JSON.stringify({ error: "audio_url required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        // Download audio
        const audioRes = await fetch(audio_url);
        if (!audioRes.ok) throw new Error(`Failed to fetch audio: ${audioRes.status}`);
        const audioBlob = await audioRes.blob();

        // Send to OpenAI Whisper
        const formData = new FormData();
        formData.append("file", audioBlob, "audio.ogg");
        formData.append("model", "whisper-1");
        formData.append("language", "pt");

        const whisperRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
            method: "POST",
            headers: { "Authorization": `Bearer ${Deno.env.get("OPENAI_API_KEY")}` },
            body: formData,
        });

        if (!whisperRes.ok) {
            const err = await whisperRes.text();
            throw new Error(`Whisper API error: ${err}`);
        }

        const { text } = await whisperRes.json();

        // Update mensagem with transcription if mensagem_id provided
        if (mensagem_id) {
            await supabase.from("mensagens").update({ transcricao: text }).eq("id", mensagem_id);
        }

        return new Response(JSON.stringify({ transcricao: text }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    } catch (err: any) {
        console.error("Transcription error:", err);
        return new Response(JSON.stringify({ error: err.message }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }
});

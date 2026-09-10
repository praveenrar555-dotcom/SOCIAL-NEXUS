// Supabase Edge Function: notify-emergency-facility
// Deploy with: supabase functions deploy notify-emergency-facility
// Then set two secrets (once):
//   supabase secrets set RESEND_API_KEY=your_resend_api_key
//   supabase secrets set SUPABASE_SERVICE_ROLE_KEY=your_service_role_key   (from Project Settings > API)
//
// Uses Resend (https://resend.com) for email — free tier gives 3000 emails/month,
// no card needed to start. Swap the fetch call below for any other email API if you prefer.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;

Deno.serve(async (req) => {
    try {
        const { alert_id } = await req.json();
        if (!alert_id) return new Response(JSON.stringify({ error: "alert_id missing" }), { status: 400 });

        const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

        const { data: alert, error: alertErr } = await supabase
            .from("emergency_alerts")
            .select("*")
            .eq("id", alert_id)
            .maybeSingle();
        if (alertErr || !alert) return new Response(JSON.stringify({ error: "alert not found" }), { status: 404 });

        const { data: facilities, error: facErr } = await supabase
            .rpc("nearest_emergency_facilities", { alert_lat: alert.lat, alert_lng: alert.lng });
        if (facErr) return new Response(JSON.stringify({ error: facErr.message }), { status: 500 });

        if (!facilities || facilities.length === 0) {
            // No facilities in the directory yet — nothing to email. Not an error, just nothing to do.
            return new Response(JSON.stringify({ status: "no_facilities_in_directory" }), { status: 200 });
        }

        const mapsLink = `https://www.google.com/maps?q=${alert.lat},${alert.lng}`;
        const subject = `EMERGENCY: Accident reported near your location`;
        const html = `
            <h2>Emergency Alert — Accident Reported</h2>
            <p><b>Victim (app username):</b> ${alert.victim_username}</p>
            <p><b>Location:</b> <a href="${mapsLink}">${alert.lat}, ${alert.lng}</a></p>
            <p><b>Blood group:</b> ${alert.medical_blood_group || "Not provided"}</p>
            <p><b>Allergies:</b> ${alert.medical_allergies || "Not provided"}</p>
            <p><b>Existing conditions:</b> ${alert.medical_conditions || "Not provided"}</p>
            <p><b>Emergency contact:</b> ${alert.emergency_contact_number || "Not provided"}</p>
            <p><b>Reported at:</b> ${alert.created_at}</p>
            <p style="color:#888;font-size:12px">This alert was generated automatically by the SocialNexus
            Emergency Alert feature. Please verify before dispatching.</p>
        `;

        const results = [];
        for (const facility of facilities) {
            const res = await fetch("https://api.resend.com/emails", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${RESEND_API_KEY}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    from: "SocialNexus Emergency Alert <alerts@yourdomain.example>",
                    to: [facility.contact_email],
                    subject,
                    html,
                }),
            });
            results.push({ facility: facility.name, ok: res.ok });
        }

        await supabase.from("emergency_alerts").update({ facility_notified: true }).eq("id", alert_id);

        return new Response(JSON.stringify({ status: "notified", results }), { status: 200 });
    } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
    }
});


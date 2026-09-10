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

// supabase/functions/send-push/index.ts
//
// Deploy: supabase functions deploy send-push --no-verify-jwt
// Secrets needed (set once):
//   supabase secrets set VAPID_PUBLIC_KEY=<...> VAPID_PRIVATE_KEY=<...> \
//     VAPID_SUBJECT=mailto:you@example.com \
//     WEBHOOK_SECRET=<any-random-string> \
//     SUPABASE_URL=<already-set-by-platform> SUPABASE_SERVICE_ROLE_KEY=<from dashboard>
//
// Then create TWO Database Webhooks in Supabase (Database → Webhooks):
//   1) table: messages,       event: INSERT, URL: this function's URL,
//      header: x-webhook-secret: <same WEBHOOK_SECRET>
//   2) table: group_messages, event: INSERT, URL: this function's URL,
//      header: x-webhook-secret: <same WEBHOOK_SECRET>

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@example.com";
const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET");

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

async function sendToUsername(username: string, payload: Record<string, unknown>) {
    const { data: subs, error } = await supabase
        .from("push_subscriptions")
        .select("*")
        .eq("username", username);

    if (error || !subs) return;

    for (const sub of subs) {
        const subscription = {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth }
        };
        try {
            await webpush.sendNotification(subscription, JSON.stringify(payload));
        } catch (err: unknown) {
            const statusCode = (err as { statusCode?: number })?.statusCode;
            // 404/410 = the browser/OS revoked this subscription (uninstalled, expired, etc).
            // Clean it up so we stop trying to push to a dead endpoint.
            if (statusCode === 404 || statusCode === 410) {
                await supabase.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
            } else {
                console.error("web-push send failed:", err);
            }
        }
    }
}

Deno.serve(async (req: Request) => {
    if (WEBHOOK_SECRET) {
        const provided = req.headers.get("x-webhook-secret");
        if (provided !== WEBHOOK_SECRET) {
            return new Response("Forbidden", { status: 403 });
        }
    }

    let body: any;
    try {
        body = await req.json();
    } catch {
        return new Response("Bad Request", { status: 400 });
    }

    const table = body.table;
    const record = body.record;
    if (!record) return new Response("ok", { status: 200 });

    try {
        if (table === "messages") {
            // record: { sender, receiver, text, ... }
            if (record.sender && record.receiver && record.sender !== record.receiver) {
                await sendToUsername(record.receiver, {
                    title: `New message from ${record.sender}`,
                    body: record.text || "Sent an attachment",
                    tag: "dm_" + record.sender,
                    url: "/?chat=" + encodeURIComponent(record.sender)
                });
            }
        } else if (table === "group_messages") {
            // record: { sender, group_id, text, ... }
            const { data: members } = await supabase
                .from("group_members")
                .select("username")
                .eq("group_id", record.group_id);

            const { data: group } = await supabase
                .from("groups")
                .select("name")
                .eq("id", record.group_id)
                .maybeSingle();

            const groupName = group?.name || "Group";

            for (const m of members || []) {
                if (m.username === record.sender) continue;
                await sendToUsername(m.username, {
                    title: `${groupName}: ${record.sender}`,
                    body: record.text || "Sent an attachment",
                    tag: "group_" + record.group_id,
                    url: "/?group=" + record.group_id
                });
            }
        }
    } catch (err) {
        console.error("send-push handler error:", err);
    }

    return new Response("ok", { status: 200 });
});

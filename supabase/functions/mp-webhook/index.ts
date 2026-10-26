import { createClient } from "npm:@supabase/supabase-js@2";

// Webhook público do Mercado Pago. Nunca confia no corpo recebido: busca a assinatura
// diretamente na API do Mercado Pago com o nosso token e só então atualiza o acesso.
Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    let id = url.searchParams.get("data.id") ?? url.searchParams.get("id");
    let type = url.searchParams.get("type") ?? url.searchParams.get("topic");
    if (req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      id = b?.data?.id ?? id;
      type = b?.type ?? type;
    }
    if (!id || !String(type ?? "").includes("preapproval")) return new Response("ignored", { status: 200 });

    const mpToken = Deno.env.get("MP_ACCESS_TOKEN");
    if (!mpToken) return new Response("not configured", { status: 503 });
    const r = await fetch(`https://api.mercadopago.com/preapproval/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${mpToken}` } });
    if (!r.ok) return new Response("lookup failed", { status: 502 });
    const p = await r.json();
    const uid = p.external_reference;
    if (!uid) return new Response("no ref", { status: 200 });

    const status = p.status === "authorized" ? "active" : p.status === "paused" ? "paused" : p.status === "cancelled" ? "cancelled" : "pending";
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    // confere que a assinatura pertence ao usuário que a criou
    const { data: cur } = await admin.from("pa_subscriptions").select("mp_preapproval_id,plan").eq("user_id", uid).maybeSingle();
    if (cur?.mp_preapproval_id && cur.mp_preapproval_id !== p.id) return new Response("mismatch", { status: 200 });
    const months = p.auto_recurring?.frequency === 12 ? "annual" : "monthly";
    await admin.from("pa_subscriptions").upsert({
      user_id: uid, plan: cur?.plan ?? months, status, mp_preapproval_id: p.id,
      next_payment_date: p.next_payment_date ?? null, updated_at: new Date().toISOString(),
    });
    return new Response("ok", { status: 200 });
  } catch (_e) {
    return new Response("error", { status: 500 });
  }
});

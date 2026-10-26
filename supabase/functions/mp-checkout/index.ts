import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Cria uma assinatura recorrente (preapproval) no Mercado Pago e devolve o link de pagamento.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const { data: u } = await admin.auth.getUser(token);
    if (!u?.user) return json({ error: "Não autenticado." }, 401);
    const { plan } = await req.json();
    if (plan !== "monthly" && plan !== "annual") return json({ error: "Plano inválido." }, 400);

    const mpToken = Deno.env.get("MP_ACCESS_TOKEN");
    if (!mpToken) return json({ error: "Pagamento ainda não configurado (MP_ACCESS_TOKEN)." }, 503);
    const price = plan === "monthly" ? Number(Deno.env.get("PRICE_MONTHLY") ?? "19.90") : Number(Deno.env.get("PRICE_ANNUAL") ?? "199.00");
    const appUrl = Deno.env.get("APP_URL") ?? "";

    const r = await fetch("https://api.mercadopago.com/preapproval", {
      method: "POST",
      headers: { Authorization: `Bearer ${mpToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        reason: plan === "monthly" ? "PlanoAula – assinatura mensal" : "PlanoAula – assinatura anual",
        external_reference: u.user.id,
        payer_email: u.user.email,
        back_url: appUrl ? `${appUrl}/?pagamento=retorno` : undefined,
        status: "pending",
        auto_recurring: { frequency: plan === "monthly" ? 1 : 12, frequency_type: "months", transaction_amount: price, currency_id: "BRL" },
      }),
    });
    const d = await r.json();
    if (!r.ok || !d.init_point) return json({ error: "Não foi possível iniciar o pagamento." }, 502);

    await admin.from("pa_subscriptions").upsert({ user_id: u.user.id, plan, status: "pending", mp_preapproval_id: d.id, updated_at: new Date().toISOString() });
    return json({ url: d.init_point });
  } catch (_e) {
    return json({ error: "Erro interno." }, 500);
  }
});

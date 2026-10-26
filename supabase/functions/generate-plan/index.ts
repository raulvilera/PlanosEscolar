import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const SYSTEM = `Você é um assistente que elabora planos de aula para professores da rede pública de São Paulo (SEDUC-SP), com foco em SARESP/Prova Paulista.
Regras:
- Use SOMENTE o conteúdo dos GUIAS fornecidos para aprendizagem essencial (AE), habilidades, conhecimentos prévios e sequência de aulas (Escopo-Sequência). Siga a sequência a partir da Aula 1 do bimestre, salvo se o professor indicar outra.
- NÃO invente habilidades, códigos ou aulas que não estejam nos guias. O que não constar deve ser escrito como "A confirmar" e listado em "avisos".
- Se não houver guia, gere um plano provisório, marque AE/habilidade como "A confirmar" e avise.
- Respeite a ESTRUTURA DO MODELO do professor (campos, ordem e nomes de seções). Se o modelo estiver vazio, use: Objetivo(s); Aprendizagens essenciais; Habilidade priorizada; Conhecimentos prévios; Recursos didáticos; Metodologia (um bloco por aula com 3 passos numerados, o último com "(momento de avaliação)"; "Recomposição" só na 1ª aula); Avaliação; Observação.
- Use as datas e aulas informadas (dia da semana, nº da aula). Nunca invente datas.
- Linguagem objetiva, em português do Brasil.
Responda APENAS com JSON válido, sem texto fora do JSON, neste formato:
{"cabecalho":[{"rotulo":"Professor(a)","valor":"..."}],
 "secoes":[{"titulo":"...","texto":"... (opcional)","blocos":[{"titulo":"... (opcional)","texto":"... (opcional)","itens":["..."]}]}],
 "avisos":["pontos a confirmar"]}`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const { data: u } = await admin.auth.getUser(token);
    if (!u?.user) return json({ error: "Não autenticado." }, 401);
    const uid = u.user.id;

    // paywall: teste de 7 dias ou assinatura ativa
    const { data: acc } = await admin.rpc("pa_access_for", { uid });
    if (!acc || acc.state === "expired") return json({ error: "Seu teste terminou. Assine para continuar.", code: "payment_required" }, 402);

    // limite diário (protege o custo de IA)
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { count } = await admin.from("pa_plans").select("id", { count: "exact", head: true }).eq("user_id", uid).gte("created_at", since);
    const limit = Number(Deno.env.get("DAILY_LIMIT") ?? "40");
    if ((count ?? 0) >= limit) return json({ error: `Limite diário de ${limit} planos atingido.` }, 429);

    const b = await req.json();
    const { componente, serie, bimestre, modelo, aulas, periodo, professor, turma, observacoes } = b;
    if (!componente || !serie || !periodo) return json({ error: "Informe componente, série e período." }, 400);

    let q = admin.from("pa_guides").select("title,content").ilike("component", `%${String(componente).trim()}%`).ilike("serie", `%${String(serie).trim()}%`);
    if (bimestre) q = q.eq("bimestre", Number(bimestre));
    const { data: guides } = await q.limit(6);
    let guideText = (guides ?? []).map((g) => `### ${g.title}\n${g.content}`).join("\n\n");
    guideText = guideText.slice(0, 90000);

    const userMsg = `DADOS DO PEDIDO
Professor(a): ${professor ?? ""}
Componente: ${componente}
Ano/Série/Turma: ${serie}${turma ? " – " + turma : ""}
Bimestre: ${bimestre ?? ""}
Período: ${periodo}
Aulas (dias/horários informados): ${aulas ?? ""}
Observações do professor: ${observacoes ?? ""}

MODELO DE PLANO DO PROFESSOR (estrutura a seguir):
${(modelo ?? "").toString().slice(0, 8000) || "(vazio – usar a estrutura padrão)"}

GUIAS PRIORIZADOS (única fonte para AE/habilidades/sequência):
${guideText || "(nenhum guia encontrado para este componente/série/bimestre)"}`;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: Deno.env.get("AI_MODEL") ?? "claude-sonnet-5-5", max_tokens: 6000, system: SYSTEM, messages: [{ role: "user", content: userMsg }] }),
    });
    if (!r.ok) return json({ error: "Falha ao gerar o plano. Tente novamente." }, 502);
    const out = await r.json();
    const text: string = out.content?.map((c: { text?: string }) => c.text ?? "").join("") ?? "";
    const s = text.indexOf("{"), e = text.lastIndexOf("}");
    let plan;
    try { plan = JSON.parse(text.slice(s, e + 1)); } catch { return json({ error: "Resposta inválida da IA. Tente novamente." }, 502); }
    if (!guides?.length) plan.avisos = [...(plan.avisos ?? []), "Nenhum guia encontrado: plano provisório, confira AE e habilidades."];

    const title = `${componente} – ${serie}${turma ? " " + turma : ""} (${periodo})`;
    const { data: saved } = await admin.from("pa_plans").insert({ user_id: uid, title, params: { componente, serie, turma, bimestre, periodo, aulas }, content: plan }).select("id").single();
    return json({ id: saved?.id, title, plan });
  } catch (_e) {
    return json({ error: "Erro interno." }, 500);
  }
});

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// ---------- Agente 2 (planejador, em código): datas reais das aulas ----------
const DOW = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
type Dia = { dow: number; aula: number };
function buildDates(inicio: string, fim: string, dias: Dia[], semAula: string[]) {
  const out: { iso: string; label: string }[] = [];
  const skip = new Set(semAula ?? []);
  const d = new Date(inicio + "T12:00:00Z"), end = new Date(fim + "T12:00:00Z");
  for (let n = 0; d <= end && n < 400; n++, d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    if (skip.has(iso)) continue;
    const todays = dias.filter((x) => Number(x.dow) === d.getUTCDay()).sort((a, b) => a.aula - b.aula);
    for (const x of todays) out.push({ iso, label: `${iso.slice(8, 10)}/${iso.slice(5, 7)} (${DOW[d.getUTCDay()]}) – ${x.aula}ª aula` });
  }
  return out;
}

// ---------- chamada à IA ----------
async function ai(model: string, system: string, user: string, maxTokens: number) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
  });
  if (!r.ok) throw new Error("ai_" + r.status);
  const o = await r.json();
  return (o.content?.map((c: { text?: string }) => c.text ?? "").join("") ?? "") as string;
}
function parseJson(t: string) {
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  return JSON.parse(t.slice(s, e + 1));
}

// ---------- Agente 1 (leitor do Guia) ----------
const READER_SYS = `Você lê Guias Priorizados da SEDUC-SP e extrai dados estruturados. Use SOMENTE o que está no texto; não invente códigos nem aulas. Responda APENAS com JSON:
{"habilidade_priorizada":"...","ae":["aprendizagens essenciais"],"conhecimentos_previos":"...","escopo_sequencia":[{"n":1,"titulo":"...","habilidades":["códigos"],"descricao":"..."}],"aula_verificacao":"..."}
"escopo_sequencia" = as aulas do bimestre na ordem do guia (Escopo-Sequência). Campo ausente = "" ou [].`;
async function readGuide(admin: ReturnType<typeof createClient>, g: { id: number; content: string; summary: unknown }) {
  if (g.summary) return g.summary;
  try {
    const t = await ai(Deno.env.get("AI_MODEL_READER") ?? "claude-haiku-5-5", READER_SYS, g.content.slice(0, 120000), 6000);
    const sum = parseJson(t);
    await admin.from("pa_guides").update({ summary: sum }).eq("id", g.id);
    return sum;
  } catch { return null; }
}

// ---------- Agente 3 (redator do modelo) ----------
const WRITER_SYS = `Você elabora planos de aula para professores da rede pública de São Paulo (SEDUC-SP), com foco em SARESP/Prova Paulista, PREENCHENDO o modelo do professor.
Regras:
- Use SOMENTE os GUIAS (resumo e texto) para aprendizagem essencial, habilidades, conhecimentos prévios e sequência. NÃO invente habilidades, códigos ou aulas. O que faltar: "A confirmar" e liste em "avisos".
- Siga a SEQUÊNCIA PREVISTA fornecida (continuação do último plano). Uma aula do plano para cada data fornecida, na ordem. Não repita temas já trabalhados.
- Respeite a ESTRUTURA DO MODELO (campos, ordem, nomes). Se o modelo estiver vazio, use: Objetivo(s); Aprendizagens essenciais; Habilidade priorizada; Conhecimentos prévios; Recursos didáticos; Metodologia (um bloco por aula com 3 passos numerados, o último com "(momento de avaliação)"; "Recomposição" só na 1ª aula do 1º plano do bimestre); Avaliação; Observação.
- Use exatamente as datas/aulas fornecidas. Nunca invente datas.
- Português do Brasil, objetivo.
Responda APENAS com JSON:
{"cabecalho":[{"rotulo":"Professor(a)","valor":"..."}],
 "secoes":[{"titulo":"...","texto":"(opcional)","blocos":[{"titulo":"(opcional)","texto":"(opcional)","itens":["..."]}]}],
 "avisos":["pontos a confirmar"],
 "progresso":{"ultima_aula_guia":N,"temas_trabalhados":["tema de cada aula deste plano"]}}
"ultima_aula_guia" = número (n) da última aula do Escopo-Sequência do guia que este plano cobre (0 se não houver sequência).`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const b = await req.json();

    // quem chama: usuário (JWT) ou rotina automática (segredo interno)
    let uid: string | undefined;
    const internal = req.headers.get("x-internal-secret");
    if (internal && internal === Deno.env.get("CRON_SECRET") && b.user_id) uid = b.user_id;
    else {
      const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
      const { data: u } = await admin.auth.getUser(token);
      uid = u?.user?.id;
    }
    if (!uid) return json({ error: "Não autenticado." }, 401);

    const { data: acc } = await admin.rpc("pa_access_for", { uid });
    if (!acc || acc.state === "expired") return json({ error: "Seu teste terminou. Assine para continuar.", code: "payment_required" }, 402);

    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { count } = await admin.from("pa_plans").select("id", { count: "exact", head: true }).eq("user_id", uid).gte("created_at", since);
    const limit = Number(Deno.env.get("DAILY_LIMIT") ?? "40");
    if ((count ?? 0) >= limit) return json({ error: `Limite diário de ${limit} planos atingido.` }, 429);

    const { componente, serie, turma, bimestre, modelo, professor, observacoes, inicio, fim, dias, sem_aula } = b;
    if (!componente || !serie || !inicio || !fim || !Array.isArray(dias) || !dias.length) return json({ error: "Informe componente, série, período e os dias/aulas." }, 400);

    // Agente 2: datas reais
    const datas = buildDates(inicio, fim, dias, sem_aula ?? []);
    if (!datas.length) return json({ error: "Nenhuma aula cai nesse período com os dias informados." }, 400);
    const periodo = `${inicio.slice(8, 10)}/${inicio.slice(5, 7)} a ${fim.slice(8, 10)}/${fim.slice(5, 7)}`;

    // Memória: último plano da mesma disciplina/turma/bimestre
    let prevQ = admin.from("pa_plans").select("progress,periodo_fim,title").eq("user_id", uid).ilike("componente", String(componente).trim()).ilike("serie", String(serie).trim()).not("progress", "is", null).order("created_at", { ascending: false }).limit(1);
    prevQ = turma ? prevQ.ilike("turma", String(turma).trim()) : prevQ.is("turma", null);
    if (bimestre) prevQ = prevQ.eq("bimestre", Number(bimestre));
    const { data: prevRows } = await prevQ;
    const prev = prevRows?.[0]?.progress as { ultima_aula_guia?: number; temas_trabalhados?: string[] } | undefined;
    const startN = (prev?.ultima_aula_guia ?? 0) + 1;

    // Agente 1: guias
    let gq = admin.from("pa_guides").select("id,title,content,summary").ilike("component", `%${String(componente).trim()}%`).ilike("serie", `%${String(serie).trim()}%`);
    if (bimestre) gq = gq.or(`bimestre.eq.${Number(bimestre)},bimestre.is.null`);
    const { data: guides } = await gq.limit(4);
    const sums: unknown[] = [];
    for (const g of guides ?? []) { const s = await readGuide(admin, g as never); if (s) sums.push(s); }
    const guideText = (guides ?? []).map((g) => `### ${g.title}\n${g.content}`).join("\n\n").slice(0, 80000);

    // Agente 2: sequência prevista = continuação do guia
    const seq: { n: number }[] = ((sums[0] as { escopo_sequencia?: { n: number }[] } | undefined)?.escopo_sequencia) ?? [];
    const previstas = seq.filter((x) => Number(x.n) >= startN).slice(0, datas.length);
    const avisosPre: string[] = [];
    if (seq.length && previstas.length < datas.length) avisosPre.push(`A sequência do guia tem só ${previstas.length} aula(s) restante(s) para ${datas.length} data(s): complete com revisão/verificação.`);

    const userMsg = `DADOS
Professor(a): ${professor ?? ""}
Componente: ${componente}
Ano/Série/Turma: ${serie}${turma ? " – " + turma : ""}
Bimestre: ${bimestre ?? ""}
Período: ${periodo}
Observações: ${observacoes ?? ""}

DATAS/AULAS DESTE PLANO (uma aula do plano por item, na ordem):
${datas.map((d, i) => `${i + 1}. ${d.label}`).join("\n")}

MEMÓRIA – JÁ TRABALHADO NOS PLANOS ANTERIORES (não repetir):
${prev?.temas_trabalhados?.length ? prev.temas_trabalhados.join("; ") : "(nenhum plano anterior: começar na Aula 1 do bimestre)"}
Próxima aula do guia a cobrir: ${startN}

SEQUÊNCIA PREVISTA DO GUIA PARA ESTE PLANO:
${previstas.length ? JSON.stringify(previstas) : "(não identificada: usar o texto do guia)"}

RESUMO ESTRUTURADO DO GUIA (agente leitor):
${sums.length ? JSON.stringify(sums).slice(0, 30000) : "(indisponível)"}

MODELO DO PROFESSOR (estrutura a preencher):
${(modelo ?? "").toString().slice(0, 8000) || "(vazio – usar a estrutura padrão)"}

TEXTO DOS GUIAS (fonte única):
${guideText || "(nenhum guia encontrado para este componente/série/bimestre)"}`;

    let plan;
    for (let tentativa = 0; tentativa < 2 && !plan; tentativa++) {
      try { plan = parseJson(await ai(Deno.env.get("AI_MODEL") ?? "claude-sonnet-5-5", WRITER_SYS, userMsg, 7000)); } catch { /* tenta de novo */ }
    }
    if (!plan) return json({ error: "Não foi possível gerar o plano agora. Tente novamente." }, 502);
    plan.avisos = [...(plan.avisos ?? []), ...avisosPre];

    // Agente 4 (verificador, em código): códigos de habilidade e datas
    const gtxt = (guideText + JSON.stringify(sums)).toUpperCase();
    const codes = new Set((JSON.stringify(plan).toUpperCase().match(/\b[A-Z]{2}\d{2}[A-Z]{1,4}\d{2,3}\b/g) ?? []));
    const unknown = [...codes].filter((c) => !gtxt.includes(c));
    if (unknown.length) plan.avisos.push(`Código(s) de habilidade que não constam no guia lido: ${unknown.join(", ")}. Confirme antes de usar.`);
    const planTxt = JSON.stringify(plan);
    const faltam = datas.filter((d) => !planTxt.includes(d.label.slice(0, 5)));
    if (faltam.length) plan.avisos.push(`Confira as datas: ${faltam.map((d) => d.label).join("; ")}.`);
    if (!guides?.length) plan.avisos.push("Nenhum guia encontrado: plano provisório, confira AE e habilidades.");
    if (!plan.progresso) plan.progresso = { ultima_aula_guia: startN - 1 + previstas.length, temas_trabalhados: [] };

    const title = `${componente} – ${serie}${turma ? " " + turma : ""} (${periodo})`;
    const { data: saved } = await admin.from("pa_plans").insert({
      user_id: uid, title, content: plan, componente: String(componente).trim(), serie: String(serie).trim(), turma: turma ? String(turma).trim() : null,
      bimestre: bimestre ? Number(bimestre) : null, periodo_inicio: inicio, periodo_fim: fim, progress: plan.progresso,
      params: { dias, sem_aula: sem_aula ?? [] }, routine_id: b.routine_id ?? null, auto: !!b.auto, seen: !b.auto,
    }).select("id").single();
    return json({ id: saved?.id, title, plan, continuacao: startN > 1 ? `Continuação a partir da aula ${startN} do guia.` : "" });
  } catch (_e) {
    return json({ error: "Erro interno." }, 500);
  }
});

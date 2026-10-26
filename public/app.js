(() => {
const C = window.PA_CONFIG;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const lsGet = (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));

const configured = C && !String(C.SUPABASE_URL).startsWith("COLE");
const sb = configured ? supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY) : null;
let access = null, profile = null, signup = true, lastPlan = null;

function show(id) { for (const x of ["boot", "auth", "paywall", "app"]) $(x).hidden = x !== id; }
function msg(el, text, kind) { el.textContent = text || ""; el.className = "msg" + (kind ? " " + kind : ""); }

async function start() {
  if (!sb) { show("boot"); $("boot").innerHTML = "<p>Configure o <code>config.js</code> com a URL e a chave do Supabase.</p>"; return; }
  const { data } = await sb.auth.getSession();
  data.session ? await enter() : show("auth");
  sb.auth.onAuthStateChange((ev) => { if (ev === "SIGNED_OUT") show("auth"); });
}

async function enter() {
  const [{ data: acc }, { data: pf }] = await Promise.all([sb.rpc("pa_access"), sb.from("pa_profiles").select("*").maybeSingle()]);
  access = acc || { state: "expired" }; profile = pf || {};
  $("pm").textContent = C.PRICE_MONTHLY; $("pa").textContent = C.PRICE_ANNUAL;
  if (access.state === "expired") { show("paywall"); return; }
  show("app");
  $("adminTab").hidden = !profile.is_admin;
  const b = $("banner"); b.hidden = false;
  if (access.state === "trial") { b.className = "banner"; b.textContent = `Teste grátis: ${access.days_left} dia(s) restante(s). Depois, assine o plano mensal ou anual para continuar.`; }
  else { b.className = "banner ok"; b.textContent = `Assinatura ${access.plan === "annual" ? "anual" : "mensal"} ativa.`; }
  $("m_text").value = profile.model_text || ""; $("m_head").value = lsGet("pa_head");
  $("g_prof").value = lsGet("pa_prof") || profile.full_name || "";
}

// ---------- autenticação
$("toggleAuth").onclick = (e) => { e.preventDefault(); signup = !signup; $("nameRow").hidden = !signup; $("authBtn").textContent = signup ? "Começar teste grátis" : "Entrar"; $("toggleAuth").textContent = signup ? "Já tenho conta – entrar" : "Criar conta (teste grátis)"; $("password").autocomplete = signup ? "new-password" : "current-password"; msg($("authMsg"), ""); };
$("authForm").onsubmit = async (e) => {
  e.preventDefault(); const em = $("email").value.trim(), pw = $("password").value; msg($("authMsg"), "Aguarde…");
  const r = signup ? await sb.auth.signUp({ email: em, password: pw, options: { data: { full_name: $("fullName").value.trim() } } }) : await sb.auth.signInWithPassword({ email: em, password: pw });
  if (r.error) return msg($("authMsg"), r.error.message.includes("Invalid login") ? "E-mail ou senha incorretos." : r.error.message, "err");
  if (!r.data.session) return msg($("authMsg"), "Conta criada! Confirme o e-mail que enviamos e entre em seguida.", "ok");
  msg($("authMsg"), ""); await enter();
};
const out = async () => { await sb.auth.signOut(); show("auth"); };
$("logout1").onclick = out; $("logout2").onclick = out;

// ---------- abas
$("tabs").onclick = async (e) => {
  const t = e.target.dataset?.tab; if (!t) return;
  for (const b of $("tabs").children) b.classList.toggle("on", b.dataset.tab === t);
  for (const x of ["gerar", "meus", "modelo", "admin"]) $("tab-" + x).hidden = x !== t;
  $("result").hidden = true;
  if (t === "meus") loadPlans(); if (t === "admin") loadGuides();
};

// ---------- pagamento
$("paywall").onclick = async (e) => {
  const plan = e.target.dataset?.plan; if (!plan) return;
  msg($("payMsg"), "Abrindo o Mercado Pago…");
  const { data, error } = await sb.functions.invoke("mp-checkout", { body: { plan } });
  if (error || !data?.url) return msg($("payMsg"), data?.error || "Não foi possível iniciar o pagamento agora.", "err");
  location.href = data.url;
};

// ---------- extração de texto de arquivos
async function fileToText(f) {
  const n = f.name.toLowerCase();
  if (n.endsWith(".txt") || n.endsWith(".md")) return await f.text();
  if (n.endsWith(".docx")) { const r = await mammoth.extractRawText({ arrayBuffer: await f.arrayBuffer() }); return r.value; }
  if (n.endsWith(".pdf")) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    const pdf = await pdfjsLib.getDocument({ data: await f.arrayBuffer() }).promise; let t = "";
    for (let i = 1; i <= pdf.numPages; i++) { const c = await (await pdf.getPage(i)).getTextContent(); t += c.items.map((x) => x.str).join(" ") + "\n"; }
    return t;
  }
  throw new Error("Formato não suportado.");
}

// ---------- modelo
$("m_file").onchange = async (e) => { const f = e.target.files[0]; if (!f) return; try { $("m_text").value = (await fileToText(f)).slice(0, 8000); msg($("m_msg"), "Arquivo lido. Revise e salve.", "ok"); } catch (x) { msg($("m_msg"), x.message, "err"); } };
$("m_save").onclick = async () => {
  lsSet("pa_head", $("m_head").value);
  const { error } = await sb.from("pa_profiles").update({ model_text: $("m_text").value }).eq("id", (await sb.auth.getUser()).data.user.id);
  profile.model_text = $("m_text").value; msg($("m_msg"), error ? "Não foi possível salvar." : "Modelo salvo.", error ? "err" : "ok");
};

// ---------- gerar plano
$("genForm").onsubmit = async (e) => {
  e.preventDefault(); $("genBtn").disabled = true; msg($("genMsg"), "Gerando… pode levar até 1 minuto.");
  lsSet("pa_prof", $("g_prof").value);
  const body = { professor: $("g_prof").value, componente: $("g_comp").value, serie: $("g_serie").value, turma: $("g_turma").value, bimestre: $("g_bim").value, periodo: $("g_per").value, aulas: $("g_aulas").value, observacoes: $("g_obs").value, modelo: profile.model_text || "" };
  const { data, error } = await sb.functions.invoke("generate-plan", { body });
  $("genBtn").disabled = false;
  if (error) {
    let d = null; try { d = await error.context.json(); } catch {}
    if (d?.code === "payment_required") { await enter(); return; }
    return msg($("genMsg"), d?.error || "Não foi possível gerar o plano.", "err");
  }
  msg($("genMsg"), "Plano pronto.", "ok"); showPlan(data.title, data.plan);
};

function showPlan(title, p) {
  lastPlan = p; $("r_title").textContent = title; $("result").hidden = false;
  const head = lsGet("pa_head").split("\n").filter(Boolean).map((l) => `<div class="inst">${esc(l)}</div>`).join("");
  const cab = (p.cabecalho || []).map((c) => `<tr><td><b>${esc(c.rotulo)}:</b> ${esc(c.valor)}</td></tr>`).join("");
  const sec = (p.secoes || []).map((s) => `<div class="sec"><b>${esc(s.titulo)}</b>` +
    (s.texto ? `<div class="bl">${esc(s.texto)}</div>` : "") +
    (s.blocos || []).map((b) => `<div class="bl">${b.titulo ? `<b>${esc(b.titulo)}</b><br>` : ""}${b.texto ? esc(b.texto) : ""}${b.itens?.length ? `<ol>${b.itens.map((i) => `<li>${esc(i)}</li>`).join("")}</ol>` : ""}</div>`).join("") + `</div>`).join("");
  const av = (p.avisos || []).length ? `<div class="warn noprint"><b>Pontos a confirmar:</b><ul>${p.avisos.map((a) => `<li>${esc(a)}</li>`).join("")}</ul></div>` : "";
  $("planDoc").innerHTML = `${head}<h3>PLANO DE AULA</h3><table>${cab}</table>${sec}${av}`;
  $("result").scrollIntoView({ behavior: "smooth" });
}
$("r_print").onclick = () => print();
$("r_close").onclick = () => { $("result").hidden = true; };
$("r_copy").onclick = async () => { try { await navigator.clipboard.writeText($("planDoc").innerText); $("r_copy").textContent = "Copiado!"; setTimeout(() => $("r_copy").textContent = "Copiar texto", 1500); } catch {} };

// ---------- meus planos
async function loadPlans() {
  const { data } = await sb.from("pa_plans").select("id,title,created_at,content").order("created_at", { ascending: false }).limit(100);
  const L = $("list"); L.innerHTML = data?.length ? "" : '<p class="muted">Nenhum plano ainda.</p>';
  for (const r of data || []) {
    const d = document.createElement("div"); d.className = "item";
    d.innerHTML = `<span><b>${esc(r.title)}</b><br><small class="muted">${new Date(r.created_at).toLocaleString("pt-BR")}</small></span><span><button class="btn ghost" data-o="1">Abrir</button> <button class="link" data-d="1">Excluir</button></span>`;
    d.querySelector("[data-o]").onclick = () => showPlan(r.title, r.content);
    d.querySelector("[data-d]").onclick = async () => { if (confirm("Excluir este plano?")) { await sb.from("pa_plans").delete().eq("id", r.id); loadPlans(); } };
    L.appendChild(d);
  }
}

// ---------- guias (admin)
async function loadGuides() {
  const { data } = await sb.from("pa_guides").select("id,component,serie,bimestre,title").order("id", { ascending: false });
  const L = $("a_list"); L.innerHTML = "";
  for (const g of data || []) {
    const d = document.createElement("div"); d.className = "item";
    d.innerHTML = `<span><b>${esc(g.component)}</b> · ${esc(g.serie)} · ${g.bimestre ? g.bimestre + "º bim." : "todos"}<br><small class="muted">${esc(g.title)}</small></span><button class="link">Excluir</button>`;
    d.querySelector("button").onclick = async () => { if (confirm("Excluir este guia?")) { await sb.from("pa_guides").delete().eq("id", g.id); loadGuides(); } };
    L.appendChild(d);
  }
}
$("a_add").onclick = async () => {
  const f = $("a_file").files[0], comp = $("a_comp").value.trim(), serie = $("a_serie").value.trim();
  if (!f || !comp || !serie) return msg($("a_msg"), "Informe componente, série e arquivo.", "err");
  msg($("a_msg"), "Lendo o arquivo…");
  try {
    const text = (await fileToText(f)).replace(/\s+\n/g, "\n");
    const { error } = await sb.from("pa_guides").insert({ component: comp, serie, bimestre: $("a_bim").value ? Number($("a_bim").value) : null, title: f.name, content: text });
    if (error) throw error; msg($("a_msg"), `Guia adicionado (${text.length.toLocaleString("pt-BR")} caracteres).`, "ok"); $("a_file").value = ""; loadGuides();
  } catch (x) { msg($("a_msg"), "Não foi possível adicionar o guia.", "err"); }
};

start();
})();

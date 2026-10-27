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
  $("g_prof").value = lsGet("pa_prof") || profile.full_name || ""; loadForm(); refreshBadge();
}

// ---------- autenticação
$("toggleAuth").onclick = (e) => { e.preventDefault(); signup = !signup; $("nameRow").hidden = !signup; $("authBtn").textContent = signup ? "Começar teste grátis" : "Entrar"; $("toggleAuth").textContent = signup ? "Já tenho conta – entrar" : "Criar conta (teste grátis)"; $("password").autocomplete = signup ? "new-password" : "current-password"; msg($("authMsg"), ""); };
$("authForm").onsubmit = async (e) => {
  e.preventDefault(); const em = $("email").value.trim(), pw = $("password").value; msg($("authMsg"), "Aguarde…");
  const r = signup ? await sb.auth.signUp({ email: em, password: pw, options: { emailRedirectTo: location.origin, data: { full_name: $("fullName").value.trim() } } }) : await sb.auth.signInWithPassword({ email: em, password: pw });
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
  for (const x of ["gerar", "meus", "rotinas", "modelo", "admin"]) $("tab-" + x).hidden = x !== t;
  $("result").hidden = true;
  if (t === "meus") loadPlans(); if (t === "rotinas") loadRoutines(); if (t === "admin") loadGuides();
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

// ---------- gerar plano (agentes no servidor) ----------
const DOWN = ["", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
function addDiaRow(dow = 1, aula = 1) {
  const r = document.createElement("div"); r.className = "diaRow";
  r.innerHTML = `<select class="d_dow">${DOWN.map((n, i) => i ? `<option value="${i}" ${i === dow ? "selected" : ""}>${n}</option>` : "").join("")}</select>
    <select class="d_aula">${[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `<option value="${n}" ${n === aula ? "selected" : ""}>${n}ª aula</option>`).join("")}</select>
    <button type="button" class="link">remover</button>`;
  r.querySelector("button").onclick = () => { if ($("g_dias").children.length > 1) r.remove(); };
  $("g_dias").appendChild(r);
}
$("g_addDia").onclick = () => addDiaRow();
function readDias() { return [...$("g_dias").children].map((r) => ({ dow: Number(r.querySelector(".d_dow").value), aula: Number(r.querySelector(".d_aula").value) })); }
function parseSem(txt, ini) {
  const y = ini.slice(0, 4);
  return txt.split(/[,;\s]+/).map((t) => t.trim()).filter(Boolean).map((t) => { const m = t.match(/^(\d{1,2})\/(\d{1,2})$/); return m ? `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : null; }).filter(Boolean);
}
function addDays(iso, n) { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function nextPeriod(per, fim) {
  const start = addDays(fim, 1);
  if (per === "semanal") return { start, end: addDays(start, 6) };
  if (per === "quinzenal") return { start, end: addDays(start, 13) };
  const d = new Date(start + "T12:00:00Z"); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(d.getUTCDate() - 1);
  return { start, end: d.toISOString().slice(0, 10) };
}
// memória do formulário (o professor não precisa preencher tudo de novo)
function saveForm() { lsSet("pa_form", JSON.stringify({ comp: $("g_comp").value, serie: $("g_serie").value, turma: $("g_turma").value, bim: $("g_bim").value, per: $("g_per").value, dias: readDias() })); }
function loadForm() {
  let f = {}; try { f = JSON.parse(lsGet("pa_form") || "{}"); } catch {}
  $("g_comp").value = f.comp || ""; $("g_serie").value = f.serie || ""; $("g_turma").value = f.turma || ""; if (f.bim) $("g_bim").value = f.bim; $("g_per").value = f.per || "";
  $("g_dias").innerHTML = ""; (f.dias?.length ? f.dias : [{ dow: 1, aula: 1 }]).forEach((d) => addDiaRow(d.dow, d.aula));
  const t = new Date(); $("g_ini").value = $("g_ini").value || t.toISOString().slice(0, 10); $("g_fim").value = $("g_fim").value || addDays(t.toISOString().slice(0, 10), 13);
}

$("genForm").onsubmit = async (e) => {
  e.preventDefault(); $("genBtn").disabled = true; msg($("genMsg"), "Os agentes estão lendo o guia e montando o plano… pode levar até 1 minuto.");
  lsSet("pa_prof", $("g_prof").value); saveForm();
  const ini = $("g_ini").value, fim = $("g_fim").value;
  if (fim < ini) { $("genBtn").disabled = false; return msg($("genMsg"), "O fim do período é anterior ao início.", "err"); }
  const body = { professor: $("g_prof").value, componente: $("g_comp").value, serie: $("g_serie").value, turma: $("g_turma").value, bimestre: $("g_bim").value, inicio: ini, fim, dias: readDias(), sem_aula: parseSem($("g_sem").value, ini), observacoes: $("g_obs").value, modelo: profile.model_text || "" };
  const { data, error } = await sb.functions.invoke("generate-plan", { body });
  $("genBtn").disabled = false;
  if (error) {
    let d = null; try { d = await error.context.json(); } catch {}
    if (d?.code === "payment_required") { await enter(); return; }
    return msg($("genMsg"), d?.error || "Não foi possível gerar o plano.", "err");
  }
  let extra = "";
  const per = $("g_per").value;
  if (per) { // memoriza a configuração: os próximos planos saem sozinhos
    const np = nextPeriod(per, fim), uid = (await sb.auth.getUser()).data.user.id;
    const dup = await sb.from("pa_routines").select("id").eq("componente", body.componente.trim()).eq("serie", body.serie.trim()).eq("active", true).maybeSingle();
    if (dup.data?.id) await sb.from("pa_routines").delete().eq("id", dup.data.id); // uma rotina por disciplina/série
    const { error: e2 } = await sb.from("pa_routines").insert({ user_id: uid, componente: body.componente.trim(), serie: body.serie.trim(), turma: body.turma.trim() || null, bimestre: body.bimestre ? Number(body.bimestre) : null, professor: body.professor, dias: body.dias, sem_aula: [], periodicidade: per, next_start: np.start, next_end: np.end });
    extra = e2 ? " (não foi possível criar a repetição automática)" : " Rotina criada: o próximo plano será gerado automaticamente.";
  }
  msg($("genMsg"), ("Plano pronto. " + (data.continuacao || "") + extra).trim(), "ok"); showPlan(data.title, data.plan);
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
$("r_pdf").onclick = () => {
  const name = ($("r_title").textContent || "plano").replace(/[^\p{L}\p{N}]+/gu, "_") + ".pdf";
  if (window.html2pdf) html2pdf().set({ margin: [12, 14], filename: name, image: { type: "jpeg", quality: 0.98 }, html2canvas: { scale: 2 }, jsPDF: { unit: "mm", format: "a4" }, pagebreak: { mode: ["css", "legacy"] } }).from($("planDoc")).save();
  else print();
};
$("r_close").onclick = () => { $("result").hidden = true; };
$("r_copy").onclick = async () => { try { await navigator.clipboard.writeText($("planDoc").innerText); $("r_copy").textContent = "Copiado!"; setTimeout(() => $("r_copy").textContent = "Copiar texto", 1500); } catch {} };

// ---------- meus planos
async function loadPlans() {
  const { data } = await sb.from("pa_plans").select("id,title,created_at,content,auto,seen").order("created_at", { ascending: false }).limit(100);
  const L = $("list"); L.innerHTML = data?.length ? "" : '<p class="muted">Nenhum plano ainda.</p>';
  for (const r of data || []) {
    const d = document.createElement("div"); d.className = "item";
    d.innerHTML = `<span><b>${esc(r.title)}</b>${r.auto && !r.seen ? ' <span class="badge">novo · automático</span>' : ""}<br><small class="muted">${new Date(r.created_at).toLocaleString("pt-BR")}</small></span><span><button class="btn ghost" data-o="1">Abrir</button> <button class="link" data-d="1">Excluir</button></span>`;
    d.querySelector("[data-o]").onclick = async () => { showPlan(r.title, r.content); if (!r.seen) { await sb.from("pa_plans").update({ seen: true }).eq("id", r.id); refreshBadge(); } };
    d.querySelector("[data-d]").onclick = async () => { if (confirm("Excluir este plano?")) { await sb.from("pa_plans").delete().eq("id", r.id); loadPlans(); } };
    L.appendChild(d);
  }
}

// ---------- rotinas automáticas ----------
const fmt = (iso) => iso.slice(8, 10) + "/" + iso.slice(5, 7);
async function loadRoutines() {
  const { data } = await sb.from("pa_routines").select("*").order("id", { ascending: false });
  const L = $("r_list"); L.innerHTML = data?.length ? "" : '<p class="muted">Nenhuma rotina. Ao gerar um plano, escolha “Repetir automaticamente”.</p>';
  for (const r of data || []) {
    const d = document.createElement("div"); d.className = "item";
    d.innerHTML = `<span><b>${esc(r.componente)} – ${esc(r.serie)}${r.turma ? " " + esc(r.turma) : ""}</b> · ${esc(r.periodicidade)}<br><small class="muted">Próximo plano: ${fmt(r.next_start)} a ${fmt(r.next_end)} · ${r.active ? "ativa" : "pausada"}${r.last_error ? " · erro na última tentativa" : ""}</small></span><span><button class="btn ghost" data-t="1">${r.active ? "Pausar" : "Ativar"}</button> <button class="link" data-d="1">Excluir</button></span>`;
    d.querySelector("[data-t]").onclick = async () => { await sb.from("pa_routines").update({ active: !r.active }).eq("id", r.id); loadRoutines(); };
    d.querySelector("[data-d]").onclick = async () => { if (confirm("Excluir esta rotina?")) { await sb.from("pa_routines").delete().eq("id", r.id); loadRoutines(); } };
    L.appendChild(d);
  }
}
async function refreshBadge() {
  const { count } = await sb.from("pa_plans").select("id", { count: "exact", head: true }).eq("auto", true).eq("seen", false);
  const b = $("newBadge"); b.hidden = !count; b.textContent = count || "";
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

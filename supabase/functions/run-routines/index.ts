import { createClient } from "npm:@supabase/supabase-js@2";

// Roda todo dia (agendado). Para cada rotina ativa cujo próximo período começa em até
// "antecedencia_dias", gera o plano (com a memória da sequência) e agenda o período seguinte.
function addDays(iso: string, n: number) { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function nextPeriod(per: string, fim: string) {
  const start = addDays(fim, 1);
  if (per === "semanal") return { start, end: addDays(start, 6) };
  if (per === "quinzenal") return { start, end: addDays(start, 13) };
  const d = new Date(start + "T12:00:00Z"); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(d.getUTCDate() - 1);
  return { start, end: d.toISOString().slice(0, 10) };
}

Deno.serve(async (req) => {
  const secret = Deno.env.get("CRON_SECRET");
  if (!secret || req.headers.get("x-internal-secret") !== secret) return new Response("forbidden", { status: 403 });
  const url = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const today = new Date().toISOString().slice(0, 10);
  const { data: routines } = await admin.from("pa_routines").select("*").eq("active", true).limit(200);
  const done: number[] = [];
  for (const r of routines ?? []) {
    if (addDays(today, r.antecedencia_dias) < r.next_start) continue; // ainda não é hora
    const { data: pf } = await admin.from("pa_profiles").select("model_text").eq("id", r.user_id).maybeSingle();
    const res = await fetch(`${url}/functions/v1/generate-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": secret, Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
      body: JSON.stringify({ user_id: r.user_id, auto: true, routine_id: r.id, componente: r.componente, serie: r.serie, turma: r.turma, bimestre: r.bimestre,
        professor: r.professor, dias: r.dias, sem_aula: r.sem_aula, inicio: r.next_start, fim: r.next_end, modelo: pf?.model_text ?? "" }),
    });
    if (res.ok) {
      const np = nextPeriod(r.periodicidade, r.next_end);
      await admin.from("pa_routines").update({ next_start: np.start, next_end: np.end, last_run_at: new Date().toISOString(), last_error: null }).eq("id", r.id);
      done.push(r.id);
    } else {
      const t = await res.text().catch(() => "");
      await admin.from("pa_routines").update({ last_error: t.slice(0, 300), last_run_at: new Date().toISOString() }).eq("id", r.id);
    }
  }
  return new Response(JSON.stringify({ ok: true, geradas: done }), { headers: { "Content-Type": "application/json" } });
});

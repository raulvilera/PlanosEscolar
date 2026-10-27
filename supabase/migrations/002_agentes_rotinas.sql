-- Memória da sequência + rotinas automáticas
alter table public.pa_plans
  add column if not exists componente text,
  add column if not exists serie text,
  add column if not exists turma text,
  add column if not exists bimestre int,
  add column if not exists periodo_inicio date,
  add column if not exists periodo_fim date,
  add column if not exists progress jsonb,
  add column if not exists routine_id bigint,
  add column if not exists auto boolean not null default false,
  add column if not exists seen boolean not null default true;
create index if not exists pa_plans_seq_idx on public.pa_plans(user_id, componente, serie, turma, bimestre, created_at desc);

-- cache da leitura do guia (agente leitor): evita reler o guia inteiro a cada plano
alter table public.pa_guides add column if not exists summary jsonb;

create table if not exists public.pa_routines (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  active boolean not null default true,
  componente text not null,
  serie text not null,
  turma text,
  bimestre int,
  professor text,
  dias jsonb not null,            -- [{"dow":2,"aula":4}] dow: 1=seg ... 6=sáb
  sem_aula jsonb not null default '[]',
  periodicidade text not null check (periodicidade in ('semanal','quinzenal','mensal')),
  next_start date not null,
  next_end date not null,
  antecedencia_dias int not null default 3,
  last_run_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);
alter table public.pa_routines enable row level security;
create policy pa_routines_sel on public.pa_routines for select using (auth.uid() = user_id);
create policy pa_routines_del on public.pa_routines for delete using (auth.uid() = user_id);
create policy pa_routines_ins on public.pa_routines for insert with check (auth.uid() = user_id);
create policy pa_routines_upd on public.pa_routines for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- o usuário pode marcar planos como vistos
grant update (seen) on public.pa_plans to authenticated;
create policy pa_plans_upd on public.pa_plans for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
revoke update on public.pa_plans from authenticated;
grant update (seen) on public.pa_plans to authenticated;

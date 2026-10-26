-- PlanoAula PWA: perfis, teste de 7 dias, assinaturas (Mercado Pago), guias, planos
create table if not exists public.pa_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  model_text text,
  is_admin boolean not null default false,
  trial_ends_at timestamptz not null default (now() + interval '7 days'),
  created_at timestamptz not null default now()
);
create table if not exists public.pa_subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan text check (plan in ('monthly','annual')),
  status text not null default 'none' check (status in ('none','pending','active','paused','cancelled')),
  mp_preapproval_id text,
  next_payment_date timestamptz,
  updated_at timestamptz not null default now()
);
create table if not exists public.pa_guides (
  id bigserial primary key,
  component text not null,
  serie text not null,
  bimestre int,
  title text not null,
  content text not null,
  created_at timestamptz not null default now()
);
create table if not exists public.pa_plans (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text,
  params jsonb,
  content jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists pa_plans_user_idx on public.pa_plans(user_id, created_at desc);
create index if not exists pa_guides_idx on public.pa_guides(component, serie, bimestre);

alter table public.pa_profiles enable row level security;
alter table public.pa_subscriptions enable row level security;
alter table public.pa_guides enable row level security;
alter table public.pa_plans enable row level security;

-- usuário vê/edita só o próprio perfil (sem poder mudar teste nem admin)
create policy pa_profiles_sel on public.pa_profiles for select using (auth.uid() = id);
create policy pa_profiles_upd on public.pa_profiles for update using (auth.uid() = id) with check (auth.uid() = id);
revoke update on public.pa_profiles from authenticated;
grant update (full_name, model_text) on public.pa_profiles to authenticated;
-- assinatura: só leitura pelo usuário (escrita só pelo servidor)
create policy pa_subs_sel on public.pa_subscriptions for select using (auth.uid() = user_id);
-- planos: do próprio usuário
create policy pa_plans_sel on public.pa_plans for select using (auth.uid() = user_id);
create policy pa_plans_del on public.pa_plans for delete using (auth.uid() = user_id);
-- guias: ninguém lê direto (conteúdo pago); admin gerencia
create policy pa_guides_admin on public.pa_guides for all
  using (exists (select 1 from public.pa_profiles p where p.id = auth.uid() and p.is_admin))
  with check (exists (select 1 from public.pa_profiles p where p.id = auth.uid() and p.is_admin));

-- cria perfil com 7 dias de teste no cadastro
create or replace function public.pa_handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.pa_profiles (id, full_name) values (new.id, coalesce(new.raw_user_meta_data->>'full_name', ''))
  on conflict do nothing;
  insert into public.pa_subscriptions (user_id) values (new.id) on conflict do nothing;
  return new;
end $$;
drop trigger if exists pa_on_auth_user_created on auth.users;
create trigger pa_on_auth_user_created after insert on auth.users
for each row execute function public.pa_handle_new_user();

-- estado de acesso: trial | active | expired
create or replace function public.pa_access_for(uid uuid) returns jsonb
language plpgsql security definer set search_path = public stable as $$
declare p public.pa_profiles; s public.pa_subscriptions; grace interval := interval '3 days';
begin
  select * into p from public.pa_profiles where id = uid;
  select * into s from public.pa_subscriptions where user_id = uid;
  if p.id is null then return jsonb_build_object('state','expired'); end if;
  if s.status = 'active' and (s.next_payment_date is null or s.next_payment_date + grace > now()) then
    return jsonb_build_object('state','active','plan',s.plan,'next_payment_date',s.next_payment_date);
  end if;
  if p.trial_ends_at > now() then
    return jsonb_build_object('state','trial','trial_ends_at',p.trial_ends_at,
      'days_left', greatest(1, ceil(extract(epoch from (p.trial_ends_at - now()))/86400)::int));
  end if;
  return jsonb_build_object('state','expired','trial_ends_at',p.trial_ends_at,'plan',s.plan,'status',s.status);
end $$;
revoke all on function public.pa_access_for(uuid) from public, anon, authenticated;
grant execute on function public.pa_access_for(uuid) to service_role;
-- versão para o app: sempre consulta o próprio usuário
create or replace function public.pa_access() returns jsonb
language sql security definer set search_path = public stable as $$ select public.pa_access_for(auth.uid()) $$;
revoke all on function public.pa_access() from public, anon;
grant execute on function public.pa_access() to authenticated;

-- Rewarded ads v2: server-side watch sessions, minimum watch time, cooldown, daily cap.
-- Run after 20261121000000_rewarded_ads.sql (safe to run if that one is not applied yet).
-- Rules: 20 coins per completed ad; watch >= 15 s; 60 s cooldown between claims;
-- max 5 claims per player per day (Asia/Kolkata day); a session expires after 10 minutes.

create table if not exists public.rewarded_ad_claims (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  claimed_on date not null default ((now() at time zone 'Asia/Kolkata')::date),
  created_at timestamptz not null default now()
);
create index if not exists rewarded_ad_claims_user_day on public.rewarded_ad_claims (user_id, claimed_on);
alter table public.rewarded_ad_claims enable row level security;
revoke all on public.rewarded_ad_claims from anon, authenticated;

create table if not exists public.rewarded_ad_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  started_at timestamptz not null default now(),
  finished boolean not null default false
);
alter table public.rewarded_ad_sessions enable row level security;
revoke all on public.rewarded_ad_sessions from anon, authenticated;

-- The coin ledger has a check constraint on "reason". Add 'rewarded_ad' to it while
-- keeping every reason that is already allowed. Safe to run more than once.
do $$
declare
  def text;
begin
  select pg_get_constraintdef(c.oid) into def
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  where t.relname = 'coin_ledger' and c.conname = 'coin_ledger_reason_check';

  if def is not null and def not like '%rewarded_ad%' then
    execute 'alter table public.coin_ledger drop constraint coin_ledger_reason_check';
    execute format(
      'alter table public.coin_ledger add constraint coin_ledger_reason_check check ((%s) or reason = %L)',
      substring(def from '^CHECK \((.*)\)$'), 'rewarded_ad'
    );
  end if;
end $$;

drop function if exists public.rewarded_ad_status();
drop function if exists public.claim_rewarded_ad();

-- Shared rule checks (cooldown + daily cap). Raises an exception if a rule is broken.
create or replace function public.rewarded_ad_check_limits(uid uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  today date := (now() at time zone 'Asia/Kolkata')::date;
  last_claim timestamptz;
  n int;
begin
  select max(created_at) into last_claim from public.rewarded_ad_claims where user_id = uid;
  if last_claim is not null and last_claim > now() - interval '60 seconds' then
    raise exception 'cooldown_active';
  end if;
  select count(*) into n from public.rewarded_ad_claims where user_id = uid and claimed_on = today;
  if n >= 5 then
    raise exception 'daily_limit_reached';
  end if;
end;
$$;

create or replace function public.rewarded_ad_status()
returns table (claims_today int, daily_limit int, remaining int, cooldown_seconds int)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  today date := (now() at time zone 'Asia/Kolkata')::date;
  n int;
  last_claim timestamptz;
begin
  select count(*)::int into n from public.rewarded_ad_claims where user_id = uid and claimed_on = today;
  select max(created_at) into last_claim from public.rewarded_ad_claims where user_id = uid;
  return query select n, 5, greatest(0, 5 - n),
    case when last_claim is null then 0
         else greatest(0, ceil(extract(epoch from (last_claim + interval '60 seconds' - now()))))::int end;
end;
$$;

-- Starts a watch session. The client must call claim with this id after the watch time.
create or replace function public.start_rewarded_ad()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  sid uuid;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  perform pg_advisory_xact_lock(hashtext(uid::text));
  perform public.rewarded_ad_check_limits(uid);
  insert into public.rewarded_ad_sessions (user_id) values (uid) returning id into sid;
  return sid;
end;
$$;

create or replace function public.claim_rewarded_ad(p_session uuid)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  sess record;
  new_balance bigint;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  perform pg_advisory_xact_lock(hashtext(uid::text));

  select * into sess from public.rewarded_ad_sessions where id = p_session and user_id = uid;
  if not found or sess.finished then raise exception 'session_used'; end if;
  if sess.started_at < now() - interval '10 minutes' then raise exception 'session_expired'; end if;
  if sess.started_at > now() - interval '15 seconds' then raise exception 'ad_not_finished'; end if;

  perform public.rewarded_ad_check_limits(uid);

  update public.rewarded_ad_sessions set finished = true where id = p_session;
  insert into public.rewarded_ad_claims (user_id) values (uid);

  insert into public.player_wallets (user_id, balance)
  values (uid, 20)
  on conflict (user_id) do update set balance = public.player_wallets.balance + 20
  returning balance into new_balance;

  insert into public.coin_ledger (user_id, amount, balance_after, reason)
  values (uid, 20, new_balance, 'rewarded_ad');

  return new_balance;
end;
$$;

revoke all on function public.rewarded_ad_check_limits(uuid) from public;
revoke all on function public.rewarded_ad_status() from public;
revoke all on function public.start_rewarded_ad() from public;
revoke all on function public.claim_rewarded_ad(uuid) from public;
grant execute on function public.rewarded_ad_status() to authenticated;
grant execute on function public.start_rewarded_ad() to authenticated;
grant execute on function public.claim_rewarded_ad(uuid) to authenticated;

-- Ask the Supabase API to reload its function list. Without this, new functions can
-- return "Could not find the function ... in the schema cache" (PGRST202 / 404).
notify pgrst, 'reload schema';

-- Verify afterwards (should return 3 rows):
-- select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public' and proname in ('start_rewarded_ad','claim_rewarded_ad','rewarded_ad_status');

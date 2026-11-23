-- Rewarded ads: 20 coins per completed ad, max 5 per player per day (Asia/Kolkata day).
-- Assumes existing tables used by the game:
--   player_wallets(user_id uuid primary key, balance bigint)
--   coin_ledger(user_id uuid, amount bigint, balance_after bigint, reason text, created_at timestamptz)
-- Run this in the Supabase SQL editor (or via the Supabase CLI).

create table if not exists public.rewarded_ad_claims (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  claimed_on date not null default ((now() at time zone 'Asia/Kolkata')::date),
  created_at timestamptz not null default now()
);

create index if not exists rewarded_ad_claims_user_day
  on public.rewarded_ad_claims (user_id, claimed_on);

-- Clients never touch this table directly; only the functions below.
alter table public.rewarded_ad_claims enable row level security;
revoke all on public.rewarded_ad_claims from anon, authenticated;

create or replace function public.rewarded_ad_status()
returns table (claims_today int, daily_limit int, remaining int)
language sql
stable
security definer
set search_path = public
as $$
  with c as (
    select count(*)::int as n
    from public.rewarded_ad_claims
    where user_id = auth.uid()
      and claimed_on = (now() at time zone 'Asia/Kolkata')::date
  )
  select c.n, 5, greatest(0, 5 - c.n) from c;
$$;

create or replace function public.claim_rewarded_ad()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  today date := (now() at time zone 'Asia/Kolkata')::date;
  n int;
  new_balance bigint;
begin
  if uid is null then
    raise exception 'not_authenticated';
  end if;

  -- Serialise concurrent claims for the same player so the limit cannot be bypassed.
  perform pg_advisory_xact_lock(hashtext(uid::text));

  select count(*) into n
  from public.rewarded_ad_claims
  where user_id = uid and claimed_on = today;

  if n >= 5 then
    raise exception 'daily_limit_reached';
  end if;

  insert into public.rewarded_ad_claims (user_id, claimed_on) values (uid, today);

  insert into public.player_wallets (user_id, balance)
  values (uid, 20)
  on conflict (user_id) do update set balance = public.player_wallets.balance + 20
  returning balance into new_balance;

  insert into public.coin_ledger (user_id, amount, balance_after, reason)
  values (uid, 20, new_balance, 'rewarded_ad');

  return new_balance;
end;
$$;

revoke all on function public.rewarded_ad_status() from public;
revoke all on function public.claim_rewarded_ad() from public;
grant execute on function public.rewarded_ad_status() to authenticated;
grant execute on function public.claim_rewarded_ad() to authenticated;

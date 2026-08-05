-- Run this once in Supabase: Dashboard > SQL Editor > New Query > paste > Run
-- Safe to re-run.

create table if not exists rate_limit_counters (
  bucket_key text primary key,
  count integer not null default 0,
  window_start timestamptz not null default now()
);

create table if not exists daily_usage_counters (
  usage_date date primary key,
  count integer not null default 0
);

create or replace function check_and_increment_rate_limit(
  p_key text,
  p_window_seconds integer,
  p_limit integer
) returns boolean
language plpgsql
as $$
declare
  v_count integer;
begin
  insert into rate_limit_counters (bucket_key, count, window_start)
  values (p_key, 1, now())
  on conflict (bucket_key) do update
    set count = case
        when rate_limit_counters.window_start < now() - (p_window_seconds || ' seconds')::interval
          then 1
        else rate_limit_counters.count + 1
      end,
      window_start = case
        when rate_limit_counters.window_start < now() - (p_window_seconds || ' seconds')::interval
          then now()
        else rate_limit_counters.window_start
      end
  returning count into v_count;
  return v_count <= p_limit;
end;
$$;

create or replace function check_and_increment_daily_cap(
  p_cap integer
) returns boolean
language plpgsql
as $$
declare
  v_count integer;
begin
  insert into daily_usage_counters (usage_date, count)
  values (current_date, 1)
  on conflict (usage_date) do update
    set count = daily_usage_counters.count + 1
  returning count into v_count;
  return v_count <= p_cap;
end;
$$;

-- ============================================================================
-- SRIDHAR RUSH — Supabase setup (run once in the Supabase SQL editor)
-- Creates the global leaderboard table. Browsers can only READ it;
-- the game server writes with the service-role key (bypasses RLS).
-- ============================================================================
create table if not exists public.leaderboard (
  id         bigint generated always as identity primary key,
  map        int  not null,
  pid        text not null,
  name       text not null,
  time_ms    int  not null,
  updated_at timestamptz not null default now(),
  unique (map, pid)
);

alter table public.leaderboard enable row level security;

-- anyone (anon + logged-in) may read the board
create policy "lb read" on public.leaderboard
  for select using (true);

-- no insert/update/delete policies on purpose:
-- writes happen only through the server's service-role key

create index if not exists lb_map_time on public.leaderboard (map, time_ms);

create table if not exists public.houses (
  project_code text not null default 'jiahua_junyuan',
  house_key text not null,
  building text not null,
  house_no text not null,
  floor integer,
  unit integer,
  room text,
  building_area numeric,
  area_bucket text,
  source text,
  building_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_code, house_key)
);

create table if not exists public.daily_project_snapshots (
  project_code text not null default 'jiahua_junyuan',
  snapshot_date date not null,
  extracted_at timestamptz,
  signed_count integer not null default 0,
  signed_area numeric not null default 0,
  avg_price numeric not null default 0,
  raw_overview jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_code, snapshot_date)
);

create table if not exists public.house_status_snapshots (
  project_code text not null default 'jiahua_junyuan',
  snapshot_date date not null,
  house_key text not null,
  building text,
  house_no text,
  status text not null,
  building_area numeric,
  total_price numeric,
  raw_status jsonb,
  created_at timestamptz not null default now(),
  primary key (project_code, snapshot_date, house_key),
  foreign key (project_code, snapshot_date)
    references public.daily_project_snapshots(project_code, snapshot_date)
    on delete cascade
);

create index if not exists idx_daily_project_snapshots_latest
  on public.daily_project_snapshots(project_code, snapshot_date desc);

create index if not exists idx_house_status_snapshots_day
  on public.house_status_snapshots(project_code, snapshot_date);

create index if not exists idx_house_status_snapshots_status
  on public.house_status_snapshots(project_code, snapshot_date, status);

alter table public.houses enable row level security;
alter table public.daily_project_snapshots enable row level security;
alter table public.house_status_snapshots enable row level security;

drop policy if exists "public read houses" on public.houses;
create policy "public read houses"
on public.houses for select
to anon
using (true);

drop policy if exists "public read daily snapshots" on public.daily_project_snapshots;
create policy "public read daily snapshots"
on public.daily_project_snapshots for select
to anon
using (true);

drop policy if exists "public read house status snapshots" on public.house_status_snapshots;
create policy "public read house status snapshots"
on public.house_status_snapshots for select
to anon
using (true);

-- Shared Household List: Supabase schema
-- Run this entire file once in Supabase > SQL Editor.
--
-- Daily task fields exposed by the app:
--   title, notes, status, owner
--
-- Technical fields such as timestamps remain in the database but are hidden
-- from the interface.

create extension if not exists pgcrypto;

create table if not exists public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Our household'
    check (char_length(trim(name)) between 1 and 60),
  join_code text not null unique
    default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  display_name text not null
    check (char_length(trim(display_name)) between 1 and 40),
  created_at timestamptz not null default now()
);

create index if not exists profiles_household_id_idx
  on public.profiles(household_id);

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  title text not null
    check (char_length(trim(title)) between 1 and 180),
  notes text not null default '',
  status text not null default 'inbox'
    check (status in ('inbox', 'next', 'waiting', 'done')),
  owner_id uuid null references public.profiles(user_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tasks_household_status_idx
  on public.tasks(household_id, status);

create index if not exists tasks_owner_id_idx
  on public.tasks(owner_id);

-- Helper functions are SECURITY DEFINER so policies can check membership without
-- recursively triggering the profiles table's own RLS policies.

create or replace function public.get_my_household_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.household_id
  from public.profiles p
  where p.user_id = (select auth.uid())
  limit 1;
$$;

create or replace function public.user_belongs_to_household(
  p_user_id uuid,
  p_household_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles p
    where p.user_id = p_user_id
      and p.household_id = p_household_id
  );
$$;

create or replace function public.create_household(
  p_display_name text,
  p_household_name text default 'Our household'
)
returns table (household_id uuid, join_code text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_household_id uuid;
  v_join_code text;
begin
  if v_user_id is null then
    raise exception 'You must be signed in.';
  end if;

  if nullif(trim(p_display_name), '') is null then
    raise exception 'Enter your name.';
  end if;

  if exists (
    select 1 from public.profiles where user_id = v_user_id
  ) then
    raise exception 'This account already belongs to a household.';
  end if;

  insert into public.households(name)
  values (coalesce(nullif(trim(p_household_name), ''), 'Our household'))
  returning id, households.join_code
    into v_household_id, v_join_code;

  insert into public.profiles(user_id, household_id, display_name)
  values (v_user_id, v_household_id, trim(p_display_name));

  return query select v_household_id, v_join_code;
end;
$$;

create or replace function public.join_household(
  p_display_name text,
  p_join_code text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_household_id uuid;
begin
  if v_user_id is null then
    raise exception 'You must be signed in.';
  end if;

  if nullif(trim(p_display_name), '') is null then
    raise exception 'Enter your name.';
  end if;

  if exists (
    select 1 from public.profiles where user_id = v_user_id
  ) then
    raise exception 'This account already belongs to a household.';
  end if;

  select h.id
  into v_household_id
  from public.households h
  where h.join_code = upper(trim(p_join_code))
  limit 1;

  if v_household_id is null then
    raise exception 'Invite code not found.';
  end if;

  insert into public.profiles(user_id, household_id, display_name)
  values (v_user_id, v_household_id, trim(p_display_name));

  return v_household_id;
end;
$$;

create or replace function public.set_task_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists tasks_set_updated_at on public.tasks;

create trigger tasks_set_updated_at
before update on public.tasks
for each row
execute function public.set_task_updated_at();

alter table public.households enable row level security;
alter table public.profiles enable row level security;
alter table public.tasks enable row level security;

drop policy if exists "Members can view their household" on public.households;
create policy "Members can view their household"
on public.households
for select
to authenticated
using (id = (select public.get_my_household_id()));

drop policy if exists "Members can view household profiles" on public.profiles;
create policy "Members can view household profiles"
on public.profiles
for select
to authenticated
using (household_id = (select public.get_my_household_id()));

drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile"
on public.profiles
for update
to authenticated
using (user_id = (select auth.uid()))
with check (
  user_id = (select auth.uid())
  and household_id = (select public.get_my_household_id())
);

drop policy if exists "Members can view household tasks" on public.tasks;
create policy "Members can view household tasks"
on public.tasks
for select
to authenticated
using (household_id = (select public.get_my_household_id()));

drop policy if exists "Members can create household tasks" on public.tasks;
create policy "Members can create household tasks"
on public.tasks
for insert
to authenticated
with check (
  household_id = (select public.get_my_household_id())
  and (
    owner_id is null
    or public.user_belongs_to_household(owner_id, household_id)
  )
);

drop policy if exists "Members can update household tasks" on public.tasks;
create policy "Members can update household tasks"
on public.tasks
for update
to authenticated
using (household_id = (select public.get_my_household_id()))
with check (
  household_id = (select public.get_my_household_id())
  and (
    owner_id is null
    or public.user_belongs_to_household(owner_id, household_id)
  )
);

drop policy if exists "Members can delete household tasks" on public.tasks;
create policy "Members can delete household tasks"
on public.tasks
for delete
to authenticated
using (household_id = (select public.get_my_household_id()));

revoke all on public.households from anon;
revoke all on public.profiles from anon;
revoke all on public.tasks from anon;

grant select on public.households to authenticated;
grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.tasks to authenticated;

revoke all on function public.get_my_household_id() from public;
revoke all on function public.user_belongs_to_household(uuid, uuid) from public;
revoke all on function public.create_household(text, text) from public;
revoke all on function public.join_household(text, text) from public;

grant execute on function public.get_my_household_id() to authenticated;
grant execute on function public.user_belongs_to_household(uuid, uuid) to authenticated;
grant execute on function public.create_household(text, text) to authenticated;
grant execute on function public.join_household(text, text) to authenticated;

-- Enable simple Postgres Changes subscriptions for this two-person app.
alter table public.tasks replica identity full;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'tasks'
  ) then
    alter publication supabase_realtime add table public.tasks;
  end if;
end
$$;

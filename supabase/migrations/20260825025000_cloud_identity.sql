create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  deletion_requested_at timestamptz
);

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  public_key text not null check (char_length(public_key) between 32 and 4096),
  key_version integer not null default 1 check (key_version > 0),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz
);

create index devices_user_id_idx on public.devices(user_id);

alter table public.profiles enable row level security;
alter table public.devices enable row level security;

revoke all on public.profiles from anon, authenticated;
revoke all on public.devices from anon, authenticated;
grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.devices to authenticated;

create policy "profiles_select_own" on public.profiles
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "profiles_update_own" on public.profiles
  for update to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "devices_select_own" on public.devices
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "devices_insert_own" on public.devices
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "devices_update_own" on public.devices
  for update to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "devices_delete_own" on public.devices
  for delete to authenticated using ((select auth.uid()) = user_id);

create function public.handle_new_user_profile()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles(user_id) values (new.id);
  return new;
end;
$$;

revoke all on function public.handle_new_user_profile() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user_profile();

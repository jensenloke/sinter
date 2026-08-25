-- Keep Sinter account IDs stable even when the authentication provider changes.
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user_profile();

drop policy if exists "profiles_select_own" on public.profiles;
drop policy if exists "profiles_update_own" on public.profiles;
drop policy if exists "devices_select_own" on public.devices;
drop policy if exists "devices_insert_own" on public.devices;
drop policy if exists "devices_update_own" on public.devices;
drop policy if exists "devices_delete_own" on public.devices;

alter table public.devices drop constraint if exists devices_user_id_fkey;
alter table public.profiles drop constraint if exists profiles_user_id_fkey;
alter table public.profiles rename column user_id to id;
alter table public.profiles add column email text;

update public.profiles as profile
set email = users.email
from auth.users as users
where users.id = profile.id;

create unique index profiles_normalized_email_idx
  on public.profiles (lower(email)) where email is not null;

alter table public.devices
  add constraint devices_user_id_fkey foreign key (user_id)
  references public.profiles(id) on delete cascade;

create table public.account_identities (
  issuer text not null,
  subject text not null,
  account_id uuid not null references public.profiles(id) on delete cascade,
  email text,
  email_verified boolean not null default false,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (issuer, subject),
  check (char_length(issuer) between 8 and 512),
  check (char_length(subject) between 1 and 512)
);

create index account_identities_account_id_idx on public.account_identities(account_id);
alter table public.account_identities enable row level security;
revoke all on public.account_identities from public, anon, authenticated;

create function public.current_account_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select identity.account_id
  from public.account_identities as identity
  where identity.issuer = (select auth.jwt()->>'iss')
    and identity.subject = (select auth.jwt()->>'sub')
$$;

revoke all on function public.current_account_id() from public, anon;
grant execute on function public.current_account_id() to authenticated;

create function public.claim_account()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  claims jsonb := auth.jwt();
  token_issuer text := claims->>'iss';
  token_subject text := claims->>'sub';
  token_email text := nullif(lower(trim(claims->>'email')), '');
  token_email_verified boolean := coalesce((claims->>'email_verified')::boolean, false);
  result uuid;
begin
  if auth.role() <> 'authenticated' or token_issuer is null or token_subject is null then
    raise exception 'authenticated identity required' using errcode = '42501';
  end if;

  select identity.account_id into result
  from public.account_identities as identity
  where identity.issuer = token_issuer and identity.subject = token_subject;

  if result is not null then
    update public.account_identities
    set last_seen_at = now(),
        email = coalesce(token_email, email),
        email_verified = email_verified or token_email_verified
    where issuer = token_issuer and subject = token_subject;
    return result;
  end if;

  if token_email_verified and token_email is not null then
    select profile.id into result
    from public.profiles as profile
    where lower(profile.email) = token_email;
  end if;

  if result is null then
    insert into public.profiles(id, email)
    values (gen_random_uuid(), case when token_email_verified then token_email else null end)
    returning id into result;
  end if;

  insert into public.account_identities(issuer, subject, account_id, email, email_verified)
  values (token_issuer, token_subject, result, token_email, token_email_verified)
  on conflict (issuer, subject) do update set last_seen_at = now()
  returning account_id into result;

  return result;
end;
$$;

revoke all on function public.claim_account() from public, anon;
grant execute on function public.claim_account() to authenticated;

create policy "profiles_select_own" on public.profiles
  for select to authenticated using ((select public.current_account_id()) = id);
create policy "profiles_update_own" on public.profiles
  for update to authenticated using ((select public.current_account_id()) = id)
  with check ((select public.current_account_id()) = id);

create policy "devices_select_own" on public.devices
  for select to authenticated using ((select public.current_account_id()) = user_id);
create policy "devices_insert_own" on public.devices
  for insert to authenticated with check ((select public.current_account_id()) = user_id);
create policy "devices_update_own" on public.devices
  for update to authenticated using ((select public.current_account_id()) = user_id)
  with check ((select public.current_account_id()) = user_id);
create policy "devices_delete_own" on public.devices
  for delete to authenticated using ((select public.current_account_id()) = user_id);

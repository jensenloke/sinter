-- Local-first Sinter Cloud control-plane metadata.
--
-- This migration deliberately contains no capsule, transcript, ciphertext,
-- Storage, payment-provider, or billing-transaction data.

create table public.account_roles (
  account_id uuid not null references public.profiles(id) on delete cascade,
  role text not null,
  created_at timestamptz not null default now(),
  granted_by uuid references public.profiles(id) on delete set null,
  reason text not null,
  primary key (account_id, role),
  constraint account_roles_role_check check (
    role in ('super_admin', 'support_readonly', 'billing_admin')
  ),
  constraint account_roles_reason_check check (
    char_length(reason) between 1 and 500
  )
);

create index account_roles_role_idx on public.account_roles(role, account_id);

create table public.account_entitlements (
  account_id uuid primary key references public.profiles(id) on delete cascade,
  plan_code text not null default 'development',
  status text not null default 'active',
  uploads_enabled boolean not null default false,
  unmetered boolean not null default false,
  storage_limit_bytes bigint default 0,
  session_limit integer default 0,
  capsule_size_limit_bytes integer not null default 16777216,
  device_limit integer not null default 2,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null,
  constraint account_entitlements_plan_code_check check (
    char_length(plan_code) between 1 and 64
    and plan_code ~ '^[a-z0-9][a-z0-9_-]*$'
  ),
  constraint account_entitlements_status_check check (
    status in ('active', 'suspended')
  ),
  constraint account_entitlements_storage_limit_check check (
    storage_limit_bytes is null or storage_limit_bytes >= 0
  ),
  constraint account_entitlements_session_limit_check check (
    session_limit is null or session_limit >= 0
  ),
  constraint account_entitlements_capsule_size_limit_check check (
    capsule_size_limit_bytes between 0 and 67108864
  ),
  constraint account_entitlements_device_limit_check check (
    device_limit between 0 and 32
  ),
  constraint account_entitlements_metering_check check (
    (unmetered and storage_limit_bytes is null and session_limit is null)
    or
    (not unmetered and storage_limit_bytes is not null and session_limit is not null)
  )
);

create table public.account_usage (
  account_id uuid primary key references public.profiles(id) on delete cascade,
  retained_storage_bytes bigint not null default 0,
  capsule_count bigint not null default 0,
  reserved_storage_bytes bigint not null default 0,
  reserved_capsule_count bigint not null default 0,
  monthly_egress_bytes bigint not null default 0,
  period_started_at timestamptz not null default date_trunc('month', now()),
  updated_at timestamptz not null default now(),
  constraint account_usage_retained_storage_check check (retained_storage_bytes >= 0),
  constraint account_usage_capsule_count_check check (capsule_count >= 0),
  constraint account_usage_reserved_storage_check check (reserved_storage_bytes >= 0),
  constraint account_usage_reserved_capsule_check check (reserved_capsule_count >= 0),
  constraint account_usage_monthly_egress_check check (monthly_egress_bytes >= 0)
);

create table public.admin_audit_events (
  id bigint generated always as identity primary key,
  actor_account_id uuid not null references public.profiles(id),
  target_account_id uuid references public.profiles(id),
  action text not null,
  reason text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint admin_audit_events_action_check check (
    char_length(action) between 1 and 100
    and action ~ '^[a-z0-9][a-z0-9._-]*$'
  ),
  constraint admin_audit_events_reason_check check (
    char_length(reason) between 1 and 500
  ),
  constraint admin_audit_events_details_check check (
    jsonb_typeof(details) = 'object'
    and octet_length(details::text) <= 4096
    and details::text !~* '"(content|transcript|ciphertext|token|proof|signature|key|private_key|public_key|encryption_public_key|signing_public_key|prompt|messages)"[[:space:]]*:'
  )
);

create index admin_audit_events_actor_created_idx
  on public.admin_audit_events(actor_account_id, created_at desc);
create index admin_audit_events_target_created_idx
  on public.admin_audit_events(target_account_id, created_at desc)
  where target_account_id is not null;

alter table public.account_roles enable row level security;
alter table public.account_entitlements enable row level security;
alter table public.account_usage enable row level security;
alter table public.admin_audit_events enable row level security;

revoke all on public.account_roles
  from public, anon, authenticated, service_role;
revoke all on public.account_entitlements
  from public, anon, authenticated, service_role;
revoke all on public.account_usage
  from public, anon, authenticated, service_role;
revoke all on public.admin_audit_events
  from public, anon, authenticated, service_role;
revoke all on sequence public.admin_audit_events_id_seq
  from public, anon, authenticated, service_role;

grant select on public.account_entitlements to authenticated;
grant select on public.account_usage to authenticated;

create policy "account_entitlements_select_own"
  on public.account_entitlements
  for select to authenticated
  using ((select public.current_account_id()) = account_id);

create policy "account_usage_select_own"
  on public.account_usage
  for select to authenticated
  using ((select public.current_account_id()) = account_id);

create function public.initialize_account_control_plane()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.account_entitlements(account_id)
  values (new.id)
  on conflict (account_id) do nothing;

  insert into public.account_usage(account_id)
  values (new.id)
  on conflict (account_id) do nothing;

  return new;
end;
$$;

revoke all on function public.initialize_account_control_plane()
  from public, anon, authenticated, service_role;

insert into public.account_entitlements(account_id)
select profile.id
from public.profiles as profile
on conflict (account_id) do nothing;

insert into public.account_usage(account_id)
select profile.id
from public.profiles as profile
on conflict (account_id) do nothing;

create trigger profiles_initialize_account_control_plane
  after insert on public.profiles
  for each row execute function public.initialize_account_control_plane();

create function public.enforce_admin_audit_event_immutability()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using
    errcode = '55000',
    message = 'admin audit events are immutable';
end;
$$;

revoke all on function public.enforce_admin_audit_event_immutability()
  from public, anon, authenticated, service_role;

create trigger admin_audit_events_enforce_immutability
  before update or delete on public.admin_audit_events
  for each row execute function public.enforce_admin_audit_event_immutability();

create function public.bootstrap_super_admin(
  p_account_id uuid,
  p_reason text
)
returns public.account_roles
language plpgsql
security definer
set search_path = ''
as $$
declare
  result public.account_roles%rowtype;
  role_count bigint;
  exact_existing_state boolean := false;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'service_role required';
  end if;

  if p_reason is null or char_length(p_reason) not between 1 and 500 then
    raise exception using errcode = '22023', message = 'reason must contain between 1 and 500 characters';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('sinter-control-plane:first-admin', 0)
  );

  if not exists (select 1 from public.profiles where id = p_account_id) then
    raise exception using errcode = '22023', message = 'account does not exist';
  end if;

  select count(*) into role_count from public.account_roles;

  if role_count > 0 then
    select exists (
      select 1
      from public.account_roles as account_role
      join public.account_entitlements as entitlement
        on entitlement.account_id = account_role.account_id
      where account_role.account_id = p_account_id
        and account_role.role = 'super_admin'
        and account_role.granted_by = p_account_id
        and account_role.reason = p_reason
        and entitlement.plan_code = 'development'
        and entitlement.status = 'active'
        and entitlement.uploads_enabled = false
        and entitlement.unmetered = true
        and entitlement.storage_limit_bytes is null
        and entitlement.session_limit is null
        and entitlement.capsule_size_limit_bytes = 16777216
        and entitlement.device_limit = 2
        and entitlement.updated_by = p_account_id
    ) and role_count = 1
    into exact_existing_state;

    if exact_existing_state then
      select * into result
      from public.account_roles
      where account_id = p_account_id and role = 'super_admin';
      return result;
    end if;

    raise exception using
      errcode = '55000',
      message = 'control plane already has an account role';
  end if;

  insert into public.account_roles(account_id, role, granted_by, reason)
  values (p_account_id, 'super_admin', p_account_id, p_reason)
  returning * into result;

  update public.account_entitlements
  set plan_code = 'development',
      status = 'active',
      uploads_enabled = false,
      unmetered = true,
      storage_limit_bytes = null,
      session_limit = null,
      capsule_size_limit_bytes = 16777216,
      device_limit = 2,
      updated_at = pg_catalog.clock_timestamp(),
      updated_by = p_account_id
  where account_id = p_account_id;

  if not found then
    raise exception using errcode = '55000', message = 'account entitlement is missing';
  end if;

  insert into public.admin_audit_events(
    actor_account_id,
    target_account_id,
    action,
    reason,
    details
  ) values (
    p_account_id,
    p_account_id,
    'admin.bootstrap',
    p_reason,
    pg_catalog.jsonb_build_object(
      'role', 'super_admin',
      'plan_code', 'development',
      'status', 'active',
      'uploads_enabled', false,
      'unmetered', true
    )
  );

  return result;
end;
$$;

revoke all on function public.bootstrap_super_admin(uuid, text)
  from public, anon, authenticated;
grant execute on function public.bootstrap_super_admin(uuid, text)
  to service_role;

create function public.admin_is_super_admin(p_account_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'service_role required';
  end if;

  return exists (
    select 1
    from public.account_roles
    where account_roles.account_id = p_account_id
      and account_roles.role = 'super_admin'
  );
end;
$$;

revoke all on function public.admin_is_super_admin(uuid)
  from public, anon, authenticated;
grant execute on function public.admin_is_super_admin(uuid)
  to service_role;

create function public.admin_list_accounts(p_actor_account_id uuid)
returns table (
  account_id uuid,
  email text,
  account_created_at timestamptz,
  deletion_requested_at timestamptz,
  plan_code text,
  entitlement_status text,
  uploads_enabled boolean,
  unmetered boolean,
  storage_limit_bytes bigint,
  session_limit integer,
  capsule_size_limit_bytes integer,
  device_limit integer,
  entitlement_updated_at timestamptz,
  retained_storage_bytes bigint,
  capsule_count bigint,
  reserved_storage_bytes bigint,
  reserved_capsule_count bigint,
  monthly_egress_bytes bigint,
  usage_period_started_at timestamptz,
  usage_updated_at timestamptz,
  active_device_count bigint,
  total_device_count bigint,
  pending_enrollment_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'service_role required';
  end if;

  if not exists (
    select 1
    from public.account_roles
    where account_roles.account_id = p_actor_account_id
      and account_roles.role = 'super_admin'
  ) then
    raise exception using errcode = '42501', message = 'super_admin required';
  end if;

  return query
  select
    profile.id,
    profile.email,
    profile.created_at,
    profile.deletion_requested_at,
    entitlement.plan_code,
    entitlement.status,
    entitlement.uploads_enabled,
    entitlement.unmetered,
    entitlement.storage_limit_bytes,
    entitlement.session_limit,
    entitlement.capsule_size_limit_bytes,
    entitlement.device_limit,
    entitlement.updated_at,
    usage.retained_storage_bytes,
    usage.capsule_count,
    usage.reserved_storage_bytes,
    usage.reserved_capsule_count,
    usage.monthly_egress_bytes,
    usage.period_started_at,
    usage.updated_at,
    coalesce(device_counts.active_count, 0),
    coalesce(device_counts.total_count, 0),
    coalesce(enrollment_counts.pending_count, 0)
  from public.profiles as profile
  join public.account_entitlements as entitlement
    on entitlement.account_id = profile.id
  join public.account_usage as usage
    on usage.account_id = profile.id
  left join lateral (
    select
      count(*) filter (where device.revoked_at is null) as active_count,
      count(*) as total_count
    from public.devices as device
    where device.user_id = profile.id
  ) as device_counts on true
  left join lateral (
    select count(*) as pending_count
    from public.device_enrollment_requests as request
    where request.account_id = profile.id
      and request.status in ('pending', 'approved')
      and request.device_id is null
      and request.expires_at > pg_catalog.statement_timestamp()
  ) as enrollment_counts on true
  order by profile.created_at, profile.id;
end;
$$;

revoke all on function public.admin_list_accounts(uuid)
  from public, anon, authenticated;
grant execute on function public.admin_list_accounts(uuid)
  to service_role;

create function public.admin_set_entitlement(
  p_actor_account_id uuid,
  p_target_account_id uuid,
  p_plan_code text,
  p_status text,
  p_uploads_enabled boolean,
  p_unmetered boolean,
  p_storage_limit_bytes bigint,
  p_session_limit integer,
  p_capsule_size_limit_bytes integer,
  p_device_limit integer,
  p_reason text
)
returns public.account_entitlements
language plpgsql
security definer
set search_path = ''
as $$
declare
  previous public.account_entitlements%rowtype;
  result public.account_entitlements%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'service_role required';
  end if;

  if not exists (
    select 1
    from public.account_roles
    where account_roles.account_id = p_actor_account_id
      and account_roles.role = 'super_admin'
  ) then
    raise exception using errcode = '42501', message = 'super_admin required';
  end if;

  if p_reason is null or char_length(p_reason) not between 1 and 500 then
    raise exception using errcode = '22023', message = 'reason must contain between 1 and 500 characters';
  end if;

  if p_plan_code is null
    or char_length(p_plan_code) not between 1 and 64
    or p_plan_code !~ '^[a-z0-9][a-z0-9_-]*$' then
    raise exception using errcode = '22023', message = 'invalid plan code';
  end if;

  if p_status is null or p_status not in ('active', 'suspended') then
    raise exception using errcode = '22023', message = 'invalid entitlement status';
  end if;

  if p_uploads_enabled is null or p_unmetered is null then
    raise exception using errcode = '22023', message = 'uploads_enabled and unmetered must be explicit';
  end if;

  if (p_unmetered and (p_storage_limit_bytes is not null or p_session_limit is not null))
    or (not p_unmetered and (p_storage_limit_bytes is null or p_session_limit is null)) then
    raise exception using errcode = '22023', message = 'invalid metering limits';
  end if;

  if p_storage_limit_bytes < 0 or p_session_limit < 0 then
    raise exception using errcode = '22023', message = 'product limits cannot be negative';
  end if;

  if p_capsule_size_limit_bytes is null
    or p_capsule_size_limit_bytes < 0
    or p_capsule_size_limit_bytes > 67108864 then
    raise exception using errcode = '22023', message = 'capsule size limit exceeds the 64 MiB safety cap';
  end if;

  if p_device_limit is null or p_device_limit < 0 or p_device_limit > 32 then
    raise exception using errcode = '22023', message = 'device limit exceeds the 32-device safety cap';
  end if;

  select * into previous
  from public.account_entitlements
  where account_id = p_target_account_id
  for update;

  if not found then
    raise exception using errcode = '22023', message = 'target account does not exist';
  end if;

  update public.account_entitlements
  set plan_code = p_plan_code,
      status = p_status,
      uploads_enabled = p_uploads_enabled,
      unmetered = p_unmetered,
      storage_limit_bytes = p_storage_limit_bytes,
      session_limit = p_session_limit,
      capsule_size_limit_bytes = p_capsule_size_limit_bytes,
      device_limit = p_device_limit,
      updated_at = pg_catalog.clock_timestamp(),
      updated_by = p_actor_account_id
  where account_id = p_target_account_id
  returning * into result;

  insert into public.admin_audit_events(
    actor_account_id,
    target_account_id,
    action,
    reason,
    details
  ) values (
    p_actor_account_id,
    p_target_account_id,
    'admin.entitlement.set',
    p_reason,
    pg_catalog.jsonb_build_object(
      'previous', pg_catalog.jsonb_build_object(
        'plan_code', previous.plan_code,
        'status', previous.status,
        'uploads_enabled', previous.uploads_enabled,
        'unmetered', previous.unmetered,
        'storage_limit_bytes', previous.storage_limit_bytes,
        'session_limit', previous.session_limit,
        'capsule_size_limit_bytes', previous.capsule_size_limit_bytes,
        'device_limit', previous.device_limit
      ),
      'next', pg_catalog.jsonb_build_object(
        'plan_code', result.plan_code,
        'status', result.status,
        'uploads_enabled', result.uploads_enabled,
        'unmetered', result.unmetered,
        'storage_limit_bytes', result.storage_limit_bytes,
        'session_limit', result.session_limit,
        'capsule_size_limit_bytes', result.capsule_size_limit_bytes,
        'device_limit', result.device_limit
      )
    )
  );

  return result;
end;
$$;

revoke all on function public.admin_set_entitlement(uuid, uuid, text, text, boolean, boolean, bigint, integer, integer, integer, text)
  from public, anon, authenticated;
grant execute on function public.admin_set_entitlement(uuid, uuid, text, text, boolean, boolean, bigint, integer, integer, integer, text)
  to service_role;

create function public.admin_grant_role(
  p_actor_account_id uuid,
  p_target_account_id uuid,
  p_role text,
  p_reason text
)
returns public.account_roles
language plpgsql
security definer
set search_path = ''
as $$
declare
  result public.account_roles%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'service_role required';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('sinter-control-plane:first-admin', 0)
  );

  if not exists (
    select 1 from public.account_roles
    where account_roles.account_id = p_actor_account_id
      and account_roles.role = 'super_admin'
  ) then
    raise exception using errcode = '42501', message = 'super_admin required';
  end if;

  if p_role is null or p_role not in ('super_admin', 'support_readonly', 'billing_admin') then
    raise exception using errcode = '22023', message = 'invalid account role';
  end if;

  if p_reason is null or char_length(p_reason) not between 1 and 500 then
    raise exception using errcode = '22023', message = 'reason must contain between 1 and 500 characters';
  end if;

  if not exists (select 1 from public.profiles where id = p_target_account_id) then
    raise exception using errcode = '22023', message = 'target account does not exist';
  end if;

  select * into result
  from public.account_roles
  where account_id = p_target_account_id and role = p_role;

  if found then
    if result.granted_by = p_actor_account_id and result.reason = p_reason then
      return result;
    end if;
    raise exception using errcode = '55000', message = 'account role already exists with different grant metadata';
  end if;

  insert into public.account_roles(account_id, role, granted_by, reason)
  values (p_target_account_id, p_role, p_actor_account_id, p_reason)
  returning * into result;

  insert into public.admin_audit_events(
    actor_account_id,
    target_account_id,
    action,
    reason,
    details
  ) values (
    p_actor_account_id,
    p_target_account_id,
    'admin.role.grant',
    p_reason,
    pg_catalog.jsonb_build_object('role', p_role)
  );

  return result;
end;
$$;

revoke all on function public.admin_grant_role(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.admin_grant_role(uuid, uuid, text, text)
  to service_role;

create function public.admin_revoke_role(
  p_actor_account_id uuid,
  p_target_account_id uuid,
  p_role text,
  p_reason text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'service_role required';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('sinter-control-plane:first-admin', 0)
  );

  if not exists (
    select 1 from public.account_roles
    where account_roles.account_id = p_actor_account_id
      and account_roles.role = 'super_admin'
  ) then
    raise exception using errcode = '42501', message = 'super_admin required';
  end if;

  if p_role is null or p_role not in ('super_admin', 'support_readonly', 'billing_admin') then
    raise exception using errcode = '22023', message = 'invalid account role';
  end if;

  if p_reason is null or char_length(p_reason) not between 1 and 500 then
    raise exception using errcode = '22023', message = 'reason must contain between 1 and 500 characters';
  end if;

  if p_role = 'super_admin'
    and exists (
      select 1 from public.account_roles
      where account_id = p_target_account_id and role = 'super_admin'
    )
    and (select count(*) from public.account_roles where role = 'super_admin') = 1 then
    raise exception using errcode = '55000', message = 'cannot revoke the final super_admin';
  end if;

  delete from public.account_roles
  where account_id = p_target_account_id and role = p_role;

  if not found then
    return false;
  end if;

  insert into public.admin_audit_events(
    actor_account_id,
    target_account_id,
    action,
    reason,
    details
  ) values (
    p_actor_account_id,
    p_target_account_id,
    'admin.role.revoke',
    p_reason,
    pg_catalog.jsonb_build_object('role', p_role)
  );

  return true;
end;
$$;

revoke all on function public.admin_revoke_role(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.admin_revoke_role(uuid, uuid, text, text)
  to service_role;

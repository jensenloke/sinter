insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
) values (
  'capsules',
  'capsules',
  false,
  67108864,
  array['application/octet-stream']::text[]
)
on conflict (id) do update
set public = false,
    file_size_limit = 67108864,
    allowed_mime_types = array['application/octet-stream']::text[];

create table public.capsules (
  account_id uuid not null references public.profiles(id) on delete cascade,
  capsule_id text not null,
  object_path text not null,
  serialized_bytes bigint not null,
  serialized_sha256 text not null,
  outer_schema text not null,
  payload_schema text not null,
  transfer_schema text not null,
  sender_fingerprint text not null,
  recipient_count integer not null,
  status text not null default 'reserved',
  reserved_at timestamptz not null,
  reservation_refreshed_at timestamptz not null,
  reservation_expires_at timestamptz not null,
  finalized_at timestamptz,
  deletion_requested_at timestamptz,
  storage_deleted_at timestamptz,
  expiry_requested_at timestamptz,
  storage_cleanup_completed_at timestamptz,
  expired_at timestamptz,
  primary key (account_id, capsule_id),
  constraint capsules_capsule_id_check check (
    capsule_id ~ '^[A-Za-z0-9_-]{21}[AQgw]$'
  ),
  constraint capsules_object_path_check check (
    object_path = account_id::text || '/' || capsule_id || '.capsule'
    and octet_length(object_path) <= 80
  ),
  constraint capsules_serialized_bytes_check check (
    serialized_bytes between 1 and 67108864
  ),
  constraint capsules_serialized_sha256_check check (
    serialized_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint capsules_schema_identifiers_check check (
    char_length(outer_schema) between 1 and 128
    and char_length(payload_schema) between 1 and 128
    and char_length(transfer_schema) between 1 and 128
    and outer_schema ~ '^[a-z][a-z0-9.-]*\.v[0-9]+$'
    and payload_schema ~ '^[a-z][a-z0-9.-]*\.v[0-9]+$'
    and transfer_schema ~ '^[a-z][a-z0-9.-]*\.v[0-9]+$'
  ),
  constraint capsules_sender_fingerprint_check check (
    sender_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  constraint capsules_recipient_count_check check (
    recipient_count between 1 and 32
  ),
  constraint capsules_reservation_expiry_check check (
    reservation_refreshed_at >= reserved_at
    and reservation_expires_at > reservation_refreshed_at
    and reservation_expires_at <= reservation_refreshed_at + interval '2 hours 15 minutes'
  ),
  constraint capsules_state_check check (
    (
      status = 'reserved'
      and finalized_at is null
      and deletion_requested_at is null
      and storage_deleted_at is null
      and expiry_requested_at is null
      and storage_cleanup_completed_at is null
      and expired_at is null
    )
    or
    (
      status = 'retained'
      and finalized_at is not null
      and finalized_at >= reserved_at
      and deletion_requested_at is null
      and storage_deleted_at is null
      and expiry_requested_at is null
      and storage_cleanup_completed_at is null
      and expired_at is null
    )
    or
    (
      status = 'delete_pending'
      and finalized_at is not null
      and deletion_requested_at is not null
      and deletion_requested_at >= finalized_at
      and storage_deleted_at is null
      and expiry_requested_at is null
      and storage_cleanup_completed_at is null
      and expired_at is null
    )
    or
    (
      status = 'deleted'
      and finalized_at is not null
      and deletion_requested_at is not null
      and storage_deleted_at is not null
      and storage_deleted_at >= deletion_requested_at
      and expiry_requested_at is null
      and storage_cleanup_completed_at is null
      and expired_at is null
    )
    or
    (
      status = 'expiry_pending'
      and finalized_at is null
      and deletion_requested_at is null
      and storage_deleted_at is null
      and expiry_requested_at is not null
      and expiry_requested_at >= reservation_expires_at
      and storage_cleanup_completed_at is null
      and expired_at is null
    )
    or
    (
      status = 'expired'
      and finalized_at is null
      and deletion_requested_at is null
      and storage_deleted_at is null
      and expiry_requested_at is not null
      and storage_cleanup_completed_at is not null
      and storage_cleanup_completed_at >= expiry_requested_at
      and expired_at is not null
      and expired_at >= storage_cleanup_completed_at
    )
  )
);

create unique index capsules_object_path_idx on public.capsules(object_path);
create index capsules_account_status_created_idx
  on public.capsules(account_id, status, reserved_at desc, capsule_id);
create index capsules_expiring_reservations_idx
  on public.capsules(reservation_expires_at, account_id, capsule_id)
  where status = 'reserved';
create index capsules_pending_expiry_cleanup_idx
  on public.capsules(expiry_requested_at, account_id, capsule_id)
  where status = 'expiry_pending';
create index capsules_pending_deletions_idx
  on public.capsules(account_id, deletion_requested_at, capsule_id)
  where status = 'delete_pending';

create table public.capsule_recipients (
  account_id uuid not null references public.profiles(id) on delete cascade,
  capsule_id text not null,
  recipient_fingerprint text not null,
  created_at timestamptz not null,
  primary key (account_id, capsule_id, recipient_fingerprint),
  constraint capsule_recipients_capsule_fkey
    foreign key (account_id, capsule_id)
    references public.capsules(account_id, capsule_id)
    on delete cascade,
  constraint capsule_recipients_fingerprint_check check (
    recipient_fingerprint ~ '^[0-9a-f]{64}$'
  )
);

create index capsule_recipients_account_fingerprint_idx
  on public.capsule_recipients(account_id, recipient_fingerprint, capsule_id);

create table public.capsule_request_nonces (
  account_id uuid not null references public.profiles(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete cascade,
  nonce text not null,
  request_timestamp timestamptz not null,
  accepted_at timestamptz not null,
  expires_at timestamptz not null,
  primary key (account_id, device_id, nonce),
  constraint capsule_request_nonces_nonce_check check (
    nonce ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'
  ),
  constraint capsule_request_nonces_timestamp_check check (
    request_timestamp >= accepted_at - interval '6 minutes'
    and request_timestamp <= accepted_at + interval '6 minutes'
  ),
  constraint capsule_request_nonces_expiry_check check (
    expires_at = accepted_at + interval '10 minutes'
  )
);

create index capsule_request_nonces_expiry_idx
  on public.capsule_request_nonces(expires_at, account_id, device_id);

alter table public.capsules enable row level security;
alter table public.capsule_recipients enable row level security;
alter table public.capsule_request_nonces enable row level security;

revoke all on public.capsules from public, anon, authenticated, service_role;
revoke all on public.capsule_recipients from public, anon, authenticated, service_role;
revoke all on public.capsule_request_nonces from public, anon, authenticated, service_role;
grant select on public.capsules to authenticated, service_role;
grant select on public.capsule_recipients to authenticated, service_role;

create policy "capsules_select_own"
  on public.capsules
  for select to authenticated
  using (
    (select public.current_account_id()) = account_id
    and exists (
      select 1 from public.account_entitlements
      where account_entitlements.account_id = capsules.account_id
        and account_entitlements.status = 'active'
        and account_entitlements.uploads_enabled = true
    )
  );

create policy "capsule_recipients_select_own"
  on public.capsule_recipients
  for select to authenticated
  using (
    (select public.current_account_id()) = account_id
    and exists (
      select 1 from public.account_entitlements
      where account_entitlements.account_id = capsule_recipients.account_id
        and account_entitlements.status = 'active'
        and account_entitlements.uploads_enabled = true
    )
  );

create function public.reserve_capsule(
  p_account_id uuid,
  p_actor_device_id uuid,
  p_capsule_id text,
  p_serialized_bytes bigint,
  p_serialized_sha256 text,
  p_outer_schema text,
  p_payload_schema text,
  p_transfer_schema text,
  p_sender_fingerprint text,
  p_recipient_fingerprints text[]
)
returns public.capsules
language plpgsql
security definer
set search_path = ''
as $$
declare
  request_time timestamptz := pg_catalog.clock_timestamp();
  entitlement public.account_entitlements%rowtype;
  usage_row public.account_usage%rowtype;
  existing public.capsules%rowtype;
  result public.capsules%rowtype;
  stored_recipients text[];
  requested_recipient_count integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'service_role required';
  end if;

  if p_capsule_id is null or p_capsule_id !~ '^[A-Za-z0-9_-]{21}[AQgw]$'
    or p_serialized_bytes is null or p_serialized_bytes < 1 or p_serialized_bytes > 67108864
    or p_serialized_sha256 is null or p_serialized_sha256 !~ '^[0-9a-f]{64}$'
    or p_sender_fingerprint is null or p_sender_fingerprint !~ '^[0-9a-f]{64}$'
    or p_outer_schema is null or char_length(p_outer_schema) not between 1 and 128
    or p_payload_schema is null or char_length(p_payload_schema) not between 1 and 128
    or p_transfer_schema is null or char_length(p_transfer_schema) not between 1 and 128
    or p_outer_schema !~ '^[a-z][a-z0-9.-]*\.v[0-9]+$'
    or p_payload_schema !~ '^[a-z][a-z0-9.-]*\.v[0-9]+$'
    or p_transfer_schema !~ '^[a-z][a-z0-9.-]*\.v[0-9]+$' then
    raise exception using errcode = '22023', message = 'invalid capsule reservation metadata';
  end if;

  requested_recipient_count := coalesce(pg_catalog.array_length(p_recipient_fingerprints, 1), 0);
  if requested_recipient_count not between 1 and 32
    or exists (
      select 1 from pg_catalog.unnest(p_recipient_fingerprints) as recipients(fingerprint)
      where fingerprint is null or fingerprint !~ '^[0-9a-f]{64}$'
    )
    or (select count(distinct fingerprint) from pg_catalog.unnest(p_recipient_fingerprints) as recipients(fingerprint))
      <> requested_recipient_count then
    raise exception using errcode = '22023', message = 'invalid capsule recipient set';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('capsule-account:' || p_account_id::text, 0)
  );

  select * into entitlement
  from public.account_entitlements
  where account_id = p_account_id
  for update;

  if not found or entitlement.status <> 'active' or entitlement.uploads_enabled <> true then
    raise exception using errcode = '42501', message = 'capsule uploads are not enabled';
  end if;

  select * into usage_row
  from public.account_usage
  where account_id = p_account_id
  for update;

  if not found then
    raise exception using errcode = '55000', message = 'account usage is missing';
  end if;

  select * into existing
  from public.capsules
  where account_id = p_account_id and capsule_id = p_capsule_id
  for update;

  if found then
    select coalesce(pg_catalog.array_agg(recipient_fingerprint order by recipient_fingerprint), array[]::text[])
      into stored_recipients
    from public.capsule_recipients
    where account_id = p_account_id and capsule_id = p_capsule_id;

    if existing.status = 'reserved'
      and request_time < existing.reservation_expires_at
      and existing.serialized_bytes = p_serialized_bytes
      and existing.serialized_sha256 = p_serialized_sha256
      and existing.outer_schema = p_outer_schema
      and existing.payload_schema = p_payload_schema
      and existing.transfer_schema = p_transfer_schema
      and existing.sender_fingerprint = p_sender_fingerprint
      and stored_recipients = (
        select pg_catalog.array_agg(fingerprint order by fingerprint)
        from pg_catalog.unnest(p_recipient_fingerprints) as recipients(fingerprint)
      ) then
      update public.capsules
      set reservation_refreshed_at = request_time,
          reservation_expires_at = request_time + interval '2 hours 15 minutes'
      where account_id = p_account_id and capsule_id = p_capsule_id
      returning * into existing;
      return existing;
    end if;

    raise exception using errcode = 'PT409', message = 'capsule_reservation_conflict';
  end if;

  if p_serialized_bytes > entitlement.capsule_size_limit_bytes then
    raise exception using errcode = 'PT409', message = 'capsule_size_quota_exceeded';
  end if;

  if not entitlement.unmetered and (
    usage_row.retained_storage_bytes + usage_row.reserved_storage_bytes + p_serialized_bytes
      > entitlement.storage_limit_bytes
    or usage_row.capsule_count + usage_row.reserved_capsule_count + 1
      > entitlement.session_limit
  ) then
    raise exception using errcode = 'PT409', message = 'capsule_account_quota_exceeded';
  end if;

  if not exists (
    select 1 from public.devices
    where id = p_actor_device_id
      and user_id = p_account_id
      and fingerprint = p_sender_fingerprint
      and key_suite is not null
      and approved_at is not null
      and revoked_at is null
  ) then
    raise exception using errcode = '42501', message = 'active sender device required';
  end if;

  if (
    select count(*)
    from public.devices
    where user_id = p_account_id
      and fingerprint = any(p_recipient_fingerprints)
      and key_suite is not null
      and approved_at is not null
      and revoked_at is null
  ) <> requested_recipient_count then
    raise exception using errcode = '42501', message = 'all recipient devices must be active';
  end if;

  insert into public.capsules (
    account_id,
    capsule_id,
    object_path,
    serialized_bytes,
    serialized_sha256,
    outer_schema,
    payload_schema,
    transfer_schema,
    sender_fingerprint,
    recipient_count,
    status,
    reserved_at,
    reservation_refreshed_at,
    reservation_expires_at
  ) values (
    p_account_id,
    p_capsule_id,
    p_account_id::text || '/' || p_capsule_id || '.capsule',
    p_serialized_bytes,
    p_serialized_sha256,
    p_outer_schema,
    p_payload_schema,
    p_transfer_schema,
    p_sender_fingerprint,
    requested_recipient_count,
    'reserved',
    request_time,
    request_time,
    request_time + interval '2 hours 15 minutes'
  ) returning * into result;

  insert into public.capsule_recipients(
    account_id,
    capsule_id,
    recipient_fingerprint,
    created_at
  )
  select p_account_id, p_capsule_id, fingerprint, request_time
  from pg_catalog.unnest(p_recipient_fingerprints) as recipients(fingerprint);

  update public.account_usage
  set reserved_storage_bytes = reserved_storage_bytes + p_serialized_bytes,
      reserved_capsule_count = reserved_capsule_count + 1,
      updated_at = request_time
  where account_id = p_account_id;

  return result;
end;
$$;

create function public.finalize_capsule(
  p_account_id uuid,
  p_actor_device_id uuid,
  p_capsule_id text,
  p_serialized_bytes bigint,
  p_serialized_sha256 text
)
returns public.capsules
language plpgsql
security definer
set search_path = ''
as $$
declare
  request_time timestamptz := pg_catalog.clock_timestamp();
  entitlement public.account_entitlements%rowtype;
  capsule_row public.capsules%rowtype;
  active_recipient_count integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'service_role required';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('capsule-account:' || p_account_id::text, 0)
  );

  select * into entitlement
  from public.account_entitlements
  where account_id = p_account_id
  for update;

  if not found or entitlement.status <> 'active' or entitlement.uploads_enabled <> true then
    raise exception using errcode = '42501', message = 'capsule uploads are not enabled';
  end if;

  perform 1 from public.account_usage where account_id = p_account_id for update;
  if not found then
    raise exception using errcode = '55000', message = 'account usage is missing';
  end if;

  select * into capsule_row
  from public.capsules
  where account_id = p_account_id and capsule_id = p_capsule_id
  for update;

  if not found then
    raise exception using errcode = 'PT409', message = 'capsule_reservation_not_found';
  end if;

  if capsule_row.serialized_bytes is distinct from p_serialized_bytes
    or capsule_row.serialized_sha256 is distinct from p_serialized_sha256 then
    raise exception using errcode = 'PT409', message = 'capsule_finalize_mismatch';
  end if;

  if capsule_row.status = 'retained' then
    return capsule_row;
  end if;

  if capsule_row.status <> 'reserved' or request_time >= capsule_row.reservation_expires_at then
    raise exception using errcode = 'PT409', message = 'capsule_reservation_not_finalizable';
  end if;

  if not exists (
    select 1 from public.devices
    where id = p_actor_device_id
      and user_id = p_account_id
      and fingerprint = capsule_row.sender_fingerprint
      and key_suite is not null
      and approved_at is not null
      and revoked_at is null
  ) then
    raise exception using errcode = '42501', message = 'active sender device required';
  end if;

  select count(*) into active_recipient_count
  from public.capsule_recipients as recipient
  join public.devices as device
    on device.user_id = recipient.account_id
   and device.fingerprint = recipient.recipient_fingerprint
  where recipient.account_id = p_account_id
    and recipient.capsule_id = p_capsule_id
    and device.key_suite is not null
    and device.approved_at is not null
    and device.revoked_at is null;

  if active_recipient_count <> capsule_row.recipient_count then
    raise exception using errcode = '42501', message = 'all recipient devices must be active';
  end if;

  update public.capsules
  set status = 'retained', finalized_at = request_time
  where account_id = p_account_id and capsule_id = p_capsule_id
  returning * into capsule_row;

  update public.account_usage
  set reserved_storage_bytes = reserved_storage_bytes - capsule_row.serialized_bytes,
      reserved_capsule_count = reserved_capsule_count - 1,
      retained_storage_bytes = retained_storage_bytes + capsule_row.serialized_bytes,
      capsule_count = capsule_count + 1,
      updated_at = request_time
  where account_id = p_account_id;

  return capsule_row;
end;
$$;

create function public.begin_capsule_delete(
  p_account_id uuid,
  p_actor_device_id uuid,
  p_capsule_id text
)
returns public.capsules
language plpgsql
security definer
set search_path = ''
as $$
declare
  request_time timestamptz := pg_catalog.clock_timestamp();
  capsule_row public.capsules%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'service_role required';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('capsule-account:' || p_account_id::text, 0)
  );

  perform 1 from public.account_usage where account_id = p_account_id for update;
  if not found then
    raise exception using errcode = '55000', message = 'account usage is missing';
  end if;

  if not exists (
    select 1 from public.devices
    where id = p_actor_device_id
      and user_id = p_account_id
      and key_suite is not null
      and approved_at is not null
      and revoked_at is null
  ) then
    raise exception using errcode = '42501', message = 'active account device required';
  end if;

  select * into capsule_row
  from public.capsules
  where account_id = p_account_id and capsule_id = p_capsule_id
  for update;

  if not found then
    raise exception using errcode = 'PT409', message = 'capsule_not_found';
  end if;

  if capsule_row.status in ('delete_pending', 'deleted') then
    return capsule_row;
  end if;

  if capsule_row.status <> 'retained' then
    raise exception using errcode = 'PT409', message = 'capsule_not_deletable';
  end if;

  update public.capsules
  set status = 'delete_pending', deletion_requested_at = request_time
  where account_id = p_account_id and capsule_id = p_capsule_id
  returning * into capsule_row;

  return capsule_row;
end;
$$;

create function public.finalize_capsule_delete(
  p_account_id uuid,
  p_actor_device_id uuid,
  p_capsule_id text,
  p_serialized_bytes bigint,
  p_serialized_sha256 text
)
returns public.capsules
language plpgsql
security definer
set search_path = ''
as $$
declare
  request_time timestamptz := pg_catalog.clock_timestamp();
  capsule_row public.capsules%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'service_role required';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('capsule-account:' || p_account_id::text, 0)
  );
  perform 1 from public.account_usage where account_id = p_account_id for update;
  if not found then
    raise exception using errcode = '55000', message = 'account usage is missing';
  end if;

  if not exists (
    select 1 from public.devices
    where id = p_actor_device_id
      and user_id = p_account_id
      and key_suite is not null
      and approved_at is not null
      and revoked_at is null
  ) then
    raise exception using errcode = '42501', message = 'active account device required';
  end if;

  select * into capsule_row
  from public.capsules
  where account_id = p_account_id and capsule_id = p_capsule_id
  for update;

  if not found then
    raise exception using errcode = 'PT409', message = 'capsule_not_found';
  end if;

  if capsule_row.serialized_bytes is distinct from p_serialized_bytes
    or capsule_row.serialized_sha256 is distinct from p_serialized_sha256 then
    raise exception using errcode = 'PT409', message = 'capsule_delete_mismatch';
  end if;

  if capsule_row.status = 'deleted' then
    return capsule_row;
  end if;

  if capsule_row.status <> 'delete_pending' then
    raise exception using errcode = 'PT409', message = 'capsule_delete_not_pending';
  end if;

  update public.capsules
  set status = 'deleted', storage_deleted_at = request_time
  where account_id = p_account_id and capsule_id = p_capsule_id
  returning * into capsule_row;

  update public.account_usage
  set retained_storage_bytes = retained_storage_bytes - capsule_row.serialized_bytes,
      capsule_count = capsule_count - 1,
      updated_at = request_time
  where account_id = p_account_id;

  return capsule_row;
end;
$$;

create function public.expire_capsule_reservations(p_limit integer default 100)
returns setof public.capsules
language plpgsql
security definer
set search_path = ''
as $$
declare
  request_time timestamptz := pg_catalog.clock_timestamp();
  candidate record;
  capsule_row public.capsules%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'service_role required';
  end if;

  if p_limit is null or p_limit not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'expiry limit must be between 1 and 1000';
  end if;

  for candidate in
    select account_id, capsule_id
    from public.capsules
    where status = 'reserved' and reservation_expires_at <= request_time
    order by reservation_expires_at, account_id, capsule_id
    limit p_limit
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('capsule-account:' || candidate.account_id::text, 0)
    );
    perform 1 from public.account_usage where account_id = candidate.account_id for update;
    if not found then
      raise exception using errcode = '55000', message = 'account usage is missing';
    end if;

    select * into capsule_row
    from public.capsules
    where account_id = candidate.account_id
      and capsule_id = candidate.capsule_id
    for update;

    if found and capsule_row.status = 'reserved'
      and capsule_row.reservation_expires_at <= request_time then
      update public.capsules
      set status = 'expiry_pending', expiry_requested_at = request_time
      where account_id = capsule_row.account_id and capsule_id = capsule_row.capsule_id;
    end if;
  end loop;

  return query
  select capsule.*
  from public.capsules as capsule
  where capsule.status = 'expiry_pending'
  order by capsule.expiry_requested_at, capsule.account_id, capsule.capsule_id
  limit p_limit;
end;
$$;

create function public.finalize_capsule_reservation_expiry(
  p_account_id uuid,
  p_capsule_id text,
  p_serialized_bytes bigint,
  p_serialized_sha256 text
)
returns public.capsules
language plpgsql
security definer
set search_path = ''
as $$
declare
  request_time timestamptz := pg_catalog.clock_timestamp();
  capsule_row public.capsules%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'service_role required';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('capsule-account:' || p_account_id::text, 0)
  );
  perform 1 from public.account_usage where account_id = p_account_id for update;
  if not found then
    raise exception using errcode = '55000', message = 'account usage is missing';
  end if;

  select * into capsule_row
  from public.capsules
  where account_id = p_account_id and capsule_id = p_capsule_id
  for update;

  if not found then
    raise exception using errcode = 'PT409', message = 'capsule_reservation_not_found';
  end if;

  if capsule_row.serialized_bytes is distinct from p_serialized_bytes
    or capsule_row.serialized_sha256 is distinct from p_serialized_sha256 then
    raise exception using errcode = 'PT409', message = 'capsule_expiry_mismatch';
  end if;

  if capsule_row.status = 'expired' then
    return capsule_row;
  end if;

  if capsule_row.status <> 'expiry_pending' then
    raise exception using errcode = 'PT409', message = 'capsule_expiry_not_pending';
  end if;

  update public.capsules
  set status = 'expired',
      storage_cleanup_completed_at = request_time,
      expired_at = request_time
  where account_id = p_account_id and capsule_id = p_capsule_id
  returning * into capsule_row;

  update public.account_usage
  set reserved_storage_bytes = reserved_storage_bytes - capsule_row.serialized_bytes,
      reserved_capsule_count = reserved_capsule_count - 1,
      updated_at = request_time
  where account_id = p_account_id;

  return capsule_row;
end;
$$;

create function public.authorize_capsule_read(
  p_account_id uuid,
  p_device_id uuid
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

  if not exists (
    select 1
    from public.account_entitlements
    where account_id = p_account_id
      and status = 'active'
      and uploads_enabled = true
  ) then
    raise exception using errcode = '42501', message = 'capsule reads are not enabled';
  end if;

  if not exists (
    select 1
    from public.devices
    where id = p_device_id
      and user_id = p_account_id
      and key_suite is not null
      and approved_at is not null
      and revoked_at is null
  ) then
    raise exception using errcode = '42501', message = 'active account device required';
  end if;

  return true;
end;
$$;

create function public.claim_capsule_request_nonce(
  p_account_id uuid,
  p_device_id uuid,
  p_nonce text,
  p_request_timestamp timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  accepted_time timestamptz := pg_catalog.clock_timestamp();
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'service_role required';
  end if;

  if p_nonce is null or p_nonce !~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'
    or p_request_timestamp is null
    or p_request_timestamp < accepted_time - interval '6 minutes'
    or p_request_timestamp > accepted_time + interval '6 minutes' then
    raise exception using errcode = '22023', message = 'invalid capsule request nonce or timestamp';
  end if;

  perform 1 from public.devices
  where id = p_device_id
    and user_id = p_account_id
    and key_suite is not null
    and approved_at is not null
    and revoked_at is null
  for share;

  if not found then
    raise exception using errcode = '42501', message = 'active account device required';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'capsule-request:' || p_account_id::text || ':' || p_device_id::text || ':' || p_nonce,
      0
    )
  );

  if exists (
    select 1 from public.capsule_request_nonces
    where account_id = p_account_id
      and device_id = p_device_id
      and nonce = p_nonce
  ) then
    raise exception using errcode = 'PT409', message = 'capsule_request_replay';
  end if;

  insert into public.capsule_request_nonces(
    account_id,
    device_id,
    nonce,
    request_timestamp,
    accepted_at,
    expires_at
  ) values (
    p_account_id,
    p_device_id,
    p_nonce,
    p_request_timestamp,
    accepted_time,
    accepted_time + interval '10 minutes'
  );

  return true;
end;
$$;

create function public.expire_capsule_request_nonces(p_limit integer default 1000)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_count integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'service_role required';
  end if;

  if p_limit is null or p_limit not between 1 and 10000 then
    raise exception using errcode = '22023', message = 'nonce expiry limit must be between 1 and 10000';
  end if;

  with expired as (
    select account_id, device_id, nonce
    from public.capsule_request_nonces
    where expires_at <= pg_catalog.clock_timestamp()
    order by expires_at, account_id, device_id, nonce
    limit p_limit
    for update skip locked
  )
  delete from public.capsule_request_nonces as nonce
  using expired
  where nonce.account_id = expired.account_id
    and nonce.device_id = expired.device_id
    and nonce.nonce = expired.nonce;

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function public.reserve_capsule(uuid, uuid, text, bigint, text, text, text, text, text, text[])
  from public, anon, authenticated;
grant execute on function public.reserve_capsule(uuid, uuid, text, bigint, text, text, text, text, text, text[])
  to service_role;

revoke all on function public.finalize_capsule(uuid, uuid, text, bigint, text)
  from public, anon, authenticated;
grant execute on function public.finalize_capsule(uuid, uuid, text, bigint, text)
  to service_role;

revoke all on function public.begin_capsule_delete(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.begin_capsule_delete(uuid, uuid, text)
  to service_role;

revoke all on function public.finalize_capsule_delete(uuid, uuid, text, bigint, text)
  from public, anon, authenticated;
grant execute on function public.finalize_capsule_delete(uuid, uuid, text, bigint, text)
  to service_role;

revoke all on function public.expire_capsule_reservations(integer)
  from public, anon, authenticated;
grant execute on function public.expire_capsule_reservations(integer)
  to service_role;

revoke all on function public.finalize_capsule_reservation_expiry(uuid, text, bigint, text)
  from public, anon, authenticated;
grant execute on function public.finalize_capsule_reservation_expiry(uuid, text, bigint, text)
  to service_role;

revoke all on function public.authorize_capsule_read(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.authorize_capsule_read(uuid, uuid)
  to service_role;

revoke all on function public.claim_capsule_request_nonce(uuid, uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.claim_capsule_request_nonce(uuid, uuid, text, timestamptz)
  to service_role;

revoke all on function public.expire_capsule_request_nonces(integer)
  from public, anon, authenticated;
grant execute on function public.expire_capsule_request_nonces(integer)
  to service_role;

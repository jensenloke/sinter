-- Durable, provider-neutral device identity and approval.
--
-- Public keys use the RFC 7638 canonical JSON representation for a P-256
-- public JWK (exact member order, no whitespace, and no private `d` member).
-- A device fingerprint is the lowercase hexadecimal SHA-256 digest of the
-- canonical encryption-and-signing public identity JSON.

alter table public.devices
  rename column public_key to encryption_public_key;

alter table public.devices
  drop constraint if exists devices_public_key_check;

alter table public.devices
  add column signing_public_key text,
  add column key_suite text,
  add column fingerprint text,
  add column approval_method text,
  add column approved_at timestamptz,
  add column approved_by_device_id uuid,
  add column approval_signature text;

alter table public.devices
  add constraint devices_approved_by_device_id_fkey
    foreign key (approved_by_device_id) references public.devices(id)
    deferrable initially deferred,
  add constraint devices_encryption_public_key_jwk_check check (
    key_suite is null
    or encryption_public_key ~ '^\{"crv":"P-256","kty":"EC","x":"[A-Za-z0-9_-]{43}","y":"[A-Za-z0-9_-]{43}"\}$'
  ) not valid,
  add constraint devices_identity_complete_check check (
    (
      key_suite is null
      and signing_public_key is null
      and fingerprint is null
      and approval_method is null
      and approved_at is null
      and approved_by_device_id is null
      and approval_signature is null
    )
    or
    (
      key_suite = 'hpke-p256-hkdf-sha256-aes256gcm+ecdsa-p256-sha256'
      and signing_public_key ~ '^\{"crv":"P-256","kty":"EC","x":"[A-Za-z0-9_-]{43}","y":"[A-Za-z0-9_-]{43}"\}$'
      and fingerprint ~ '^[0-9a-f]{64}$'
      and fingerprint = pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(
          '{"encryptionPublicKey":' || encryption_public_key
          || ',"signingPublicKey":' || signing_public_key || '}',
          'UTF8'
        )),
        'hex'
      )
      and approval_method in ('bootstrap', 'device')
      and approved_at is not null
      and (
        (
          approval_method = 'bootstrap'
          and approved_by_device_id is null
          and approval_signature is null
        )
        or
        (
          approval_method = 'device'
          and approved_by_device_id is not null
          and approval_signature is not null
          and char_length(approval_signature) between 16 and 8192
        )
      )
    )
  ) not valid,
  add constraint devices_revoked_after_creation_check check (
    revoked_at is null or revoked_at >= created_at
  ) not valid;

create unique index devices_active_fingerprint_idx
  on public.devices(fingerprint)
  where fingerprint is not null and revoked_at is null;

create index devices_account_active_idx
  on public.devices(user_id, created_at)
  where revoked_at is null;

create table public.device_enrollment_requests (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.profiles(id) on delete cascade,
  requested_name text not null check (char_length(requested_name) between 1 and 80),
  encryption_public_key text not null,
  signing_public_key text not null,
  key_suite text not null,
  fingerprint text not null,
  possession_proof text not null check (char_length(possession_proof) between 16 and 8192),
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  approved_at timestamptz,
  approved_by_device_id uuid,
  approval_signature text,
  claimed_at timestamptz,
  device_id uuid,
  expired_at timestamptz,
  constraint device_enrollment_requests_encryption_jwk_check check (
    encryption_public_key ~ '^\{"crv":"P-256","kty":"EC","x":"[A-Za-z0-9_-]{43}","y":"[A-Za-z0-9_-]{43}"\}$'
  ),
  constraint device_enrollment_requests_signing_jwk_check check (
    signing_public_key ~ '^\{"crv":"P-256","kty":"EC","x":"[A-Za-z0-9_-]{43}","y":"[A-Za-z0-9_-]{43}"\}$'
  ),
  constraint device_enrollment_requests_suite_check check (
    key_suite = 'hpke-p256-hkdf-sha256-aes256gcm+ecdsa-p256-sha256'
  ),
  constraint device_enrollment_requests_fingerprint_check check (
    fingerprint ~ '^[0-9a-f]{64}$'
    and fingerprint = pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(
        '{"encryptionPublicKey":' || encryption_public_key
        || ',"signingPublicKey":' || signing_public_key || '}',
        'UTF8'
      )),
      'hex'
    )
  ),
  constraint device_enrollment_requests_expiry_check check (
    expires_at > created_at
    and expires_at <= created_at + interval '15 minutes'
  ),
  constraint device_enrollment_requests_state_check check (
    (
      status = 'pending'
      and approved_at is null
      and approved_by_device_id is null
      and approval_signature is null
      and claimed_at is null
      and device_id is null
      and expired_at is null
    )
    or
    (
      status = 'approved'
      and approved_at is not null
      and approved_by_device_id is not null
      and approval_signature is not null
      and char_length(approval_signature) between 16 and 8192
      and claimed_at is null
      and device_id is null
      and expired_at is null
    )
    or
    (
      status = 'claimed'
      and approved_at is not null
      and approved_by_device_id is not null
      and approval_signature is not null
      and char_length(approval_signature) between 16 and 8192
      and claimed_at is not null
      and device_id is not null
      and expired_at is null
    )
    or
    (
      status = 'expired'
      and claimed_at is null
      and device_id is null
      and expired_at is not null
      and (
        (
          approved_at is null
          and approved_by_device_id is null
          and approval_signature is null
        )
        or
        (
          approved_at is not null
          and approved_by_device_id is not null
          and approval_signature is not null
          and char_length(approval_signature) between 16 and 8192
        )
      )
    )
  ),
  constraint device_enrollment_requests_approval_time_check check (
    approved_at is null
    or (approved_at >= created_at and approved_at < expires_at)
  ),
  constraint device_enrollment_requests_claim_time_check check (
    claimed_at is null
    or (
      approved_at is not null
      and claimed_at >= approved_at
      and claimed_at < expires_at
    )
  ),
  constraint device_enrollment_requests_expired_time_check check (
    expired_at is null or expired_at >= expires_at
  ),
  constraint device_enrollment_requests_approver_fkey
    foreign key (approved_by_device_id) references public.devices(id)
    deferrable initially deferred,
  constraint device_enrollment_requests_device_fkey
    foreign key (device_id) references public.devices(id)
    deferrable initially deferred
);

create unique index device_enrollment_requests_active_fingerprint_idx
  on public.device_enrollment_requests(fingerprint)
  where status in ('pending', 'approved');

create index device_enrollment_requests_account_created_idx
  on public.device_enrollment_requests(account_id, created_at desc);

create index device_enrollment_requests_expiry_idx
  on public.device_enrollment_requests(expires_at)
  where status in ('pending', 'approved');

alter table public.device_enrollment_requests enable row level security;

revoke all on public.device_enrollment_requests
  from public, anon, authenticated, service_role;
grant select on public.device_enrollment_requests to authenticated, service_role;

create policy "device_enrollment_requests_select_own"
  on public.device_enrollment_requests
  for select to authenticated
  using ((select public.current_account_id()) = account_id);

-- Replace the former broad device grants and mutation policies. Authenticated
-- callers can see their account's devices and can only rename or monotonically
-- revoke them. Device creation and identity/approval fields are service RPCs.
drop policy if exists "devices_insert_own" on public.devices;
drop policy if exists "devices_update_own" on public.devices;
drop policy if exists "devices_delete_own" on public.devices;

create policy "devices_update_safe_own" on public.devices
  for update to authenticated
  using ((select public.current_account_id()) = user_id)
  with check ((select public.current_account_id()) = user_id);

revoke all on public.devices from anon, authenticated, service_role;
grant select on public.devices to authenticated, service_role;
grant update (name, revoked_at) on public.devices to authenticated, service_role;

create function public.enforce_device_identity_immutability()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
    or new.user_id is distinct from old.user_id
    or new.encryption_public_key is distinct from old.encryption_public_key
    or new.signing_public_key is distinct from old.signing_public_key
    or new.key_suite is distinct from old.key_suite
    or new.fingerprint is distinct from old.fingerprint
    or new.key_version is distinct from old.key_version
    or new.created_at is distinct from old.created_at
    or new.approval_method is distinct from old.approval_method
    or new.approved_at is distinct from old.approved_at
    or new.approved_by_device_id is distinct from old.approved_by_device_id
    or new.approval_signature is distinct from old.approval_signature then
    raise exception using
      errcode = '42501',
      message = 'device identity and approval fields are immutable';
  end if;

  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception using
      errcode = '55000',
      message = 'device revocation is irreversible';
  end if;

  if new.revoked_at is not null
    and new.revoked_at > pg_catalog.clock_timestamp() then
    raise exception using
      errcode = '22023',
      message = 'device revocation cannot be future-dated';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_device_identity_immutability()
  from public, anon, authenticated, service_role;

create trigger devices_enforce_identity_immutability
  before update on public.devices
  for each row execute function public.enforce_device_identity_immutability();

create function public.bootstrap_device(
  p_account_id uuid,
  p_name text,
  p_encryption_public_key text,
  p_signing_public_key text,
  p_key_suite text,
  p_fingerprint text
)
returns public.devices
language plpgsql
security definer
set search_path = ''
as $$
declare
  result public.devices%rowtype;
  expected_fingerprint text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'service_role required';
  end if;

  if p_key_suite is distinct from 'hpke-p256-hkdf-sha256-aes256gcm+ecdsa-p256-sha256'
    or p_encryption_public_key is null
    or p_encryption_public_key !~ '^\{"crv":"P-256","kty":"EC","x":"[A-Za-z0-9_-]{43}","y":"[A-Za-z0-9_-]{43}"\}$'
    or p_signing_public_key is null
    or p_signing_public_key !~ '^\{"crv":"P-256","kty":"EC","x":"[A-Za-z0-9_-]{43}","y":"[A-Za-z0-9_-]{43}"\}$' then
    raise exception using errcode = '22023', message = 'invalid device key suite or public JWK';
  end if;

  expected_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      '{"encryptionPublicKey":' || p_encryption_public_key
      || ',"signingPublicKey":' || p_signing_public_key || '}',
      'UTF8'
    )),
    'hex'
  );
  if p_fingerprint is distinct from expected_fingerprint then
    raise exception using errcode = '22023', message = 'invalid device public-key fingerprint';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('device-account:' || p_account_id::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('device-fingerprint:' || p_fingerprint, 0)
  );

  if not exists (select 1 from public.profiles where id = p_account_id) then
    raise exception using errcode = '22023', message = 'account does not exist';
  end if;

  if exists (select 1 from public.devices where user_id = p_account_id) then
    raise exception using errcode = '55000', message = 'account has already bootstrapped device identity';
  end if;

  if exists (
    select 1 from public.devices
    where fingerprint = p_fingerprint and revoked_at is null
  ) or exists (
    select 1 from public.device_enrollment_requests
    where fingerprint = p_fingerprint and status in ('pending', 'approved')
  ) then
    raise exception using errcode = '23505', message = 'active device fingerprint already exists';
  end if;

  insert into public.devices (
    user_id,
    name,
    encryption_public_key,
    signing_public_key,
    key_suite,
    fingerprint,
    approval_method,
    approved_at
  ) values (
    p_account_id,
    p_name,
    p_encryption_public_key,
    p_signing_public_key,
    p_key_suite,
    p_fingerprint,
    'bootstrap',
    pg_catalog.now()
  ) returning * into result;

  return result;
end;
$$;

revoke all on function public.bootstrap_device(uuid, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.bootstrap_device(uuid, text, text, text, text, text)
  to service_role;

create function public.create_device_enrollment_request(
  p_account_id uuid,
  p_requested_name text,
  p_encryption_public_key text,
  p_signing_public_key text,
  p_key_suite text,
  p_fingerprint text,
  p_possession_proof text,
  p_expires_at timestamptz
)
returns public.device_enrollment_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  result public.device_enrollment_requests%rowtype;
  expected_fingerprint text;
  request_time timestamptz := pg_catalog.clock_timestamp();
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'service_role required';
  end if;

  if p_key_suite is distinct from 'hpke-p256-hkdf-sha256-aes256gcm+ecdsa-p256-sha256'
    or p_encryption_public_key is null
    or p_encryption_public_key !~ '^\{"crv":"P-256","kty":"EC","x":"[A-Za-z0-9_-]{43}","y":"[A-Za-z0-9_-]{43}"\}$'
    or p_signing_public_key is null
    or p_signing_public_key !~ '^\{"crv":"P-256","kty":"EC","x":"[A-Za-z0-9_-]{43}","y":"[A-Za-z0-9_-]{43}"\}$' then
    raise exception using errcode = '22023', message = 'invalid device key suite or public JWK';
  end if;

  expected_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      '{"encryptionPublicKey":' || p_encryption_public_key
      || ',"signingPublicKey":' || p_signing_public_key || '}',
      'UTF8'
    )),
    'hex'
  );
  if p_fingerprint is distinct from expected_fingerprint then
    raise exception using errcode = '22023', message = 'invalid device public-key fingerprint';
  end if;

  if p_expires_at is null
    or p_expires_at <= request_time
    or p_expires_at > request_time + interval '15 minutes' then
    raise exception using errcode = '22023', message = 'enrollment expiry must be within the next 15 minutes';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('device-fingerprint:' || p_fingerprint, 0)
  );

  if not exists (select 1 from public.profiles where id = p_account_id) then
    raise exception using errcode = '22023', message = 'account does not exist';
  end if;

  if not exists (
    select 1 from public.devices
    where user_id = p_account_id
      and key_suite is not null
      and approved_at is not null
      and revoked_at is null
  ) then
    raise exception using errcode = '55000', message = 'account has no active approving device';
  end if;

  update public.device_enrollment_requests
  set status = 'expired', expired_at = request_time
  where fingerprint = p_fingerprint
    and status in ('pending', 'approved')
    and expires_at <= request_time;

  if exists (
    select 1 from public.devices
    where fingerprint = p_fingerprint and revoked_at is null
  ) or exists (
    select 1 from public.device_enrollment_requests
    where fingerprint = p_fingerprint and status in ('pending', 'approved')
  ) then
    raise exception using errcode = '23505', message = 'active device fingerprint already exists';
  end if;

  insert into public.device_enrollment_requests (
    account_id,
    requested_name,
    encryption_public_key,
    signing_public_key,
    key_suite,
    fingerprint,
    possession_proof,
    created_at,
    expires_at
  ) values (
    p_account_id,
    p_requested_name,
    p_encryption_public_key,
    p_signing_public_key,
    p_key_suite,
    p_fingerprint,
    p_possession_proof,
    request_time,
    p_expires_at
  ) returning * into result;

  return result;
end;
$$;

revoke all on function public.create_device_enrollment_request(uuid, text, text, text, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.create_device_enrollment_request(uuid, text, text, text, text, text, text, timestamptz)
  to service_role;

create function public.approve_device_enrollment_request(
  p_request_id uuid,
  p_approving_device_id uuid,
  p_approval_signature text
)
returns public.device_enrollment_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  request_row public.device_enrollment_requests%rowtype;
  approval_time timestamptz := pg_catalog.clock_timestamp();
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'service_role required';
  end if;

  select * into request_row
  from public.device_enrollment_requests
  where id = p_request_id
  for update;

  if not found then
    raise exception using errcode = '22023', message = 'enrollment request does not exist';
  end if;

  if request_row.status = 'expired' or approval_time >= request_row.expires_at then
    raise exception using errcode = '55000', message = 'enrollment request is stale';
  end if;

  if request_row.status in ('approved', 'claimed') then
    if request_row.approved_by_device_id = p_approving_device_id
      and request_row.approval_signature = p_approval_signature then
      return request_row;
    end if;
    raise exception using errcode = '55000', message = 'enrollment approval replay does not match';
  end if;

  if request_row.status <> 'pending' then
    raise exception using errcode = '55000', message = 'enrollment request is not pending';
  end if;

  if p_approval_signature is null
    or char_length(p_approval_signature) not between 16 and 8192 then
    raise exception using errcode = '22023', message = 'invalid approval signature';
  end if;

  if not exists (
    select 1 from public.devices
    where id = p_approving_device_id
      and user_id = request_row.account_id
      and key_suite is not null
      and approved_at is not null
      and revoked_at is null
  ) then
    raise exception using errcode = '55000', message = 'approving device is not active for this account';
  end if;

  update public.device_enrollment_requests
  set status = 'approved',
      approved_at = approval_time,
      approved_by_device_id = p_approving_device_id,
      approval_signature = p_approval_signature
  where id = p_request_id
  returning * into request_row;

  return request_row;
end;
$$;

revoke all on function public.approve_device_enrollment_request(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.approve_device_enrollment_request(uuid, uuid, text)
  to service_role;

create function public.complete_device_enrollment_request(p_request_id uuid)
returns public.devices
language plpgsql
security definer
set search_path = ''
as $$
declare
  request_row public.device_enrollment_requests%rowtype;
  result public.devices%rowtype;
  claim_time timestamptz := pg_catalog.clock_timestamp();
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'service_role required';
  end if;

  select * into request_row
  from public.device_enrollment_requests
  where id = p_request_id
  for update;

  if not found then
    raise exception using errcode = '22023', message = 'enrollment request does not exist';
  end if;

  if request_row.status = 'claimed' then
    select * into result from public.devices where id = request_row.device_id;
    if not found then
      raise exception using errcode = '55000', message = 'claimed enrollment device is missing';
    end if;
    return result;
  end if;

  if request_row.status <> 'approved' or claim_time >= request_row.expires_at then
    raise exception using errcode = '55000', message = 'enrollment request is not claimable';
  end if;

  if not exists (
    select 1 from public.devices
    where id = request_row.approved_by_device_id
      and user_id = request_row.account_id
      and key_suite is not null
      and approved_at is not null
      and revoked_at is null
  ) then
    raise exception using errcode = '55000', message = 'approving device is no longer active';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('device-fingerprint:' || request_row.fingerprint, 0)
  );

  if exists (
    select 1 from public.devices
    where fingerprint = request_row.fingerprint and revoked_at is null
  ) then
    raise exception using errcode = '23505', message = 'active device fingerprint already exists';
  end if;

  insert into public.devices (
    user_id,
    name,
    encryption_public_key,
    signing_public_key,
    key_suite,
    fingerprint,
    approval_method,
    approved_at,
    approved_by_device_id,
    approval_signature
  ) values (
    request_row.account_id,
    request_row.requested_name,
    request_row.encryption_public_key,
    request_row.signing_public_key,
    request_row.key_suite,
    request_row.fingerprint,
    'device',
    request_row.approved_at,
    request_row.approved_by_device_id,
    request_row.approval_signature
  ) returning * into result;

  update public.device_enrollment_requests
  set status = 'claimed',
      claimed_at = claim_time,
      device_id = result.id
  where id = p_request_id;

  return result;
end;
$$;

revoke all on function public.complete_device_enrollment_request(uuid)
  from public, anon, authenticated;
grant execute on function public.complete_device_enrollment_request(uuid)
  to service_role;

create function public.expire_device_enrollment_requests(p_limit integer default 1000)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  expired_count integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'service_role required';
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 10000 then
    raise exception using errcode = '22023', message = 'expiry batch limit must be between 1 and 10000';
  end if;

  with expired_requests as (
    select id
    from public.device_enrollment_requests
    where status in ('pending', 'approved')
      and expires_at <= pg_catalog.clock_timestamp()
    order by expires_at
    limit p_limit
    for update skip locked
  )
  update public.device_enrollment_requests as request
  set status = 'expired', expired_at = pg_catalog.clock_timestamp()
  from expired_requests
  where request.id = expired_requests.id;

  get diagnostics expired_count = row_count;
  return expired_count;
end;
$$;

revoke all on function public.expire_device_enrollment_requests(integer)
  from public, anon, authenticated;
grant execute on function public.expire_device_enrollment_requests(integer)
  to service_role;

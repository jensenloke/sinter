-- Phase 1 hardening: encryption and signing identities must use distinct
-- canonical P-256 public-key text. The already-deployed device identity
-- migration remains unchanged, and legacy rows without a key suite remain
-- compatible.

alter table public.devices
  add constraint devices_distinct_canonical_public_keys_check check (
    key_suite is null
    or (
      encryption_public_key is not null
      and signing_public_key is not null
      and encryption_public_key <> signing_public_key
    )
  ) not valid;

alter table public.device_enrollment_requests
  add constraint device_enrollment_requests_distinct_public_keys_check check (
    encryption_public_key <> signing_public_key
  ) not valid;

-- New writes are protected immediately. Validation must also succeed for every
-- existing row; an anomaly aborts deployment instead of leaving a hidden
-- unvalidated constraint.
alter table public.devices
  validate constraint devices_distinct_canonical_public_keys_check;

alter table public.device_enrollment_requests
  validate constraint device_enrollment_requests_distinct_public_keys_check;

begin;
select plan(14);

-- Synthetic public points and expected fingerprints come from
-- packages/core/test/capsule-vector.json. They are not real device keys.
select ok(
  exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.devices'::regclass
      and conname = 'devices_distinct_canonical_public_keys_check'
      and contype = 'c'
  ),
  'Devices have a distinct canonical public-key check'
);
select ok(
  (select convalidated
   from pg_catalog.pg_constraint
   where conrelid = 'public.devices'::regclass
     and conname = 'devices_distinct_canonical_public_keys_check'),
  'The device distinct-key check validates on a safe existing dataset'
);
select ok(
  exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.device_enrollment_requests'::regclass
      and conname = 'device_enrollment_requests_distinct_public_keys_check'
      and contype = 'c'
  ),
  'Enrollment requests have a distinct canonical public-key check'
);
select ok(
  (select convalidated
   from pg_catalog.pg_constraint
   where conrelid = 'public.device_enrollment_requests'::regclass
     and conname = 'device_enrollment_requests_distinct_public_keys_check'),
  'The enrollment distinct-key check validates on a safe existing dataset'
);

insert into public.profiles (id, email)
values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'distinct-keys@example.test');

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.bootstrap_device(
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    'Same-key bootstrap',
    '{"crv":"P-256","kty":"EC","x":"49pxiy77_9MJD0KXUVHBhCnIBx8UkYM20ckoBf2LL78","y":"Mj_WFEsqP5tJKIY1CUqgbX5FcAB_zH8fmyOMoZii1eE"}',
    '{"crv":"P-256","kty":"EC","x":"49pxiy77_9MJD0KXUVHBhCnIBx8UkYM20ckoBf2LL78","y":"Mj_WFEsqP5tJKIY1CUqgbX5FcAB_zH8fmyOMoZii1eE"}',
    'hpke-p256-hkdf-sha256-aes256gcm+ecdsa-p256-sha256',
    'ac5461ac7eeb06e9276bc357e80f361c157deb216a46b3619d9965a7e6a12478'
  )$$,
  '23514',
  null,
  'Service bootstrap rejects one public point reused for both purposes'
);
reset role;

select is(
  (select count(*)::integer from public.devices where user_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
  0,
  'Rejected same-key bootstrap writes no device'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $$select public.bootstrap_device(
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    'Distinct-key bootstrap',
    '{"crv":"P-256","kty":"EC","x":"49pxiy77_9MJD0KXUVHBhCnIBx8UkYM20ckoBf2LL78","y":"Mj_WFEsqP5tJKIY1CUqgbX5FcAB_zH8fmyOMoZii1eE"}',
    '{"crv":"P-256","kty":"EC","x":"r9XYRZ-tq5_2vmZFcQjvZ-L9iv7kotKVKg0DLOKGUlA","y":"LMxQRdEY6sxsKQSMOsKlE28UPSAS5S9ZVCbcScDBtho"}',
    'hpke-p256-hkdf-sha256-aes256gcm+ecdsa-p256-sha256',
    '2f0d1d031afb81d92c0e36a6a2b6ceaecfe3273bdbc31307d75ca89e140a7ef5'
  )$$,
  'Service bootstrap still accepts distinct synthetic public points'
);
select throws_ok(
  $$select public.create_device_enrollment_request(
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    'Same-key enrollment',
    '{"crv":"P-256","kty":"EC","x":"49pxiy77_9MJD0KXUVHBhCnIBx8UkYM20ckoBf2LL78","y":"Mj_WFEsqP5tJKIY1CUqgbX5FcAB_zH8fmyOMoZii1eE"}',
    '{"crv":"P-256","kty":"EC","x":"49pxiy77_9MJD0KXUVHBhCnIBx8UkYM20ckoBf2LL78","y":"Mj_WFEsqP5tJKIY1CUqgbX5FcAB_zH8fmyOMoZii1eE"}',
    'hpke-p256-hkdf-sha256-aes256gcm+ecdsa-p256-sha256',
    'ac5461ac7eeb06e9276bc357e80f361c157deb216a46b3619d9965a7e6a12478',
    'synthetic-possession-proof-same-key',
    clock_timestamp() + interval '10 minutes'
  )$$,
  '23514',
  null,
  'Service enrollment rejects one public point reused for both purposes'
);
reset role;

select is(
  (select count(*)::integer from public.device_enrollment_requests where account_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
  0,
  'Rejected same-key enrollment writes no request'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $$select public.create_device_enrollment_request(
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    'Distinct-key enrollment',
    '{"crv":"P-256","kty":"EC","x":"r9XYRZ-tq5_2vmZFcQjvZ-L9iv7kotKVKg0DLOKGUlA","y":"LMxQRdEY6sxsKQSMOsKlE28UPSAS5S9ZVCbcScDBtho"}',
    '{"crv":"P-256","kty":"EC","x":"49pxiy77_9MJD0KXUVHBhCnIBx8UkYM20ckoBf2LL78","y":"Mj_WFEsqP5tJKIY1CUqgbX5FcAB_zH8fmyOMoZii1eE"}',
    'hpke-p256-hkdf-sha256-aes256gcm+ecdsa-p256-sha256',
    '5a34f062c87f1efc1d89ff6c0477f3c3b54e3711425f3108d29dc9d589d0d5b1',
    'synthetic-possession-proof-distinct',
    clock_timestamp() + interval '10 minutes'
  )$$,
  'Service enrollment still accepts distinct synthetic public points'
);
reset role;

select throws_ok(
  $$insert into public.devices(
      user_id, name, encryption_public_key, signing_public_key, key_suite,
      fingerprint, approval_method, approved_at
    ) values (
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      'Direct same-key device',
      '{"crv":"P-256","kty":"EC","x":"49pxiy77_9MJD0KXUVHBhCnIBx8UkYM20ckoBf2LL78","y":"Mj_WFEsqP5tJKIY1CUqgbX5FcAB_zH8fmyOMoZii1eE"}',
      '{"crv":"P-256","kty":"EC","x":"49pxiy77_9MJD0KXUVHBhCnIBx8UkYM20ckoBf2LL78","y":"Mj_WFEsqP5tJKIY1CUqgbX5FcAB_zH8fmyOMoZii1eE"}',
      'hpke-p256-hkdf-sha256-aes256gcm+ecdsa-p256-sha256',
      'ac5461ac7eeb06e9276bc357e80f361c157deb216a46b3619d9965a7e6a12478',
      'bootstrap',
      clock_timestamp()
    )$$,
  '23514',
  null,
  'Direct same-key device insertion is rejected by the table constraint'
);
select throws_ok(
  $$insert into public.device_enrollment_requests(
      account_id, requested_name, encryption_public_key, signing_public_key,
      key_suite, fingerprint, possession_proof, expires_at
    ) values (
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      'Direct same-key enrollment',
      '{"crv":"P-256","kty":"EC","x":"49pxiy77_9MJD0KXUVHBhCnIBx8UkYM20ckoBf2LL78","y":"Mj_WFEsqP5tJKIY1CUqgbX5FcAB_zH8fmyOMoZii1eE"}',
      '{"crv":"P-256","kty":"EC","x":"49pxiy77_9MJD0KXUVHBhCnIBx8UkYM20ckoBf2LL78","y":"Mj_WFEsqP5tJKIY1CUqgbX5FcAB_zH8fmyOMoZii1eE"}',
      'hpke-p256-hkdf-sha256-aes256gcm+ecdsa-p256-sha256',
      'ac5461ac7eeb06e9276bc357e80f361c157deb216a46b3619d9965a7e6a12478',
      'direct-same-key-proof',
      clock_timestamp() + interval '10 minutes'
    )$$,
  '23514',
  null,
  'Direct same-key enrollment insertion is rejected by the table constraint'
);

select lives_ok(
  $$insert into public.devices(user_id, name, encryption_public_key)
    values (
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      'Legacy null-suite row',
      'legacy-public-key-material-preserved-safely'
    )$$,
  'A legacy null-suite device remains compatible'
);
select ok(
  (select key_suite is null
     and signing_public_key is null
     and fingerprint is null
   from public.devices
   where user_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
     and name = 'Legacy null-suite row'),
  'The compatible legacy row remains uninitialized'
);

select * from finish();
rollback;

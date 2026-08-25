begin;
select plan(46);

insert into public.profiles (id, email) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'device-alice@example.test'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'device-bob@example.test');

insert into public.account_identities (issuer, subject, account_id, email, email_verified) values
  ('https://auth.example.test/', 'auth0|device-alice', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'device-alice@example.test', true),
  ('https://auth.example.test/', 'auth0|device-bob', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'device-bob@example.test', true);

select has_column('public', 'devices', 'encryption_public_key', 'Existing device public keys are renamed');
select ok(
  not has_function_privilege('authenticated', 'public.bootstrap_device(uuid,text,text,text,text,text)', 'execute'),
  'Authenticated callers cannot execute bootstrap'
);
select ok(
  has_function_privilege('service_role', 'public.bootstrap_device(uuid,text,text,text,text,text)', 'execute'),
  'The service role can execute bootstrap'
);
select ok(
  has_column_privilege('authenticated', 'public.devices', 'name', 'update'),
  'Authenticated callers may rename devices'
);
select ok(
  has_column_privilege('authenticated', 'public.devices', 'revoked_at', 'update'),
  'Authenticated callers may revoke devices'
);
select ok(
  not has_column_privilege('authenticated', 'public.devices', 'signing_public_key', 'update'),
  'Authenticated callers cannot update signing keys'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $$select public.bootstrap_device(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'Alice bootstrap',
    '{"crv":"P-256","kty":"EC","x":"CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC","y":"DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD"}',
    '{"crv":"P-256","kty":"EC","x":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","y":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}',
    'hpke-p256-hkdf-sha256-aes256gcm+ecdsa-p256-sha256',
    'f9d165bd38c24c8fb8e5e86add303c987041c8c151cab92d435236a5e7279451'
  )$$,
  'The service bootstraps Alice first device'
);
select lives_ok(
  $$select public.bootstrap_device(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'Bob bootstrap',
    '{"crv":"P-256","kty":"EC","x":"GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG","y":"HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH"}',
    '{"crv":"P-256","kty":"EC","x":"EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE","y":"FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF"}',
    'hpke-p256-hkdf-sha256-aes256gcm+ecdsa-p256-sha256',
    'de8581b19cb8b7944f3a86fcd1ab8a152367360dfe5e914f9f9a2171055a1227'
  )$$,
  'The service bootstraps Bob first device'
);
reset role;

select is(
  (select approval_method from public.devices where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  'bootstrap',
  'A first device records bootstrap approval'
);
select ok(
  (select approved_at is not null and approved_by_device_id is null and approval_signature is null
   from public.devices where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  'Bootstrap approval has no approving device or approval signature'
);

select set_config(
  'test.alice_bootstrap_device_id',
  (select id::text from public.devices where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  true
);
select set_config(
  'test.bob_bootstrap_device_id',
  (select id::text from public.devices where user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  true
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.bootstrap_device(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'Second bootstrap',
    '{"crv":"P-256","kty":"EC","x":"KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK","y":"LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL"}',
    '{"crv":"P-256","kty":"EC","x":"IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII","y":"JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ"}',
    'hpke-p256-hkdf-sha256-aes256gcm+ecdsa-p256-sha256',
    '67bd7d16a4eef35f057f22c909f2125c733470a4d8a01cff439d388c39a95d19'
  )$$,
  '55000',
  null,
  'Bootstrap cannot be replayed after an account has a device'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claims', '{"iss":"https://auth.example.test/","sub":"auth0|device-alice","role":"authenticated"}', true);
select is((select count(*)::integer from public.devices), 1, 'Alice sees only her device');
select is(
  (select count(*)::integer from public.devices where user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  0,
  'Alice cannot see Bob devices'
);
select throws_ok(
  $$select public.bootstrap_device(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Bypass', 'x', 'y',
    'hpke-p256-hkdf-sha256-aes256gcm+ecdsa-p256-sha256', repeat('0', 64)
  )$$,
  '42501',
  null,
  'Authenticated SQL cannot bypass service-only bootstrap'
);
select throws_ok(
  $$insert into public.devices(user_id, name, encryption_public_key)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Direct insert', repeat('x', 32))$$,
  '42501',
  null,
  'Authenticated callers cannot directly insert devices'
);
select throws_ok(
  $$update public.devices
    set signing_public_key = '{"crv":"P-256","kty":"EC","x":"IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII","y":"JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ"}'$$,
  '42501',
  null,
  'Authenticated callers cannot directly mutate device keys'
);
select lives_ok(
  $$update public.devices set name = 'Alice renamed'$$,
  'Alice may rename her own device'
);
select is_empty(
  $$update public.devices set name = 'Cross-account rename'
    where user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    returning id$$,
  'Cross-account updates affect no device'
);
reset role;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $$select public.create_device_enrollment_request(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'Alice enrolled',
    '{"crv":"P-256","kty":"EC","x":"KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK","y":"LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL"}',
    '{"crv":"P-256","kty":"EC","x":"IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII","y":"JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ"}',
    'hpke-p256-hkdf-sha256-aes256gcm+ecdsa-p256-sha256',
    '67bd7d16a4eef35f057f22c909f2125c733470a4d8a01cff439d388c39a95d19',
    'alice-possession-proof-0001',
    clock_timestamp() + interval '10 minutes'
  )$$,
  'The service creates Alice pending enrollment request'
);
select lives_ok(
  $$select public.create_device_enrollment_request(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'Bob pending',
    '{"crv":"P-256","kty":"EC","x":"OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO","y":"PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP"}',
    '{"crv":"P-256","kty":"EC","x":"MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM","y":"NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN"}',
    'hpke-p256-hkdf-sha256-aes256gcm+ecdsa-p256-sha256',
    'a8e696e67140e86c8acf278a02d2bf5befe891dd6f604311ccf9854beb14cfb3',
    'bob-possession-proof-0001',
    clock_timestamp() + interval '10 minutes'
  )$$,
  'The service creates Bob pending enrollment request'
);
reset role;

select set_config(
  'test.alice_request_id',
  (select id::text from public.device_enrollment_requests where requested_name = 'Alice enrolled'),
  true
);
select set_config(
  'test.bob_request_id',
  (select id::text from public.device_enrollment_requests where requested_name = 'Bob pending'),
  true
);

set local role authenticated;
select set_config('request.jwt.claims', '{"iss":"https://auth.example.test/","sub":"auth0|device-alice","role":"authenticated"}', true);
select is(
  (select count(*)::integer from public.device_enrollment_requests where status = 'pending'),
  1,
  'Alice sees her pending enrollment request'
);
select is(
  (select count(*)::integer from public.device_enrollment_requests where account_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  0,
  'Alice cannot see Bob enrollment requests'
);
select throws_ok(
  $$insert into public.device_enrollment_requests(
      account_id, requested_name, encryption_public_key, signing_public_key,
      key_suite, fingerprint, possession_proof, expires_at
    ) values (
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Direct request', 'x', 'y', 'suite',
      repeat('0', 64), 'direct-possession-proof', now() + interval '1 minute'
    )$$,
  '42501',
  null,
  'Authenticated callers cannot directly create enrollment requests'
);
reset role;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.create_device_enrollment_request(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'Duplicate fingerprint',
    '{"crv":"P-256","kty":"EC","x":"KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK","y":"LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL"}',
    '{"crv":"P-256","kty":"EC","x":"IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII","y":"JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ"}',
    'hpke-p256-hkdf-sha256-aes256gcm+ecdsa-p256-sha256',
    '67bd7d16a4eef35f057f22c909f2125c733470a4d8a01cff439d388c39a95d19',
    'replayed-possession-proof',
    clock_timestamp() + interval '10 minutes'
  )$$,
  '23505',
  null,
  'A pending fingerprint cannot be replayed'
);
select throws_ok(
  $$select public.approve_device_enrollment_request(
    current_setting('test.alice_request_id')::uuid,
    current_setting('test.bob_bootstrap_device_id')::uuid,
    'cross-account-signature-0001'
  )$$,
  '55000',
  null,
  'A device from another account cannot approve a request'
);
select lives_ok(
  $$select public.approve_device_enrollment_request(
    current_setting('test.alice_request_id')::uuid,
    current_setting('test.alice_bootstrap_device_id')::uuid,
    'alice-approval-signature-0001'
  )$$,
  'An active same-account device approves enrollment'
);
reset role;

select is(
  (select status from public.device_enrollment_requests where id = current_setting('test.alice_request_id')::uuid),
  'approved',
  'Enrollment transitions from pending to approved'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.approve_device_enrollment_request(
    current_setting('test.alice_request_id')::uuid,
    current_setting('test.alice_bootstrap_device_id')::uuid,
    'different-replay-signature-0001'
  )$$,
  '55000',
  null,
  'A mismatched approval replay is rejected'
);
select lives_ok(
  $$select public.complete_device_enrollment_request(current_setting('test.alice_request_id')::uuid)$$,
  'The service atomically registers an approved device'
);
reset role;

select set_config(
  'test.alice_enrolled_device_id',
  (select device_id::text from public.device_enrollment_requests where id = current_setting('test.alice_request_id')::uuid),
  true
);
select is(
  (select status from public.device_enrollment_requests where id = current_setting('test.alice_request_id')::uuid),
  'claimed',
  'Enrollment transitions from approved to claimed'
);
select ok(
  (select approval_method = 'device'
      and approved_by_device_id = current_setting('test.alice_bootstrap_device_id')::uuid
      and approval_signature = 'alice-approval-signature-0001'
   from public.devices where id = current_setting('test.alice_enrolled_device_id')::uuid),
  'Registered device retains immutable approval metadata'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  (public.complete_device_enrollment_request(current_setting('test.alice_request_id')::uuid)).id,
  current_setting('test.alice_enrolled_device_id')::uuid,
  'A completion retry idempotently returns the claimed device'
);
select lives_ok(
  $$select public.create_device_enrollment_request(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'Bob stale',
    '{"crv":"P-256","kty":"EC","x":"SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS","y":"TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT"}',
    '{"crv":"P-256","kty":"EC","x":"QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ","y":"RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR"}',
    'hpke-p256-hkdf-sha256-aes256gcm+ecdsa-p256-sha256',
    '9cd80566c0b62e3cf066ebc9d808919cf213ef5c1480b62d206e2c54a39f867f',
    'bob-stale-possession-proof',
    clock_timestamp() + interval '250 milliseconds'
  )$$,
  'The service creates a short-lived request for stale-state testing'
);
reset role;

select set_config(
  'test.bob_stale_request_id',
  (select id::text from public.device_enrollment_requests where requested_name = 'Bob stale'),
  true
);
select pg_sleep(0.35);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.approve_device_enrollment_request(
    current_setting('test.bob_stale_request_id')::uuid,
    current_setting('test.bob_bootstrap_device_id')::uuid,
    'stale-approval-signature-0001'
  )$$,
  '55000',
  null,
  'A stale enrollment request cannot be approved'
);
select is(
  public.expire_device_enrollment_requests(1000),
  1,
  'The lifecycle RPC expires stale pending requests'
);
reset role;

select is(
  (select status from public.device_enrollment_requests where id = current_setting('test.bob_stale_request_id')::uuid),
  'expired',
  'Expired enrollment state is durable'
);

set local role authenticated;
select set_config('request.jwt.claims', '{"iss":"https://auth.example.test/","sub":"auth0|device-alice","role":"authenticated"}', true);
select is((select count(*)::integer from public.devices), 2, 'Alice sees both approved devices');
select lives_ok(
  $$update public.devices
    set revoked_at = clock_timestamp()
    where id = current_setting('test.alice_enrolled_device_id')::uuid$$,
  'Alice may revoke her enrolled device'
);
select ok(
  (select revoked_at is not null from public.devices where id = current_setting('test.alice_enrolled_device_id')::uuid),
  'Revocation is visible immediately'
);
select throws_ok(
  $$update public.devices
    set revoked_at = null
    where id = current_setting('test.alice_enrolled_device_id')::uuid$$,
  '55000',
  null,
  'Device revocation is irreversible'
);
select is((select count(*)::integer from public.devices), 2, 'Revoked devices remain visible to their account');
select is(
  (select count(*)::integer from public.devices where revoked_at is null),
  1,
  'Only the bootstrap device remains active after revocation'
);
reset role;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $$select public.create_device_enrollment_request(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'Alice key re-enrollment',
    '{"crv":"P-256","kty":"EC","x":"KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK","y":"LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL"}',
    '{"crv":"P-256","kty":"EC","x":"IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII","y":"JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ"}',
    'hpke-p256-hkdf-sha256-aes256gcm+ecdsa-p256-sha256',
    '67bd7d16a4eef35f057f22c909f2125c733470a4d8a01cff439d388c39a95d19',
    'new-proof-after-revocation',
    clock_timestamp() + interval '10 minutes'
  )$$,
  'A revoked fingerprint may begin a new enrollment lifecycle'
);
select lives_ok(
  $$update public.devices
    set revoked_at = clock_timestamp()
    where id = current_setting('test.alice_bootstrap_device_id')::uuid$$,
  'The final active device can be revoked explicitly'
);
select throws_ok(
  $$select public.bootstrap_device(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'Disallowed recovery device',
    '{"crv":"P-256","kty":"EC","x":"KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK","y":"LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL"}',
    '{"crv":"P-256","kty":"EC","x":"IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII","y":"JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ"}',
    'hpke-p256-hkdf-sha256-aes256gcm+ecdsa-p256-sha256',
    '67bd7d16a4eef35f057f22c909f2125c733470a4d8a01cff439d388c39a95d19'
  )$$,
  '55000',
  null,
  'Bootstrap stays unavailable after every device is revoked'
);
reset role;

select lives_ok(
  $$insert into public.devices(user_id, name, encryption_public_key)
    values (
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'Migrated legacy row',
      'legacy-public-key-material-preserved-safely'
    )$$,
  'The additive schema remains compatible with pre-existing legacy rows'
);

select * from finish();
rollback;

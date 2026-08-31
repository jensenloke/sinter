begin;
select plan(103);

insert into public.profiles(id, email) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'capsule-alice@example.test'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'capsule-bob@example.test');

insert into public.account_identities(issuer, subject, account_id, email, email_verified) values
  ('https://auth.example.test/', 'auth0|capsule-alice', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'capsule-alice@example.test', true),
  ('https://auth.example.test/', 'auth0|capsule-bob', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'capsule-bob@example.test', true);

insert into public.devices(
  id, user_id, name, encryption_public_key, signing_public_key, key_suite,
  fingerprint, approval_method, approved_at
) values
  (
    '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'Alice sender',
    '{"crv":"P-256","kty":"EC","x":"CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC","y":"DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD"}',
    '{"crv":"P-256","kty":"EC","x":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","y":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}',
    'hpke-p256-hkdf-sha256-aes256gcm+ecdsa-p256-sha256',
    'f9d165bd38c24c8fb8e5e86add303c987041c8c151cab92d435236a5e7279451',
    'bootstrap',
    clock_timestamp()
  ),
  (
    '22222222-2222-4222-8222-222222222222',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'Alice recipient',
    '{"crv":"P-256","kty":"EC","x":"KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK","y":"LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL"}',
    '{"crv":"P-256","kty":"EC","x":"IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII","y":"JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ"}',
    'hpke-p256-hkdf-sha256-aes256gcm+ecdsa-p256-sha256',
    '67bd7d16a4eef35f057f22c909f2125c733470a4d8a01cff439d388c39a95d19',
    'bootstrap',
    clock_timestamp()
  ),
  (
    '33333333-3333-4333-8333-333333333333',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'Bob device',
    '{"crv":"P-256","kty":"EC","x":"GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG","y":"HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH"}',
    '{"crv":"P-256","kty":"EC","x":"EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE","y":"FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF"}',
    'hpke-p256-hkdf-sha256-aes256gcm+ecdsa-p256-sha256',
    'de8581b19cb8b7944f3a86fcd1ab8a152367360dfe5e914f9f9a2171055a1227',
    'bootstrap',
    clock_timestamp()
  );

select has_table('public', 'capsules', 'Capsule metadata table exists');
select has_table('public', 'capsule_recipients', 'Capsule recipient metadata table exists');
select has_table('public', 'capsule_request_nonces', 'Bounded request nonce table exists');
select columns_are(
  'public',
  'capsule_request_nonces',
  array['account_id', 'device_id', 'nonce', 'request_timestamp', 'accepted_at', 'expires_at'],
  'Request nonces retain only bounded replay metadata'
);
select fk_ok('public', 'capsule_request_nonces', 'account_id', 'public', 'profiles', 'id', 'Request nonces have an owner account foreign key');
select fk_ok('public', 'capsule_request_nonces', 'device_id', 'public', 'devices', 'id', 'Request nonces reference an exact device');
select has_index('public', 'capsule_request_nonces', 'capsule_request_nonces_expiry_idx', 'Request nonce cleanup has a bounded expiry index');
select ok(not has_table_privilege('authenticated', 'public.capsule_request_nonces', 'select'), 'Authenticated callers cannot read request nonces');
select ok(not has_table_privilege('authenticated', 'public.capsule_request_nonces', 'insert'), 'Authenticated callers cannot insert request nonces');
select ok(not has_table_privilege('service_role', 'public.capsule_request_nonces', 'select'), 'Service role has no direct nonce read grant');
select ok(not has_table_privilege('service_role', 'public.capsule_request_nonces', 'insert'), 'Service role has no direct nonce insert grant');
select ok(
  has_function_privilege('service_role', 'public.claim_capsule_request_nonce(uuid,uuid,text,timestamptz)', 'execute'),
  'Service role can atomically claim a request nonce'
);
select ok(
  not has_function_privilege('authenticated', 'public.claim_capsule_request_nonce(uuid,uuid,text,timestamptz)', 'execute'),
  'Authenticated callers cannot claim request nonces directly'
);
select ok(
  has_function_privilege('service_role', 'public.expire_capsule_request_nonces(integer)', 'execute'),
  'Service role can perform bounded nonce expiry'
);
select ok(
  not has_function_privilege('authenticated', 'public.expire_capsule_request_nonces(integer)', 'execute'),
  'Authenticated callers cannot expire request nonces'
);
select ok(
  (select bool_and(prosecdef and array_to_string(proconfig, ',') = 'search_path=""')
   from pg_catalog.pg_proc
   where oid in (
     'public.claim_capsule_request_nonce(uuid,uuid,text,timestamptz)'::regprocedure,
     'public.expire_capsule_request_nonces(integer)'::regprocedure
   )),
  'Nonce RPCs are SECURITY DEFINER with empty search paths'
);
select ok(
  (select not public and file_size_limit = 67108864
   from storage.buckets where id = 'capsules'),
  'Capsule Storage bucket is private with the 64 MiB safety cap'
);
select col_is_pk('public', 'capsules', array['account_id', 'capsule_id'], 'Capsules have an owner-scoped primary key');
select fk_ok('public', 'capsules', 'account_id', 'public', 'profiles', 'id', 'Capsules have an owner account foreign key');
select fk_ok('public', 'capsule_recipients', 'account_id', 'public', 'profiles', 'id', 'Recipients have an owner account foreign key');
select is(
  (select count(*)::integer from information_schema.columns
   where table_schema = 'public'
     and table_name in ('capsules', 'capsule_recipients', 'capsule_request_nonces')
     and column_name in (
       'content', 'plaintext', 'title', 'repository', 'repository_path', 'path',
       'native_id', 'session_id', 'transcript', 'ciphertext', 'manifest', 'payload'
     )),
  0,
  'Capsule metadata has no content, title, repository, path, native ID, or payload columns'
);
select columns_are(
  'public',
  'capsule_recipients',
  array['account_id', 'capsule_id', 'recipient_fingerprint', 'created_at'],
  'Recipient rows contain only bounded routing metadata'
);
select ok(has_table_privilege('authenticated', 'public.capsules', 'select'), 'Authenticated accounts receive capsule select');
select ok(not has_table_privilege('authenticated', 'public.capsules', 'insert'), 'Authenticated accounts cannot insert capsules');
select ok(not has_table_privilege('authenticated', 'public.capsules', 'update'), 'Authenticated accounts cannot update capsules');
select ok(not has_table_privilege('authenticated', 'public.capsules', 'delete'), 'Authenticated accounts cannot delete capsules');
select ok(not has_table_privilege('service_role', 'public.capsules', 'insert'), 'Service role has no direct capsule insert grant');
select ok(not has_table_privilege('service_role', 'public.capsules', 'update'), 'Service role has no direct capsule update grant');
select ok(not has_table_privilege('service_role', 'public.capsule_recipients', 'delete'), 'Service role has no direct recipient delete grant');
select ok(
  has_function_privilege('service_role', 'public.reserve_capsule(uuid,uuid,text,bigint,text,text,text,text,text,text[])', 'execute'),
  'Service role can reserve capsules through the RPC'
);
select ok(
  not has_function_privilege('authenticated', 'public.reserve_capsule(uuid,uuid,text,bigint,text,text,text,text,text,text[])', 'execute'),
  'Authenticated SQL cannot reserve capsules directly'
);
select ok(
  has_function_privilege('service_role', 'public.finalize_capsule(uuid,uuid,text,bigint,text)', 'execute'),
  'Service role can finalize capsules through the RPC'
);
select ok(
  has_function_privilege('service_role', 'public.begin_capsule_delete(uuid,uuid,text)', 'execute'),
  'Service role can begin permanent deletion'
);
select ok(
  has_function_privilege('service_role', 'public.finalize_capsule_delete(uuid,uuid,text,bigint,text)', 'execute'),
  'Service role can finalize permanent deletion'
);
select ok(
  has_function_privilege('service_role', 'public.expire_capsule_reservations(integer)', 'execute'),
  'Service role can begin retryable reservation cleanup'
);
select ok(
  has_function_privilege('service_role', 'public.finalize_capsule_reservation_expiry(uuid,text,bigint,text)', 'execute'),
  'Service role can finalize reservation expiry after Storage cleanup'
);
select ok(
  not has_function_privilege('authenticated', 'public.finalize_capsule_reservation_expiry(uuid,text,bigint,text)', 'execute'),
  'Authenticated callers cannot finalize reservation expiry'
);
select ok(
  has_function_privilege('service_role', 'public.authorize_capsule_read(uuid,uuid)', 'execute'),
  'Service role can check active upload-enabled read entitlement'
);
select ok(
  not has_function_privilege('authenticated', 'public.authorize_capsule_read(uuid,uuid)', 'execute'),
  'Authenticated callers cannot bypass capsule read authorization'
);
select ok(
  (select bool_and(prosecdef and array_to_string(proconfig, ',') = 'search_path=""')
   from pg_catalog.pg_proc
   where oid in (
     'public.reserve_capsule(uuid,uuid,text,bigint,text,text,text,text,text,text[])'::regprocedure,
     'public.finalize_capsule(uuid,uuid,text,bigint,text)'::regprocedure,
     'public.begin_capsule_delete(uuid,uuid,text)'::regprocedure,
     'public.finalize_capsule_delete(uuid,uuid,text,bigint,text)'::regprocedure,
     'public.expire_capsule_reservations(integer)'::regprocedure,
     'public.finalize_capsule_reservation_expiry(uuid,text,bigint,text)'::regprocedure,
     'public.authorize_capsule_read(uuid,uuid)'::regprocedure
   )),
  'All capsule RPCs are SECURITY DEFINER with an empty search path'
);
select is(
  (select count(*)::integer from pg_catalog.pg_indexes
   where schemaname = 'public' and tablename in ('capsules', 'capsule_recipients')),
  8,
  'Capsule metadata has primary, unique, account, expiry-selection, cleanup, deletion, and recipient indexes'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"iss":"https://auth.example.test/","sub":"auth0|capsule-alice","role":"authenticated"}',
  true
);
select is((select count(*)::integer from public.capsules), 0, 'Alice initially sees no capsules');
select throws_ok(
  $$insert into public.capsules(
      account_id, capsule_id, object_path, serialized_bytes, serialized_sha256,
      outer_schema, payload_schema, transfer_schema, sender_fingerprint,
      recipient_count, reserved_at, reservation_expires_at
    ) values (
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'AAAAAAAAAAAAAAAAAAAAAA',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/AAAAAAAAAAAAAAAAAAAAAA.capsule',
      1, repeat('a', 64), 'sinter.capsule.v1', 'sinter.payload.v1',
      'sinter.transfer.v1', repeat('b', 64), 1, now(), now() + interval '1 minute'
    )$$,
  '42501',
  null,
  'Alice cannot bypass the reservation RPC'
);
reset role;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $$select public.claim_capsule_request_nonce(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '11111111-1111-4111-8111-111111111111',
    repeat('A', 43),
    clock_timestamp()
  )$$,
  'A valid active-device request nonce is claimed atomically'
);
select throws_ok(
  $$select public.claim_capsule_request_nonce(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '11111111-1111-4111-8111-111111111111',
    repeat('A', 43),
    clock_timestamp()
  )$$,
  'PT409',
  'capsule_request_replay',
  'A duplicate device nonce is rejected as replay'
);
select throws_ok(
  $$select public.claim_capsule_request_nonce(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '11111111-1111-4111-8111-111111111111',
    repeat('B', 42) || 'Q',
    clock_timestamp() - interval '7 minutes'
  )$$,
  '22023',
  'invalid capsule request nonce or timestamp',
  'A stale request timestamp cannot claim a nonce'
);
select lives_ok(
  $$select public.claim_capsule_request_nonce(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '11111111-1111-4111-8111-111111111111',
    repeat('D', 42) || 'w',
    clock_timestamp() + interval '5 minutes 30 seconds'
  )$$,
  'The database tolerates bounded clock drift beyond the HTTP five-minute window'
);
select throws_ok(
  $$select public.claim_capsule_request_nonce(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    '11111111-1111-4111-8111-111111111111',
    repeat('C', 42) || 'g',
    clock_timestamp()
  )$$,
  '42501',
  'active account device required',
  'A cross-account device cannot claim a nonce'
);
reset role;
select is((select count(*)::integer from public.capsule_request_nonces), 2, 'Rejected nonce claims write no replay rows');
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"iss":"https://auth.example.test/","sub":"auth0|capsule-alice","role":"authenticated"}',
  true
);
select throws_ok(
  $$select * from public.capsule_request_nonces$$,
  '42501',
  null,
  'Authenticated callers cannot read even their own replay nonces'
);
reset role;
update public.capsule_request_nonces
set request_timestamp = statement_timestamp() - interval '11 minutes',
    accepted_at = statement_timestamp() - interval '11 minutes',
    expires_at = statement_timestamp() - interval '1 minute';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(public.expire_capsule_request_nonces(10), 2, 'Bounded cleanup deletes expired request nonces');
reset role;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.authorize_capsule_read(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '11111111-1111-4111-8111-111111111111'
  )$$,
  '42501',
  'capsule reads are not enabled',
  'Disabled upload entitlement refuses capsule reads'
);
select throws_ok(
  $$select public.reserve_capsule(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '11111111-1111-4111-8111-111111111111',
    'AAAAAAAAAAAAAAAAAAAAAA', 1000, repeat('a', 64),
    'sinter.capsule.v1', 'sinter.capsule.session-transfer.v1', 'sinter.session-transfer.v2',
    'f9d165bd38c24c8fb8e5e86add303c987041c8c151cab92d435236a5e7279451',
    array['67bd7d16a4eef35f057f22c909f2125c733470a4d8a01cff439d388c39a95d19']
  )$$,
  '42501',
  'capsule uploads are not enabled',
  'Disabled entitlement refuses reservation'
);
reset role;
select is((select count(*)::integer from public.capsules), 0, 'Disabled reservation writes no capsule');
select ok(
  (select reserved_storage_bytes = 0 and reserved_capsule_count = 0
   from public.account_usage where account_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  'Disabled reservation changes no counters'
);

update public.account_entitlements
set uploads_enabled = true,
    storage_limit_bytes = 2000,
    session_limit = 2,
    capsule_size_limit_bytes = 1024
where account_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  public.authorize_capsule_read(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '11111111-1111-4111-8111-111111111111'
  ),
  true,
  'Active upload-enabled entitlement authorizes capsule reads'
);
select lives_ok(
  $$select public.reserve_capsule(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '11111111-1111-4111-8111-111111111111',
    'AAAAAAAAAAAAAAAAAAAAAA', 1000, repeat('a', 64),
    'sinter.capsule.v1', 'sinter.capsule.session-transfer.v1', 'sinter.session-transfer.v2',
    'f9d165bd38c24c8fb8e5e86add303c987041c8c151cab92d435236a5e7279451',
    array['67bd7d16a4eef35f057f22c909f2125c733470a4d8a01cff439d388c39a95d19']
  )$$,
  'An active sender reserves at a storage quota boundary'
);
select lives_ok(
  $$select public.reserve_capsule(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '11111111-1111-4111-8111-111111111111',
    'AAAAAAAAAAAAAAAAAAAAAA', 1000, repeat('a', 64),
    'sinter.capsule.v1', 'sinter.capsule.session-transfer.v1', 'sinter.session-transfer.v2',
    'f9d165bd38c24c8fb8e5e86add303c987041c8c151cab92d435236a5e7279451',
    array['67bd7d16a4eef35f057f22c909f2125c733470a4d8a01cff439d388c39a95d19']
  )$$,
  'An exact reservation retry is idempotent'
);
reset role;
select is((select count(*)::integer from public.capsules), 1, 'Exact reservation retry creates one row');
update public.capsules
set reserved_at = statement_timestamp() - interval '2 hours 14 minutes',
    reservation_refreshed_at = statement_timestamp() - interval '2 hours 14 minutes',
    reservation_expires_at = statement_timestamp() + interval '1 minute'
where account_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  and capsule_id = 'AAAAAAAAAAAAAAAAAAAAAA';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $$select public.reserve_capsule(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '11111111-1111-4111-8111-111111111111',
    'AAAAAAAAAAAAAAAAAAAAAA', 1000, repeat('a', 64),
    'sinter.capsule.v1', 'sinter.capsule.session-transfer.v1', 'sinter.session-transfer.v2',
    'f9d165bd38c24c8fb8e5e86add303c987041c8c151cab92d435236a5e7279451',
    array['67bd7d16a4eef35f057f22c909f2125c733470a4d8a01cff439d388c39a95d19']
  )$$,
  'An exact retry near expiry renews tracking beyond the fresh upload token lifetime'
);
reset role;
select ok(
  (select extract(epoch from (reservation_expires_at - reservation_refreshed_at))::integer = 8100
      and reservation_expires_at >= statement_timestamp() + interval '2 hours 14 minutes'
   from public.capsules
   where account_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
     and capsule_id = 'AAAAAAAAAAAAAAAAAAAAAA'),
  'Every signed-upload retry remains tracked for two hours plus a fifteen-minute boundary'
);
select ok(
  (select reserved_storage_bytes = 1000 and reserved_capsule_count = 1
   from public.account_usage where account_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  'Exact reservation retry increments counters once'
);
select is((select count(*)::integer from public.capsule_recipients), 1, 'Exact reservation retry stores one recipient row');

update public.account_entitlements
set storage_limit_bytes = 10000, session_limit = 1
where account_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.reserve_capsule(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '11111111-1111-4111-8111-111111111111',
    'BBBBBBBBBBBBBBBBBBBBBQ', 1, repeat('b', 64),
    'sinter.capsule.v1', 'sinter.capsule.session-transfer.v1', 'sinter.session-transfer.v2',
    'f9d165bd38c24c8fb8e5e86add303c987041c8c151cab92d435236a5e7279451',
    array['67bd7d16a4eef35f057f22c909f2125c733470a4d8a01cff439d388c39a95d19']
  )$$,
  'PT409',
  'capsule_account_quota_exceeded',
  'Session quota rejects one capsule over the retained and reserved boundary'
);
reset role;
update public.account_entitlements
set storage_limit_bytes = 2000, session_limit = 2
where account_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.reserve_capsule(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '11111111-1111-4111-8111-111111111111',
    'AAAAAAAAAAAAAAAAAAAAAA', 999, repeat('a', 64),
    'sinter.capsule.v1', 'sinter.capsule.session-transfer.v1', 'sinter.session-transfer.v2',
    'f9d165bd38c24c8fb8e5e86add303c987041c8c151cab92d435236a5e7279451',
    array['67bd7d16a4eef35f057f22c909f2125c733470a4d8a01cff439d388c39a95d19']
  )$$,
  'PT409',
  'capsule_reservation_conflict',
  'A mismatched reservation retry has a distinguishable conflict'
);
select throws_ok(
  $$select public.reserve_capsule(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '11111111-1111-4111-8111-111111111111',
    'BBBBBBBBBBBBBBBBBBBBBQ', 1025, repeat('b', 64),
    'sinter.capsule.v1', 'sinter.capsule.session-transfer.v1', 'sinter.session-transfer.v2',
    'f9d165bd38c24c8fb8e5e86add303c987041c8c151cab92d435236a5e7279451',
    array['67bd7d16a4eef35f057f22c909f2125c733470a4d8a01cff439d388c39a95d19']
  )$$,
  'PT409',
  'capsule_size_quota_exceeded',
  'The per-capsule 16/64 MiB control-plane limit is enforced at its configured boundary'
);
select throws_ok(
  $$select public.reserve_capsule(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '11111111-1111-4111-8111-111111111111',
    'BBBBBBBBBBBBBBBBBBBBBQ', 1001, repeat('b', 64),
    'sinter.capsule.v1', 'sinter.capsule.session-transfer.v1', 'sinter.session-transfer.v2',
    'f9d165bd38c24c8fb8e5e86add303c987041c8c151cab92d435236a5e7279451',
    array['67bd7d16a4eef35f057f22c909f2125c733470a4d8a01cff439d388c39a95d19']
  )$$,
  'PT409',
  'capsule_account_quota_exceeded',
  'Storage quota rejects one byte over the combined retained and reserved boundary'
);
select throws_ok(
  $$select public.reserve_capsule(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '11111111-1111-4111-8111-111111111111',
    'BBBBBBBBBBBBBBBBBBBBBQ', 1, repeat('b', 64),
    'sinter.capsule.v1', 'sinter.capsule.session-transfer.v1', 'sinter.session-transfer.v2',
    'f9d165bd38c24c8fb8e5e86add303c987041c8c151cab92d435236a5e7279451',
    array['de8581b19cb8b7944f3a86fcd1ab8a152367360dfe5e914f9f9a2171055a1227']
  )$$,
  '42501',
  'all recipient devices must be active',
  'A cross-account recipient fingerprint is refused'
);
select throws_ok(
  $$select public.finalize_capsule(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    '33333333-3333-4333-8333-333333333333',
    'AAAAAAAAAAAAAAAAAAAAAA', 1000, repeat('a', 64)
  )$$,
  '42501',
  'capsule uploads are not enabled',
  'A cross-account finalization is refused before selecting Alice metadata'
);
select throws_ok(
  $$select public.finalize_capsule(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '11111111-1111-4111-8111-111111111111',
    'AAAAAAAAAAAAAAAAAAAAAA', 999, repeat('a', 64)
  )$$,
  'PT409',
  'capsule_finalize_mismatch',
  'Finalize rejects a serialized-size mismatch'
);
select lives_ok(
  $$select public.finalize_capsule(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '11111111-1111-4111-8111-111111111111',
    'AAAAAAAAAAAAAAAAAAAAAA', 1000, repeat('a', 64)
  )$$,
  'Finalize atomically retains the uploaded capsule'
);
select lives_ok(
  $$select public.finalize_capsule(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '11111111-1111-4111-8111-111111111111',
    'AAAAAAAAAAAAAAAAAAAAAA', 1000, repeat('a', 64)
  )$$,
  'An exact finalize retry is idempotent'
);
reset role;
select ok(
  (select status = 'retained' and finalized_at is not null
   from public.capsules
   where account_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
     and capsule_id = 'AAAAAAAAAAAAAAAAAAAAAA'),
  'Finalized metadata is retained without changing its opaque ID'
);
select ok(
  (select retained_storage_bytes = 1000 and capsule_count = 1
      and reserved_storage_bytes = 0 and reserved_capsule_count = 0
   from public.account_usage where account_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  'Finalize moves exact bytes and count from reserved to retained once'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"iss":"https://auth.example.test/","sub":"auth0|capsule-bob","role":"authenticated"}',
  true
);
select is((select count(*)::integer from public.capsules), 0, 'Bob cannot see Alice capsule metadata');
select is((select count(*)::integer from public.capsule_recipients), 0, 'Bob cannot see Alice recipient fingerprints');
reset role;

update public.account_entitlements
set uploads_enabled = false
where account_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $$select public.begin_capsule_delete(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '22222222-2222-4222-8222-222222222222',
    'AAAAAAAAAAAAAAAAAAAAAA'
  )$$,
  'An active owner device begins deletion when uploads are disabled'
);
reset role;
update public.account_entitlements
set status = 'suspended'
where account_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.authorize_capsule_read(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '22222222-2222-4222-8222-222222222222'
  )$$,
  '42501',
  'capsule reads are not enabled',
  'Suspended entitlement refuses capsule reads while deletion remains available'
);
select throws_ok(
  $$select public.begin_capsule_delete(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '33333333-3333-4333-8333-333333333333',
    'AAAAAAAAAAAAAAAAAAAAAA'
  )$$,
  '42501',
  'active account device required',
  'A cross-account device cannot delete a suspended account capsule'
);
select throws_ok(
  $$select public.begin_capsule_delete(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '99999999-9999-4999-8999-999999999999',
    'AAAAAAAAAAAAAAAAAAAAAA'
  )$$,
  '42501',
  'active account device required',
  'An inactive device cannot delete a suspended account capsule'
);
select lives_ok(
  $$select public.begin_capsule_delete(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '22222222-2222-4222-8222-222222222222',
    'AAAAAAAAAAAAAAAAAAAAAA'
  )$$,
  'A suspended owner can retry delete_pending idempotently'
);
reset role;
select ok(
  (select status = 'delete_pending' and retained_storage_bytes = 1000 and capsule_count = 1
   from public.capsules join public.account_usage using (account_id)
   where account_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
     and capsule_id = 'AAAAAAAAAAAAAAAAAAAAAA'),
  'Delete pending preserves counters until Storage deletion succeeds'
);
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"iss":"https://auth.example.test/","sub":"auth0|capsule-alice","role":"authenticated"}',
  true
);
select is((select count(*)::integer from public.capsules), 0, 'Suspended owner direct reads see no capsule metadata');
select is((select count(*)::integer from public.capsule_recipients), 0, 'Suspended owner direct reads see no recipient metadata');
reset role;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.finalize_capsule_delete(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '22222222-2222-4222-8222-222222222222',
    'AAAAAAAAAAAAAAAAAAAAAA', 1000, repeat('b', 64)
  )$$,
  'PT409',
  'capsule_delete_mismatch',
  'Delete finalization rejects mismatched object metadata'
);
select lives_ok(
  $$select public.finalize_capsule_delete(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '22222222-2222-4222-8222-222222222222',
    'AAAAAAAAAAAAAAAAAAAAAA', 1000, repeat('a', 64)
  )$$,
  'Storage deletion can be finalized'
);
select lives_ok(
  $$select public.finalize_capsule_delete(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '22222222-2222-4222-8222-222222222222',
    'AAAAAAAAAAAAAAAAAAAAAA', 1000, repeat('a', 64)
  )$$,
  'An exact delete-finalization retry is idempotent'
);
reset role;
select ok(
  (select status = 'deleted' and storage_deleted_at is not null
   from public.capsules
   where account_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
     and capsule_id = 'AAAAAAAAAAAAAAAAAAAAAA'),
  'Deleted metadata records permanent Storage completion'
);
select ok(
  (select retained_storage_bytes = 0 and capsule_count = 0
   from public.account_usage where account_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  'Delete finalization decrements retained counters exactly once'
);

update public.account_entitlements
set status = 'active', uploads_enabled = true
where account_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $$select public.reserve_capsule(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '11111111-1111-4111-8111-111111111111',
    'CCCCCCCCCCCCCCCCCCCCCg', 1000, repeat('c', 64),
    'sinter.capsule.v1', 'sinter.capsule.session-transfer.v1', 'sinter.session-transfer.v2',
    'f9d165bd38c24c8fb8e5e86add303c987041c8c151cab92d435236a5e7279451',
    array['67bd7d16a4eef35f057f22c909f2125c733470a4d8a01cff439d388c39a95d19']
  )$$,
  'A second reservation is created for expiry accounting'
);
reset role;
update public.capsules
set reserved_at = statement_timestamp() - interval '2 hours 16 minutes',
    reservation_refreshed_at = statement_timestamp() - interval '2 hours 16 minutes',
    reservation_expires_at = statement_timestamp() - interval '1 minute'
where account_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  and capsule_id = 'CCCCCCCCCCCCCCCCCCCCCg';

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  (select count(*)::integer from public.expire_capsule_reservations(10)),
  1,
  'Expiry marks one stale reservation for Storage cleanup'
);
select is(
  (select count(*)::integer from public.expire_capsule_reservations(10)),
  1,
  'A later sweep returns the same pending cleanup for retry'
);
reset role;
select ok(
  (select status = 'expiry_pending'
      and expiry_requested_at is not null
      and storage_cleanup_completed_at is null
      and expired_at is null
   from public.capsules
   where account_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
     and capsule_id = 'CCCCCCCCCCCCCCCCCCCCCg'),
  'Expiry pending durably records unfinished Storage cleanup'
);
select ok(
  (select reserved_storage_bytes = 1000 and reserved_capsule_count = 1
   from public.account_usage where account_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  'Expiry pending preserves exact reserved quota until Storage cleanup succeeds'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.finalize_capsule(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '11111111-1111-4111-8111-111111111111',
    'CCCCCCCCCCCCCCCCCCCCCg', 1000, repeat('c', 64)
  )$$,
  'PT409',
  'capsule_reservation_not_finalizable',
  'Finalize cannot race past durable expiry cleanup state'
);
select throws_ok(
  $$select public.finalize_capsule_reservation_expiry(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'CCCCCCCCCCCCCCCCCCCCCg', 999, repeat('c', 64)
  )$$,
  'PT409',
  'capsule_expiry_mismatch',
  'Expiry finalization requires exact reserved object metadata'
);
select lives_ok(
  $$select public.finalize_capsule_reservation_expiry(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'CCCCCCCCCCCCCCCCCCCCCg', 1000, repeat('c', 64)
  )$$,
  'Confirmed Storage cleanup atomically finalizes expiry'
);
select lives_ok(
  $$select public.finalize_capsule_reservation_expiry(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'CCCCCCCCCCCCCCCCCCCCCg', 1000, repeat('c', 64)
  )$$,
  'An exact expiry-finalization retry is idempotent'
);
reset role;
select ok(
  (select status = 'expired'
      and storage_cleanup_completed_at is not null
      and expired_at >= storage_cleanup_completed_at
   from public.capsules
   where account_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
     and capsule_id = 'CCCCCCCCCCCCCCCCCCCCCg'),
  'Expired reservation records confirmed terminal Storage cleanup'
);
select ok(
  (select reserved_storage_bytes = 0 and reserved_capsule_count = 0
   from public.account_usage where account_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  'Expiry finalization reclaims exact reserved bytes and count once'
);
select throws_ok(
  $$update public.capsules set status = 'retained' where capsule_id = 'CCCCCCCCCCCCCCCCCCCCCg'$$,
  '23514',
  null,
  'Strict state checks reject incomplete finalized metadata'
);
select throws_ok(
  $$update public.capsules set serialized_bytes = 67108865 where capsule_id = 'CCCCCCCCCCCCCCCCCCCCCg'$$,
  '23514',
  null,
  'Strict checks reject objects above 64 MiB'
);

update public.devices
set revoked_at = clock_timestamp()
where id = '22222222-2222-4222-8222-222222222222';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.reserve_capsule(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '11111111-1111-4111-8111-111111111111',
    'DDDDDDDDDDDDDDDDDDDDDw', 1, repeat('d', 64),
    'sinter.capsule.v1', 'sinter.capsule.session-transfer.v1', 'sinter.session-transfer.v2',
    'f9d165bd38c24c8fb8e5e86add303c987041c8c151cab92d435236a5e7279451',
    array['67bd7d16a4eef35f057f22c909f2125c733470a4d8a01cff439d388c39a95d19']
  )$$,
  '42501',
  'all recipient devices must be active',
  'A revoked recipient is refused before reservation writes'
);
reset role;

select * from finish();
rollback;

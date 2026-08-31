begin;
select plan(91);

insert into public.profiles (id, email) values
  ('10000000-0000-4000-8000-000000000001', 'admin@example.test'),
  ('20000000-0000-4000-8000-000000000002', 'alice-control@example.test'),
  ('30000000-0000-4000-8000-000000000003', 'bob-control@example.test');

insert into public.account_identities (issuer, subject, account_id, email, email_verified) values
  ('https://auth.example.test/', 'auth0|control-admin', '10000000-0000-4000-8000-000000000001', 'admin@example.test', true),
  ('https://auth.example.test/', 'auth0|control-alice', '20000000-0000-4000-8000-000000000002', 'alice-control@example.test', true),
  ('https://auth.example.test/', 'auth0|control-bob', '30000000-0000-4000-8000-000000000003', 'bob-control@example.test', true);

-- Schema, ACL, and security-definer boundaries.
select has_table('public', 'account_roles', 'Account roles are present');
select has_table('public', 'account_entitlements', 'Account entitlements are present');
select has_table('public', 'account_usage', 'Account usage is present');
select has_table('public', 'admin_audit_events', 'Admin audit events are present');
select ok(
  not has_table_privilege('authenticated', 'public.account_roles', 'select'),
  'Authenticated callers cannot read roles directly'
);
select ok(
  not has_table_privilege('authenticated', 'public.admin_audit_events', 'select'),
  'Authenticated callers cannot read audit events directly'
);
select ok(
  has_table_privilege('authenticated', 'public.account_entitlements', 'select'),
  'Authenticated callers receive entitlement select only'
);
select ok(
  has_table_privilege('authenticated', 'public.account_usage', 'select'),
  'Authenticated callers receive usage select only'
);
select ok(
  not has_table_privilege('authenticated', 'public.account_entitlements', 'insert'),
  'Authenticated callers cannot insert entitlements'
);
select ok(
  not has_table_privilege('authenticated', 'public.account_entitlements', 'update'),
  'Authenticated callers cannot update entitlements'
);
select ok(
  not has_table_privilege('authenticated', 'public.account_usage', 'update'),
  'Authenticated callers cannot update usage'
);
select ok(
  not has_table_privilege('service_role', 'public.account_roles', 'select'),
  'The reviewed service contract does not grant direct role reads'
);
select ok(
  not has_table_privilege('service_role', 'public.account_entitlements', 'update'),
  'The reviewed service contract does not grant direct entitlement writes'
);
select ok(
  has_function_privilege('service_role', 'public.bootstrap_super_admin(uuid,text)', 'execute'),
  'The service role can execute admin bootstrap'
);
select ok(
  not has_function_privilege('authenticated', 'public.bootstrap_super_admin(uuid,text)', 'execute'),
  'Authenticated callers cannot execute admin bootstrap'
);
select ok(
  has_function_privilege('service_role', 'public.admin_is_super_admin(uuid)', 'execute'),
  'The service role can execute the narrow admin-role check'
);
select ok(
  not has_function_privilege('authenticated', 'public.admin_is_super_admin(uuid)', 'execute'),
  'Authenticated callers cannot execute the admin-role check'
);
select ok(
  has_function_privilege('service_role', 'public.admin_list_accounts(uuid)', 'execute'),
  'The service role can execute account listing'
);
select ok(
  not has_function_privilege('authenticated', 'public.admin_list_accounts(uuid)', 'execute'),
  'Authenticated callers cannot execute account listing'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.admin_set_entitlement(uuid,uuid,text,text,boolean,boolean,bigint,integer,integer,integer,text)',
    'execute'
  ),
  'The service role can execute entitlement updates'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.admin_set_entitlement(uuid,uuid,text,text,boolean,boolean,bigint,integer,integer,integer,text)',
    'execute'
  ),
  'Authenticated callers cannot execute entitlement updates'
);
select ok(
  (select procedure.prosecdef
   from pg_catalog.pg_proc as procedure
   where procedure.oid = 'public.bootstrap_super_admin(uuid,text)'::regprocedure),
  'Bootstrap is security definer'
);
select ok(
  (select array_to_string(procedure.proconfig, ',') = 'search_path=""'
   from pg_catalog.pg_proc as procedure
   where procedure.oid = 'public.bootstrap_super_admin(uuid,text)'::regprocedure),
  'Bootstrap has an empty search path'
);
select ok(
  (select array_to_string(procedure.proconfig, ',') = 'search_path=""'
   from pg_catalog.pg_proc as procedure
   where procedure.oid = 'public.admin_list_accounts(uuid)'::regprocedure),
  'Account listing has an empty search path'
);
select ok(
  (select array_to_string(procedure.proconfig, ',') = 'search_path=""'
   from pg_catalog.pg_proc as procedure
   where procedure.oid = 'public.admin_set_entitlement(uuid,uuid,text,text,boolean,boolean,bigint,integer,integer,integer,text)'::regprocedure),
  'Entitlement updates have an empty search path'
);
select is(
  (select count(*)::integer
   from information_schema.columns
   where table_schema = 'public'
     and table_name in ('account_roles', 'account_entitlements', 'account_usage', 'admin_audit_events')
     and column_name in (
       'content', 'transcript', 'ciphertext', 'token', 'proof', 'signature',
       'public_key', 'encryption_public_key', 'signing_public_key', 'prompt', 'messages'
     )),
  0,
  'Control-plane tables expose no content or cryptographic material fields'
);
select is(
  (select count(*)::integer
   from pg_catalog.pg_proc as procedure
   cross join lateral unnest(procedure.proargnames) as argument_name
   where procedure.oid = 'public.admin_list_accounts(uuid)'::regprocedure
     and argument_name in (
       'content', 'transcript', 'ciphertext', 'token', 'proof', 'signature',
       'public_key', 'encryption_public_key', 'signing_public_key', 'prompt', 'messages'
     )),
  0,
  'Admin account listing has no content or cryptographic output fields'
);
select is(
  (select count(*)::integer
   from information_schema.tables
   where table_schema = 'public'
     and table_name in (
       'billing_providers', 'billing_transactions', 'payments', 'payment_methods',
       'transcripts'
     )),
  0,
  'The control plane creates no payment or transcript tables'
);

-- Existing profiles are backfilled with disabled, zero development state.
select is((select count(*)::integer from public.account_entitlements), 3, 'Existing profiles receive entitlement rows');
select is((select count(*)::integer from public.account_usage), 3, 'Existing profiles receive usage rows');
select ok(
  (select bool_and(
     plan_code = 'development'
     and status = 'active'
     and uploads_enabled = false
     and unmetered = false
     and storage_limit_bytes = 0
     and session_limit = 0
     and capsule_size_limit_bytes = 16777216
     and device_limit = 2
   ) from public.account_entitlements),
  'Development entitlements default to metered zero limits with uploads disabled'
);
select ok(
  (select bool_and(
     retained_storage_bytes = 0
     and capsule_count = 0
     and reserved_storage_bytes = 0
     and reserved_capsule_count = 0
     and monthly_egress_bytes = 0
   ) from public.account_usage),
  'Usage defaults to zero'
);

insert into public.profiles(id, email)
values ('40000000-0000-4000-8000-000000000004', 'future-control@example.test');
select is(
  (select count(*)::integer from public.account_entitlements where account_id = '40000000-0000-4000-8000-000000000004'),
  1,
  'A future profile transactionally receives one entitlement row'
);
select is(
  (select count(*)::integer from public.account_usage where account_id = '40000000-0000-4000-8000-000000000004'),
  1,
  'A future profile transactionally receives one usage row'
);
select ok(
  (select uploads_enabled = false
     and storage_limit_bytes = 0
     and session_limit = 0
     and retained_storage_bytes = 0
   from public.account_entitlements as entitlement
   join public.account_usage as usage using (account_id)
   where entitlement.account_id = '40000000-0000-4000-8000-000000000004'),
  'The profile trigger uses the same disabled zero defaults'
);

-- Authenticated visibility is own-row read-only access.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"iss":"https://auth.example.test/","sub":"auth0|control-alice","role":"authenticated"}',
  true
);
select is((select count(*)::integer from public.account_entitlements), 1, 'Alice sees only her entitlement');
select is(
  (select count(*)::integer from public.account_entitlements where account_id = '30000000-0000-4000-8000-000000000003'),
  0,
  'Alice cannot see Bob entitlement'
);
select is((select count(*)::integer from public.account_usage), 1, 'Alice sees only her usage');
select is(
  (select count(*)::integer from public.account_usage where account_id = '30000000-0000-4000-8000-000000000003'),
  0,
  'Alice cannot see Bob usage'
);
select throws_ok(
  $$update public.account_entitlements set uploads_enabled = true$$,
  '42501',
  null,
  'Alice cannot update even her own entitlement'
);
select throws_ok(
  $$insert into public.account_usage(account_id) values ('20000000-0000-4000-8000-000000000002')$$,
  '42501',
  null,
  'Alice cannot insert usage'
);
select throws_ok(
  $$delete from public.account_usage$$,
  '42501',
  null,
  'Alice cannot delete usage'
);
select throws_ok(
  $$select * from public.account_roles$$,
  '42501',
  null,
  'Alice cannot read account roles'
);
select throws_ok(
  $$select * from public.admin_audit_events$$,
  '42501',
  null,
  'Alice cannot read admin audit events'
);
select throws_ok(
  $$select public.bootstrap_super_admin('20000000-0000-4000-8000-000000000002', 'browser bypass')$$,
  '42501',
  null,
  'Alice cannot invoke service-only bootstrap'
);
reset role;

select throws_ok(
  $$update public.account_entitlements
    set unmetered = true
    where account_id = '20000000-0000-4000-8000-000000000002'$$,
  '23514',
  null,
  'The table enforces null product limits for unmetered accounts'
);
select throws_ok(
  $$update public.account_usage
    set reserved_storage_bytes = -1
    where account_id = '20000000-0000-4000-8000-000000000002'$$,
  '23514',
  null,
  'Usage counters cannot become negative'
);

-- Bootstrap is one-time, exact-state idempotent, and audited.
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  public.admin_is_super_admin('10000000-0000-4000-8000-000000000001'),
  false,
  'The narrow role check is false before bootstrap'
);
select lives_ok(
  $$select public.bootstrap_super_admin(
    '10000000-0000-4000-8000-000000000001',
    'Initial local control-plane owner'
  )$$,
  'The service bootstraps the first super admin'
);
select is(
  public.admin_is_super_admin('10000000-0000-4000-8000-000000000001'),
  true,
  'The narrow role check is true after bootstrap'
);
reset role;
select is((select count(*)::integer from public.account_roles), 1, 'Bootstrap creates exactly one account role');
select ok(
  (select status = 'active'
     and uploads_enabled = false
     and unmetered = true
     and storage_limit_bytes is null
     and session_limit is null
   from public.account_entitlements
   where account_id = '10000000-0000-4000-8000-000000000001'),
  'Bootstrap makes the owner active and unmetered while uploads remain disabled'
);
select is(
  (select count(*)::integer
   from public.admin_audit_events
   where action = 'admin.bootstrap'
     and actor_account_id = '10000000-0000-4000-8000-000000000001'
     and target_account_id = '10000000-0000-4000-8000-000000000001'),
  1,
  'Bootstrap creates one metadata-only audit event'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $$select public.bootstrap_super_admin(
    '10000000-0000-4000-8000-000000000001',
    'Initial local control-plane owner'
  )$$,
  'An exact bootstrap retry is idempotent'
);
reset role;
select is((select count(*)::integer from public.admin_audit_events), 1, 'An exact retry does not duplicate audit history');

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.bootstrap_super_admin(
    '10000000-0000-4000-8000-000000000001',
    'Different bootstrap metadata'
  )$$,
  '55000',
  null,
  'A bootstrap retry with different owner metadata is denied'
);
select throws_ok(
  $$select public.bootstrap_super_admin(
    '30000000-0000-4000-8000-000000000003',
    'Attempted second owner'
  )$$,
  '55000',
  null,
  'Bootstrap cannot create a second admin'
);
reset role;

-- Build metadata-only device fixtures for account-list aggregate coverage.
insert into public.devices(id, user_id, name, encryption_public_key, revoked_at) values
  ('21000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002', 'Alice active', repeat('a', 32), null),
  ('21000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 'Alice revoked', repeat('b', 32), clock_timestamp()),
  ('31000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000003', 'Bob active', repeat('c', 32), null);

insert into public.device_enrollment_requests(
  id, account_id, requested_name, encryption_public_key, signing_public_key,
  key_suite, fingerprint, possession_proof, created_at, expires_at
) values (
  '22000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  'Alice pending',
  '{"crv":"P-256","kty":"EC","x":"KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK","y":"LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL"}',
  '{"crv":"P-256","kty":"EC","x":"IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII","y":"JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ"}',
  'hpke-p256-hkdf-sha256-aes256gcm+ecdsa-p256-sha256',
  '67bd7d16a4eef35f057f22c909f2125c733470a4d8a01cff439d388c39a95d19',
  'alice-control-possession-proof',
  clock_timestamp(),
  clock_timestamp() + interval '10 minutes'
), (
  '32000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000003',
  'Bob stale pending',
  '{"crv":"P-256","kty":"EC","x":"OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO","y":"PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP"}',
  '{"crv":"P-256","kty":"EC","x":"MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM","y":"NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN"}',
  'hpke-p256-hkdf-sha256-aes256gcm+ecdsa-p256-sha256',
  'a8e696e67140e86c8acf278a02d2bf5befe891dd6f604311ccf9854beb14cfb3',
  'bob-control-possession-proof',
  clock_timestamp() - interval '12 minutes',
  clock_timestamp() - interval '2 minutes'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  (select count(*)::integer from public.admin_list_accounts('10000000-0000-4000-8000-000000000001')),
  4,
  'The super admin lists every provider-neutral profile'
);
select is(
  (select email from public.admin_list_accounts('10000000-0000-4000-8000-000000000001')
   where account_id = '20000000-0000-4000-8000-000000000002'),
  'alice-control@example.test',
  'The account list returns profile email metadata'
);
select ok(
  (select active_device_count = 1 and total_device_count = 2 and pending_enrollment_count = 1
   from public.admin_list_accounts('10000000-0000-4000-8000-000000000001')
   where account_id = '20000000-0000-4000-8000-000000000002'),
  'The account list reports Alice active, total, and pending device counts'
);
select ok(
  (select active_device_count = 1 and total_device_count = 1 and pending_enrollment_count = 0
   from public.admin_list_accounts('10000000-0000-4000-8000-000000000001')
   where account_id = '30000000-0000-4000-8000-000000000003'),
  'The account list excludes Bob stale enrollment from pending count'
);
select ok(
  (select unmetered = true and uploads_enabled = false
   from public.admin_list_accounts('10000000-0000-4000-8000-000000000001')
   where account_id = '10000000-0000-4000-8000-000000000001'),
  'The account list returns entitlement metadata without enabling uploads'
);
select throws_ok(
  $$select * from public.admin_list_accounts('20000000-0000-4000-8000-000000000002')$$,
  '42501',
  null,
  'A non-admin service actor cannot list accounts'
);
select throws_ok(
  $$select public.admin_set_entitlement(
    '20000000-0000-4000-8000-000000000002',
    '30000000-0000-4000-8000-000000000003',
    'development', 'active', false, false, 0, 0, 16777216, 2,
    'Unauthorized update'
  )$$,
  '42501',
  null,
  'A non-admin service actor cannot change entitlements'
);

select lives_ok(
  $$select public.admin_set_entitlement(
    '10000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000003',
    'team_preview', 'active', false, false, 1000, 3, 33554432, 4,
    'Scoped preview limits'
  )$$,
  'A super admin can set a validated target entitlement'
);
reset role;
select ok(
  (select plan_code = 'team_preview'
     and status = 'active'
     and uploads_enabled = false
     and unmetered = false
     and storage_limit_bytes = 1000
     and session_limit = 3
     and capsule_size_limit_bytes = 33554432
     and device_limit = 4
     and updated_by = '10000000-0000-4000-8000-000000000001'
   from public.account_entitlements
   where account_id = '30000000-0000-4000-8000-000000000003'),
  'The target receives only the requested metadata limits'
);
select ok(
  (select plan_code = 'development'
     and uploads_enabled = false
     and storage_limit_bytes = 0
     and session_limit = 0
   from public.account_entitlements
   where account_id = '20000000-0000-4000-8000-000000000002'),
  'A scoped update leaves another normal account unchanged'
);
select is(
  (select count(*)::integer
   from public.admin_audit_events
   where action = 'admin.entitlement.set'
     and actor_account_id = '10000000-0000-4000-8000-000000000001'
     and target_account_id = '30000000-0000-4000-8000-000000000003'),
  1,
  'An entitlement change creates an actor-and-target audit event'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.admin_set_entitlement(
    '10000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000003',
    'unsafe', 'active', false, false, 1000, 3, 67108865, 4,
    'Reject unsafe capsule size'
  )$$,
  '22023',
  null,
  'Even a super admin cannot exceed the 64 MiB capsule cap'
);
select throws_ok(
  $$select public.admin_set_entitlement(
    '10000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000003',
    'unsafe', 'active', false, false, 1000, 3, 67108864, 33,
    'Reject unsafe device count'
  )$$,
  '22023',
  null,
  'Even a super admin cannot exceed the 32-device cap'
);
select throws_ok(
  $$select public.admin_set_entitlement(
    '10000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000003',
    'unsafe', 'active', false, true, 1000, 3, 16777216, 2,
    'Reject mixed metering state'
  )$$,
  '22023',
  null,
  'The admin RPC enforces the unmetered null-limit invariant'
);
reset role;
select is((select count(*)::integer from public.admin_audit_events), 2, 'Rejected updates create no audit events');
select throws_ok(
  $$update public.account_entitlements
    set capsule_size_limit_bytes = 67108865
    where account_id = '20000000-0000-4000-8000-000000000002'$$,
  '23514',
  null,
  'The global capsule cap also exists as a table constraint'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $$select public.admin_set_entitlement(
    '10000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000003',
    'internal', 'active', false, true, null, null, 16777216, 2,
    'Internal unmetered account'
  )$$,
  'A super admin can explicitly set a valid unmetered entitlement'
);
reset role;
select ok(
  (select unmetered = true
     and storage_limit_bytes is null
     and session_limit is null
     and uploads_enabled = false
   from public.account_entitlements
   where account_id = '30000000-0000-4000-8000-000000000003'),
  'The valid unmetered state retains disabled uploads and null product limits'
);
select is((select count(*)::integer from public.admin_audit_events), 3, 'The second accepted update is audited');

-- Optional role administration remains service-only, reasoned, and audited.
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $$select public.admin_grant_role(
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000002',
    'support_readonly',
    'Temporary support coverage'
  )$$,
  'A super admin can grant a bounded provider-neutral role'
);
reset role;
select is(
  (select count(*)::integer
   from public.account_roles
   where account_id = '20000000-0000-4000-8000-000000000002' and role = 'support_readonly'),
  1,
  'The support role is stored once'
);
select is(
  (select count(*)::integer from public.admin_audit_events where action = 'admin.role.grant'),
  1,
  'The role grant is audited'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $$select public.admin_grant_role(
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000002',
    'support_readonly',
    'Temporary support coverage'
  )$$,
  'An exact role-grant retry is idempotent'
);
reset role;
select is((select count(*)::integer from public.admin_audit_events), 4, 'The exact role retry does not duplicate audit history');

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  public.admin_revoke_role(
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000002',
    'support_readonly',
    'Support coverage ended'
  ),
  true,
  'A super admin can revoke the delegated role'
);
reset role;
select is(
  (select count(*)::integer
   from public.account_roles
   where account_id = '20000000-0000-4000-8000-000000000002' and role = 'support_readonly'),
  0,
  'The delegated role is removed'
);
select is(
  (select count(*)::integer from public.admin_audit_events where action = 'admin.role.revoke'),
  1,
  'The role revocation is audited'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.admin_revoke_role(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'super_admin',
    'Unsafe final-admin removal'
  )$$,
  '55000',
  null,
  'The final super admin cannot be revoked'
);
reset role;

-- Audit rows are append-only and reject content-shaped or oversized details.
select throws_ok(
  $$update public.admin_audit_events set reason = 'rewritten'$$,
  '55000',
  null,
  'Audit events cannot be updated'
);
select throws_ok(
  $$delete from public.admin_audit_events$$,
  '55000',
  null,
  'Audit events cannot be deleted'
);
select throws_ok(
  $$insert into public.admin_audit_events(
      actor_account_id, target_account_id, action, reason, details
    ) values (
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000002',
      'admin.invalid',
      'Content must not enter audit details',
      '{"content":"forbidden"}'::jsonb
    )$$,
  '23514',
  null,
  'Audit details reject content fields'
);
select throws_ok(
  $$insert into public.admin_audit_events(
      actor_account_id, target_account_id, action, reason, details
    ) values (
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000002',
      'admin.invalid',
      'Key material must not enter audit details',
      '{"key":"forbidden"}'::jsonb
    )$$,
  '23514',
  null,
  'Audit details reject generic key fields'
);
select throws_ok(
  $$insert into public.admin_audit_events(
      actor_account_id, target_account_id, action, reason, details
    ) values (
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000002',
      'admin.invalid',
      'Oversized metadata must not enter audit details',
      jsonb_build_object('metadata', repeat('x', 5000))
    )$$,
  '23514',
  null,
  'Audit details enforce the JSON size bound'
);
select is((select count(*)::integer from public.admin_audit_events), 5, 'Only reviewed successful mutations remain in audit history');

select * from finish();
rollback;

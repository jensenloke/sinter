begin;
select plan(53);

insert into public.profiles(id, email, deletion_requested_at) values
  ('41000000-0000-4000-8000-000000000001', 'member@example.test', null),
  ('42000000-0000-4000-8000-000000000002', 'pending-deletion@example.test', clock_timestamp()),
  ('43000000-0000-4000-8000-000000000003', 'suspended@example.test', null);

update public.account_entitlements
set status = 'suspended'
where account_id = '43000000-0000-4000-8000-000000000003';

insert into public.account_identities(issuer, subject, account_id, email, email_verified) values
  ('https://auth.example.test/', 'auth0|member-primary', '41000000-0000-4000-8000-000000000001', 'member@example.test', true),
  ('https://auth.example.test/', 'auth0|pending-deletion', '42000000-0000-4000-8000-000000000002', 'pending-deletion@example.test', true),
  ('https://auth.example.test/', 'auth0|suspended', '43000000-0000-4000-8000-000000000003', 'suspended@example.test', true);

insert into public.account_roles(account_id, role, reason) values
  ('41000000-0000-4000-8000-000000000001', 'support_readonly', 'Synthetic claim-gate fixture');

insert into public.devices(id, user_id, name, encryption_public_key) values
  ('44000000-0000-4000-8000-000000000004', '41000000-0000-4000-8000-000000000001', 'Synthetic device', repeat('x', 32));

insert into public.admin_audit_events(actor_account_id, target_account_id, action, reason) values
  ('41000000-0000-4000-8000-000000000001', '41000000-0000-4000-8000-000000000001', 'claim.fixture', 'Synthetic claim-gate fixture');

select ok(
  (select procedure.prosecdef
   from pg_catalog.pg_proc as procedure
   where procedure.oid = 'public.claim_account()'::regprocedure),
  'Account claim remains security definer'
);
select ok(
  (select array_to_string(procedure.proconfig, ',') = 'search_path=""'
   from pg_catalog.pg_proc as procedure
   where procedure.oid = 'public.claim_account()'::regprocedure),
  'Account claim retains an empty search path'
);
select ok(
  has_function_privilege('authenticated', 'public.claim_account()', 'execute'),
  'Authenticated callers retain claim execution'
);
select ok(
  not has_function_privilege('anon', 'public.claim_account()', 'execute'),
  'Anonymous callers cannot execute account claim'
);
select ok(
  not has_function_privilege('service_role', 'public.claim_account()', 'execute'),
  'Service role claim execution remains ungranted'
);
select ok(
  not has_table_privilege('authenticated', 'public.profiles', 'insert'),
  'Authenticated callers retain no profile insertion privilege'
);
select ok(
  not has_column_privilege('authenticated', 'public.profiles', 'email', 'update'),
  'Authenticated callers cannot rewrite the provider-link email'
);
select ok(
  has_column_privilege('authenticated', 'public.profiles', 'deletion_requested_at', 'update'),
  'Authenticated callers retain the narrow deletion-request update grant'
);
select ok(
  (select index_definition.indisunique
   from pg_catalog.pg_index as index_definition
   where index_definition.indexrelid = 'public.profiles_claim_normalized_email_idx'::regclass),
  'Normalized profile email matching is uniquely indexed'
);
select ok(
  (select pg_catalog.strpos(procedure.prosrc, 'pg_advisory_xact_lock') > 0
   from pg_catalog.pg_proc as procedure
   where procedure.oid = 'public.claim_account()'::regprocedure),
  'Account claim serializes competing identity and email claims'
);
select ok(
  (select procedure.prosrc !~* 'insert[[:space:]]+into[[:space:]]+public[.]profiles'
   from pg_catalog.pg_proc as procedure
   where procedure.oid = 'public.claim_account()'::regprocedure),
  'Authenticated account claim contains no profile insertion path'
);
select throws_ok(
  $$insert into public.profiles(id, email)
    values ('45000000-0000-4000-8000-000000000005', '  MEMBER@EXAMPLE.TEST  ')$$,
  '23505',
  null,
  'Normalized profile emails cannot become ambiguous'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"iss":"https://auth.example.test/","sub":"auth0|member-primary","role":"authenticated"}',
  true
);
select is(
  public.claim_account(),
  '41000000-0000-4000-8000-000000000001'::uuid,
  'An exact issuer and subject returns its existing account without email claims'
);
select set_config(
  'request.jwt.claims',
  '{"iss":"https://auth.example.test/","sub":"auth0|member-primary","email":"renamed@example.test","email_verified":true,"role":"authenticated"}',
  true
);
select is(
  public.claim_account(),
  '41000000-0000-4000-8000-000000000001'::uuid,
  'An existing direct identity remains stable after a verified email change'
);
select throws_ok(
  $$update public.profiles
    set email = 'attacker-controlled@example.test'
    where id = '41000000-0000-4000-8000-000000000001'$$,
  '42501',
  null,
  'An authenticated member cannot rewrite their provider-link email'
);
reset role;
select is(
  (select account_id from public.account_identities
   where issuer = 'https://auth.example.test/' and subject = 'auth0|member-primary'),
  '41000000-0000-4000-8000-000000000001'::uuid,
  'A changed email never relinks an existing direct identity'
);
select is(
  (select email from public.profiles where id = '41000000-0000-4000-8000-000000000001'),
  'member@example.test',
  'Claim metadata changes do not modify the profile email'
);
select is(
  (select count(*)::integer from public.account_identities),
  3,
  'Exact identity claims do not create identities'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"iss":"https://second.example.test/","sub":"oidc|member","email":"  MEMBER@EXAMPLE.TEST  ","email_verified":true,"role":"authenticated"}',
  true
);
select is(
  public.claim_account(),
  '41000000-0000-4000-8000-000000000001'::uuid,
  'A second provider links to the one existing profile by normalized verified email'
);
reset role;
select ok(
  (select account_id = '41000000-0000-4000-8000-000000000001'
      and email = 'member@example.test'
      and email_verified
   from public.account_identities
   where issuer = 'https://second.example.test/' and subject = 'oidc|member'),
  'The linked identity stores the normalized verified claim and existing account ID'
);
select is(
  (select count(*)::integer from public.account_identities
   where account_id = '41000000-0000-4000-8000-000000000001'),
  2,
  'A provider link inserts exactly one identity'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"iss":"https://second.example.test/","sub":"oidc|member","email":"suspended@example.test","email_verified":true,"role":"authenticated"}',
  true
);
select is(
  public.claim_account(),
  '41000000-0000-4000-8000-000000000001'::uuid,
  'An already linked provider cannot move accounts after its email changes'
);
reset role;
select is(
  (select account_id from public.account_identities
   where issuer = 'https://second.example.test/' and subject = 'oidc|member'),
  '41000000-0000-4000-8000-000000000001'::uuid,
  'The existing provider link remains bound to its original account'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"iss":"https://auth.example.test/","sub":"auth0|pending-deletion","role":"authenticated"}',
  true
);
select is(
  public.claim_account(),
  '42000000-0000-4000-8000-000000000002'::uuid,
  'A deletion-requested account keeps its existing identity behavior'
);
select set_config(
  'request.jwt.claims',
  '{"iss":"https://auth.example.test/","sub":"auth0|suspended","role":"authenticated"}',
  true
);
select is(
  public.claim_account(),
  '43000000-0000-4000-8000-000000000003'::uuid,
  'A suspended account keeps its existing identity behavior'
);
reset role;
select ok(
  (select deletion_requested_at is not null
   from public.profiles where id = '42000000-0000-4000-8000-000000000002'),
  'Claiming preserves the deletion-requested state'
);
select is(
  (select status from public.account_entitlements
   where account_id = '43000000-0000-4000-8000-000000000003'),
  'suspended',
  'Claiming preserves the suspended entitlement state'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"iss":"https://new-provider.example.test/","sub":"oidc|pending-link","email":"pending-deletion@example.test","email_verified":true,"role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.claim_account()$$,
  '42501',
  'account claim is not authorized',
  'A new provider cannot link to a deletion-requested account'
);
select set_config(
  'request.jwt.claims',
  '{"iss":"https://new-provider.example.test/","sub":"oidc|suspended-link","email":"suspended@example.test","email_verified":true,"role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.claim_account()$$,
  '42501',
  'account claim is not authorized',
  'A new provider cannot link to a suspended account'
);
reset role;

create temporary table claim_gate_count_baseline as
select
  (select count(*) from public.profiles) as profiles,
  (select count(*) from public.account_identities) as identities,
  (select count(*) from public.account_entitlements) as entitlements,
  (select count(*) from public.account_usage) as usage,
  (select count(*) from public.account_roles) as roles,
  (select count(*) from public.devices) as devices,
  (select count(*) from public.admin_audit_events) as audits;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"iss":"https://third.example.test/","sub":"oidc|unverified","email":"member@example.test","email_verified":false,"role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.claim_account()$$,
  '42501',
  'account claim is not authorized',
  'A new identity with an unverified email is denied without enumeration'
);
select set_config(
  'request.jwt.claims',
  '{"iss":"https://third.example.test/","sub":"oidc|unknown","email":"unknown@example.test","email_verified":true,"role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.claim_account()$$,
  '42501',
  'account claim is not authorized',
  'A verified identity with no existing profile is denied without enumeration'
);
select set_config(
  'request.jwt.claims',
  '{"iss":"https://third.example.test/","sub":"oidc|missing-email","email_verified":true,"role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.claim_account()$$,
  '42501',
  'account claim is not authorized',
  'A new identity missing its email claim is denied'
);
select set_config(
  'request.jwt.claims',
  '{"iss":"https://third.example.test/","sub":"oidc|missing-verification","email":"member@example.test","role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.claim_account()$$,
  '42501',
  'account claim is not authorized',
  'A new identity missing its verification claim is denied'
);
select set_config(
  'request.jwt.claims',
  '{"sub":"oidc|missing-issuer","email":"member@example.test","email_verified":true,"role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.claim_account()$$,
  '42501',
  'account claim is not authorized',
  'A claim missing issuer is denied with the fixed authorization error'
);
select set_config(
  'request.jwt.claims',
  '{"iss":"https://third.example.test/","email":"member@example.test","email_verified":true,"role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.claim_account()$$,
  '42501',
  'account claim is not authorized',
  'A claim missing subject is denied with the fixed authorization error'
);
select set_config(
  'request.jwt.claims',
  '{"iss":"https://third.example.test/","sub":"oidc|string-verification","email":"member@example.test","email_verified":"true","role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.claim_account()$$,
  '42501',
  'account claim is not authorized',
  'Only a signed boolean true verification claim is accepted'
);
reset role;

select is(
  (select count(*) from public.profiles),
  (select profiles from claim_gate_count_baseline),
  'Denied claims leave profile count unchanged'
);
select is(
  (select count(*) from public.account_identities),
  (select identities from claim_gate_count_baseline),
  'Denied claims leave identity count unchanged'
);
select is(
  (select count(*) from public.account_entitlements),
  (select entitlements from claim_gate_count_baseline),
  'Denied claims leave entitlement count unchanged'
);
select is(
  (select count(*) from public.account_usage),
  (select usage from claim_gate_count_baseline),
  'Denied claims leave usage count unchanged'
);
select is(
  (select count(*) from public.account_roles),
  (select roles from claim_gate_count_baseline),
  'Denied claims leave role count unchanged'
);
select is(
  (select count(*) from public.devices),
  (select devices from claim_gate_count_baseline),
  'Denied claims leave device count unchanged'
);
select is(
  (select count(*) from public.admin_audit_events),
  (select audits from claim_gate_count_baseline),
  'Denied claims leave audit count unchanged'
);

select is(
  (select count(*)::integer
   from pg_catalog.pg_class as relation
   join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
   where namespace.nspname = 'public'
     and relation.relname in (
       'profiles', 'account_identities', 'devices', 'device_enrollment_requests',
       'account_roles', 'account_entitlements', 'account_usage', 'admin_audit_events'
     )
     and relation.relrowsecurity),
  8,
  'All existing account and control-plane tables retain RLS'
);
select is(
  (select pg_catalog.array_agg(
     policy.tablename || ':' || policy.policyname || ':' || policy.cmd
     order by policy.tablename, policy.policyname, policy.cmd
   )
   from pg_catalog.pg_policies as policy
   where policy.schemaname = 'public'),
  array[
    'account_entitlements:account_entitlements_select_own:SELECT',
    'account_usage:account_usage_select_own:SELECT',
    'capsule_recipients:capsule_recipients_select_own:SELECT',
    'capsules:capsules_select_own:SELECT',
    'device_enrollment_requests:device_enrollment_requests_select_own:SELECT',
    'devices:devices_select_own:SELECT',
    'devices:devices_update_safe_own:UPDATE',
    'profiles:profiles_select_own:SELECT',
    'profiles:profiles_update_own:UPDATE'
  ]::text[],
  'The RLS policy inventory includes provider-neutral capsule ownership'
);
select is(
  (select count(*)::integer
   from pg_catalog.pg_policies as policy
   where policy.schemaname = 'public'
     and (
       coalesce(policy.qual, '') || coalesce(policy.with_check, '')
     ) like '%current_account_id()%'),
  9,
  'Every account RLS policy resolves provider-neutral account identity'
);
select ok(
  not has_table_privilege('authenticated', 'public.account_identities', 'select'),
  'Authenticated callers retain no direct identity-table reads'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"iss":"https://second.example.test/","sub":"oidc|member","role":"authenticated"}',
  true
);
select is(
  public.current_account_id(),
  '41000000-0000-4000-8000-000000000001'::uuid,
  'A linked provider resolves the same provider-neutral account under RLS'
);
select is((select count(*)::integer from public.profiles), 1, 'The linked provider sees one own profile');
select is((select count(*)::integer from public.account_entitlements), 1, 'The linked provider sees one own entitlement');
select is((select count(*)::integer from public.account_usage), 1, 'The linked provider sees one own usage row');
select is((select count(*)::integer from public.devices), 1, 'The linked provider sees one own device');
select is_empty(
  $$update public.profiles
    set deletion_requested_at = clock_timestamp()
    where id = '42000000-0000-4000-8000-000000000002'
    returning id$$,
  'The linked provider still cannot update another profile'
);
reset role;

select * from finish();
rollback;

begin;
select plan(10);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.test'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.test');
insert into public.profiles (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.test'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.test');

set local role authenticated;
select set_config('request.jwt.claims', '{"iss":"https://auth.example.test/","sub":"auth0|bob","email":"bob@example.test","email_verified":true,"role":"authenticated"}', true);
select lives_ok($$select public.claim_account()$$, 'Bob can claim a provider-neutral account');
select set_config('request.jwt.claims', '{"iss":"https://auth.example.test/","sub":"auth0|alice","email":"alice@example.test","email_verified":true,"role":"authenticated"}', true);
select lives_ok($$select public.claim_account()$$, 'Alice can claim a provider-neutral account');
select lives_ok($$select public.claim_account()$$, 'Claiming the same identity is idempotent');

select is((select count(*)::integer from public.profiles), 1, 'Alice sees only her profile');
select is((select count(*)::integer from public.devices), 0, 'Alice initially has no device');
select is((select count(*)::integer from public.devices where user_id='22222222-2222-2222-2222-222222222222'), 0, 'Bob devices are not visible');
select throws_ok(
  $$insert into public.devices(user_id,name,encryption_public_key) values ('11111111-1111-1111-1111-111111111111','Alice laptop','legacy-key-material-that-is-public-only')$$,
  '42501',
  null,
  'Alice cannot insert a device directly'
);
select lives_ok($$update public.profiles set deletion_requested_at=now() where id='11111111-1111-1111-1111-111111111111'$$, 'Alice can update her profile');
select is((select count(*)::integer from public.profiles where deletion_requested_at is not null), 1, 'Alice update is visible');
select ok(
  not has_table_privilege('authenticated', 'public.devices', 'insert'),
  'Authenticated callers have no direct device insert grant'
);

reset role;

select * from finish();
rollback;

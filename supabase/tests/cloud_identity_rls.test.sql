begin;
select plan(9);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.test'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.test');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);

select is((select count(*)::integer from public.profiles), 1, 'Alice sees only her profile');
select lives_ok($$insert into public.devices(user_id,name,public_key) values ('11111111-1111-1111-1111-111111111111','Alice laptop',repeat('a',32))$$, 'Alice can add her device');
select throws_ok($$insert into public.devices(user_id,name,public_key) values ('22222222-2222-2222-2222-222222222222','Bob laptop',repeat('b',32))$$, '42501', null, 'Alice cannot add Bob device');
select is((select count(*)::integer from public.devices), 1, 'Alice sees only her device');
select is((select count(*)::integer from public.devices where user_id='22222222-2222-2222-2222-222222222222'), 0, 'Bob device is not visible');
select lives_ok($$update public.profiles set deletion_requested_at=now() where user_id='11111111-1111-1111-1111-111111111111'$$, 'Alice can update her profile');
select is((select count(*)::integer from public.profiles where deletion_requested_at is not null), 1, 'Alice update is visible');
select lives_ok($$delete from public.devices where user_id='22222222-2222-2222-2222-222222222222'$$, 'Cross-user delete reveals no row');

reset role;
select is((select count(*)::integer from public.devices), 1, 'Bob data was not deleted');

select * from finish();
rollback;

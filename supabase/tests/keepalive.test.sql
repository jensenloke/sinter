begin;
select plan(3);

select ok(
  has_function_privilege('anon', 'public.keepalive()', 'execute'),
  'Anonymous API clients may execute only the content-free keepalive RPC'
);
select ok(
  has_function_privilege('authenticated', 'public.keepalive()', 'execute'),
  'Authenticated API clients may execute the keepalive RPC'
);

set local role anon;
select ok(public.keepalive() is not null, 'Keepalive returns a database timestamp');

select * from finish();
rollback;

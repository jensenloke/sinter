create function public.keepalive()
returns timestamptz
language sql
volatile
security invoker
set search_path = ''
as $$
  select clock_timestamp();
$$;

revoke all on function public.keepalive() from public;
grant execute on function public.keepalive() to anon, authenticated;

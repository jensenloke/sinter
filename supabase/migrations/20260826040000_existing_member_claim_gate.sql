create unique index profiles_claim_normalized_email_idx
  on public.profiles ((nullif(pg_catalog.lower(pg_catalog.btrim(email)), '')))
  where nullif(pg_catalog.lower(pg_catalog.btrim(email)), '') is not null;

revoke update on public.profiles from authenticated;
grant update (deletion_requested_at) on public.profiles to authenticated;

create or replace function public.claim_account()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  claims jsonb := auth.jwt();
  token_issuer text := claims->>'iss';
  token_subject text := claims->>'sub';
  token_email text := nullif(
    pg_catalog.lower(pg_catalog.btrim(claims->>'email')),
    ''
  );
  token_email_verified boolean := coalesce(
    claims->'email_verified' = 'true'::jsonb,
    false
  );
  matched_account_id uuid;
  matched_account_count integer := 0;
  result uuid;
begin
  if auth.role() is distinct from 'authenticated'
    or token_issuer is null
    or pg_catalog.btrim(token_issuer) = ''
    or pg_catalog.char_length(token_issuer) not between 8 and 512
    or token_subject is null
    or pg_catalog.btrim(token_subject) = ''
    or pg_catalog.char_length(token_subject) not between 1 and 512 then
    raise exception using
      errcode = '42501',
      message = 'account claim is not authorized';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-identity:' || token_issuer || pg_catalog.chr(31) || token_subject,
      0
    )
  );

  select identity.account_id into result
  from public.account_identities as identity
  where identity.issuer = token_issuer
    and identity.subject = token_subject
  for update;

  if found then
    update public.account_identities as identity
    set last_seen_at = pg_catalog.now(),
        email = case
          when token_email_verified and token_email is not null then token_email
          else identity.email
        end,
        email_verified = identity.email_verified or (
          token_email_verified and token_email is not null
        )
    where identity.issuer = token_issuer
      and identity.subject = token_subject;

    return result;
  end if;

  if not token_email_verified or token_email is null then
    raise exception using
      errcode = '42501',
      message = 'account claim is not authorized';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('account-email:' || token_email, 0)
  );

  for matched_account_id in
    select profile.id
    from public.profiles as profile
    join public.account_entitlements as entitlement
      on entitlement.account_id = profile.id
    where nullif(
      pg_catalog.lower(pg_catalog.btrim(profile.email)),
      ''
    ) = token_email
      and profile.deletion_requested_at is null
      and entitlement.status = 'active'
    order by profile.id
    for key share
  loop
    matched_account_count := matched_account_count + 1;
    result := matched_account_id;
  end loop;

  if matched_account_count <> 1 then
    raise exception using
      errcode = '42501',
      message = 'account claim is not authorized';
  end if;

  insert into public.account_identities(
    issuer,
    subject,
    account_id,
    email,
    email_verified
  ) values (
    token_issuer,
    token_subject,
    result,
    token_email,
    true
  );

  return result;
end;
$$;

revoke all on function public.claim_account() from public, anon, service_role;
grant execute on function public.claim_account() to authenticated;

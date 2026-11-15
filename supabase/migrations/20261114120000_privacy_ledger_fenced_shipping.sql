/* Fenced single-writer lease for the external privacy ledger. The lease lives
   in the main project because it coordinates the main outbox; the immutable
   encrypted ledger itself lives in the separate Storage project. */
create table if not exists private.privacy_ledger_writer_lease (
  id boolean primary key default true check (id),
  owner uuid,
  fencing_token bigint not null default 0,
  expires_at timestamptz not null default '-infinity'
);
insert into private.privacy_ledger_writer_lease(id) values (true) on conflict (id) do nothing;
revoke all on private.privacy_ledger_writer_lease from public, anon, authenticated;

create or replace function privacy_ledger_acquire_lease(p_owner uuid, p_lease_seconds int default 120)
returns table (fencing_token bigint, expires_at timestamptz)
language plpgsql security definer set search_path = public, private
as $$
declare v private.privacy_ledger_writer_lease%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' and session_user not in ('postgres', 'supabase_admin') then raise exception 'not_authorized' using errcode = '42501'; end if;
  select * into v from private.privacy_ledger_writer_lease where id for update;
  if v.expires_at > clock_timestamp() and v.owner is distinct from p_owner then return; end if;
  if v.owner is distinct from p_owner or v.expires_at <= clock_timestamp() then
    update private.privacy_ledger_writer_lease as lease
       set owner = p_owner, fencing_token = lease.fencing_token + 1,
           expires_at = clock_timestamp() + make_interval(secs => greatest(15, least(coalesce(p_lease_seconds, 120), 300)))
     where id returning * into v;
  else
    update private.privacy_ledger_writer_lease
       set expires_at = clock_timestamp() + make_interval(secs => greatest(15, least(coalesce(p_lease_seconds, 120), 300)))
     where id returning * into v;
  end if;
  return query select v.fencing_token, v.expires_at;
end;
$$;
revoke all on function privacy_ledger_acquire_lease(uuid, int) from public, anon, authenticated;
grant execute on function privacy_ledger_acquire_lease(uuid, int) to service_role;

create or replace function privacy_ledger_release_lease(p_owner uuid, p_fencing_token bigint)
returns boolean language plpgsql security definer set search_path = public, private
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' and session_user not in ('postgres', 'supabase_admin') then raise exception 'not_authorized' using errcode = '42501'; end if;
  update private.privacy_ledger_writer_lease set owner = null, expires_at = '-infinity'
   where id and owner = p_owner and fencing_token = p_fencing_token;
  return found;
end;
$$;
revoke all on function privacy_ledger_release_lease(uuid, bigint) from public, anon, authenticated;
grant execute on function privacy_ledger_release_lease(uuid, bigint) to service_role;

/* Read the checkpoint used to reject a separate or truncated Storage chain. */
create or replace function privacy_ledger_checkpoint()
returns table (ledger_seq bigint, chain text)
language plpgsql stable security definer set search_path = public, private
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' and session_user not in ('postgres', 'supabase_admin') then raise exception 'not_authorized' using errcode = '42501'; end if;
  return query select h.ledger_seq, h.chain from public.privacy_ledger_head h where h.id = true;
end;
$$;
revoke all on function privacy_ledger_checkpoint() from public, anon, authenticated;
grant execute on function privacy_ledger_checkpoint() to service_role;

/* Remove the unfenced entry point so callers cannot bypass fencing. */
drop function if exists privacy_ledger_mark_shipped(uuid[], bigint, text);
drop function if exists privacy_ledger_mark_shipped(uuid[], bigint, text, bigint);
create or replace function privacy_ledger_mark_shipped(
  p_event_ids uuid[], p_ledger_seq bigint, p_chain text, p_fencing_token bigint, p_owner uuid
) returns void language plpgsql security definer set search_path = public, private
as $$
declare v_lease private.privacy_ledger_writer_lease%rowtype; v_current bigint;
begin
  if coalesce(auth.role(), '') <> 'service_role' and session_user not in ('postgres', 'supabase_admin') then raise exception 'not_authorized' using errcode = '42501'; end if;
  if p_fencing_token is null then raise exception 'ledger_fence_required' using errcode = '42501'; end if;
  select * into v_lease from private.privacy_ledger_writer_lease where id for update;
  if v_lease.fencing_token <> p_fencing_token or v_lease.owner is distinct from p_owner or v_lease.expires_at <= clock_timestamp() then
    raise exception 'ledger_lease_lost' using errcode = '55P03';
  end if;
  if coalesce(array_length(p_event_ids, 1), 0) = 0 then raise exception 'ledger_empty_checkpoint' using errcode = '22023'; end if;
  select max(seq) into v_current from privacy_ledger_outbox where event_id = any(p_event_ids);
  if v_current is null or (select count(*) from privacy_ledger_outbox where event_id = any(p_event_ids)) <> array_length(p_event_ids, 1) then
    raise exception 'ledger_event_missing' using errcode = '22023';
  end if;
  update privacy_ledger_outbox set shipped_at = now() where event_id = any(p_event_ids) and shipped_at is null;
  if p_ledger_seq > 0 then
    insert into privacy_ledger_head(id, ledger_seq, chain) values (true, p_ledger_seq, p_chain)
    on conflict (id) do update set ledger_seq = excluded.ledger_seq, chain = excluded.chain, recorded_at = now()
     where privacy_ledger_head.ledger_seq < excluded.ledger_seq;
  end if;
  delete from privacy_ledger_outbox where shipped_at < now() - interval '30 days';
end;
$$;
revoke all on function privacy_ledger_mark_shipped(uuid[], bigint, text, bigint, uuid) from public, anon, authenticated;
grant execute on function privacy_ledger_mark_shipped(uuid[], bigint, text, bigint, uuid) to service_role;

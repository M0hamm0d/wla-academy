-- Keep the RPC result type stable if mission_gifts.status uses a distinct enum.
create or replace function admin_gifts(p_limit int default 100)
returns table (
  id uuid, created_at timestamptz, mission_title text,
  purchaser_email text,
  amount_minor int, currency text, status gift_status,
  paid_at timestamptz, redeemed_at timestamptz,
  redeemed_by_email text, redeemed_child_name text,
  consent_recorded boolean, confirmation_sent boolean
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_admin() then raise exception 'not_admin' using errcode = '42501'; end if;

  return query
  select g.id, g.created_at, m.title, buyer.email,
         g.amount_minor, g.currency, g.status::text::gift_status,
         g.paid_at, g.redeemed_at, redeemer.email, c.display_name,
         g.early_supply_consent_at is not null and g.cancellation_ack_at is not null,
         g.confirmation_sent_at is not null
  from mission_gifts g
  join missions m on m.id = g.mission_id
  left join profiles buyer on buyer.id = g.purchaser_id
  left join profiles redeemer on redeemer.id = g.redeemed_by
  left join child_profiles c on c.id = g.redeemed_child_id
  order by g.created_at desc
  limit greatest(1, least(coalesce(p_limit, 100), 200));
end;
$$;

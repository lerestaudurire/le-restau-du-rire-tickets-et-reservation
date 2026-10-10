-- À exécuter une fois dans Supabase > SQL Editor (réexécutable sans risque)

-- ===== Paiement SimplyPaye =====
alter table public.reservations add column if not exists pay_ref text;
alter table public.reservations add column if not exists pay_provider text;
alter table public.orders       add column if not exists pay_ref text;
alter table public.orders       add column if not exists pay_provider text;

-- ===== Réservations "payer plus tard" =====
alter table public.reservations add column if not exists hold boolean not null default false;
alter table public.reservations add column if not exists expires_at timestamptz;
alter table public.orders       add column if not exists hold boolean not null default false;
alter table public.orders       add column if not exists expires_at timestamptz;

-- Commandes gratuites / à payer plus tard : pas de capture, pas de payeur
alter table public.reservations alter column proof_path drop not null;
alter table public.orders       alter column proof_path drop not null;
alter table public.reservations alter column payer drop not null;
alter table public.reservations alter column rec   drop not null;
alter table public.orders       alter column payer drop not null;
alter table public.orders       alter column rec   drop not null;

create index if not exists reservations_pay_idx  on public.reservations (pay_provider, status, created_at);
create index if not exists orders_pay_idx        on public.orders       (pay_provider, status, created_at);
create index if not exists reservations_hold_idx on public.reservations (hold, status, expires_at);
create index if not exists orders_hold_idx       on public.orders       (hold, status, expires_at);

-- Libère les places des réservations non payées à temps (appelée par le site à chaque ouverture)
create or replace function public.expire_holds()
returns void language sql security definer set search_path = public as $$
  update public.orders       set status = 'cancelled' where hold and status = 'pending' and pay_ref is null and expires_at < now();
  update public.reservations set status = 'cancelled' where hold and status = 'pending' and pay_ref is null and expires_at < now();
$$;
grant execute on function public.expire_holds() to anon, authenticated;

-- (Optionnel) nettoyage automatique toutes les 10 min si l'extension pg_cron est activée :
-- select cron.schedule('expire-holds', '*/10 * * * *', 'select public.expire_holds()');

-- ---------- Parceiros e Clube de Vantagens (atualização 2, 24/11/2026) ----------
create table if not exists public.parceiros (
  id         uuid primary key default gen_random_uuid(),
  nome       text not null,
  categoria  text,              -- ex.: Agropecuária, Veterinário, Transporte
  oferece    text,              -- o que o parceiro oferece / vende
  descr      text,
  fone       text,              -- WhatsApp do parceiro (só números, com 55 + DDD)
  endereco   text,
  mun        text,
  img        text,              -- caminho no armazenamento "banners"
  ativo      boolean not null default true,
  criado_em  timestamptz not null default now()
);
alter table public.parceiros enable row level security;
drop policy if exists parc_ler on public.parceiros;
create policy parc_ler on public.parceiros for select to authenticated using (ativo or public.eh_admin());
drop policy if exists parc_admin on public.parceiros;
create policy parc_admin on public.parceiros for all to authenticated
  using (public.eh_admin()) with check (public.eh_admin());

create table if not exists public.vantagens (
  id           uuid primary key default gen_random_uuid(),
  titulo       text not null,     -- ex.: 10% em ração e suplemento
  desconto     text,              -- ex.: 10%, R$ 0,20 por litro
  descr        text,              -- regras / como usar
  parceiro_id  uuid references public.parceiros(id) on delete set null,
  img          text,
  ate          date,
  ativo        boolean not null default true,
  criado_em    timestamptz not null default now()
);
alter table public.vantagens enable row level security;
drop policy if exists vant_ler on public.vantagens;
create policy vant_ler on public.vantagens for select to authenticated using (ativo or public.eh_admin());
drop policy if exists vant_admin on public.vantagens;
create policy vant_admin on public.vantagens for all to authenticated
  using (public.eh_admin()) with check (public.eh_admin());

grant select, insert, update, delete on public.parceiros, public.vantagens to authenticated;

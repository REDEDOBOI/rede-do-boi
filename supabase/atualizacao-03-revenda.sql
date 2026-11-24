-- ---------- Revenda de lotes para compradores cadastrados (atualização 3, 24/11/2026) ----------
-- Pode rodar mais de uma vez sem problema.

-- Telefone de quem está logado (o login é <telefone>@tel.rededoboi.app)
create or replace function public.meu_fone() returns text
language sql stable security definer set search_path = public, auth as $$
  select split_part(email, '@', 1) from auth.users where id = auth.uid()
$$;

-- ---------- Compradores (cadastrados pelo administrador) ----------
create table if not exists public.compradores (
  id         uuid primary key default gen_random_uuid(),
  fone       text not null unique,       -- 55 + DDD + número
  nome       text not null,
  cidade     text,
  documento  text,                       -- CPF/CNPJ (opcional)
  obs        text,
  ativo      boolean not null default true,
  criado_em  timestamptz not null default now()
);
create or replace function public.meu_comprador() returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.compradores where fone = public.meu_fone() and ativo
$$;
alter table public.compradores enable row level security;
drop policy if exists comp_ler on public.compradores;
create policy comp_ler on public.compradores for select to authenticated
  using (public.eh_admin() or id = public.meu_comprador());
drop policy if exists comp_admin on public.compradores;
create policy comp_admin on public.compradores for all to authenticated
  using (public.eh_admin()) with check (public.eh_admin());

-- ---------- Lotes separados para revenda ----------
create table if not exists public.lotes (
  id            uuid primary key default gen_random_uuid(),
  cat           text not null check (cat in ('boi_gordo','boi_magro','vaca_gorda','vaca_magra','vaca_parida','garrote','novilha','bezerro','bezerra')),
  qtd           integer not null check (qtd > 0),
  peso          numeric not null check (peso > 0),
  un            text not null default '@' check (un in ('@','kg')),
  valor         numeric not null check (valor >= 0),   -- preço pedido por @
  descr         text,
  midias        jsonb not null default '[]',
  status        text not null default 'disponivel' check (status in ('disponivel','reservado','vendido','no_pasto','entregue','cancelado')),
  visivel       boolean not null default true,         -- aparece para os compradores
  comprador_id  uuid references public.compradores(id) on delete set null,
  origem_lanc   uuid references public.lancamentos(id) on delete set null, -- gado comprado de um produtor
  vendido_em    timestamptz,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
alter table public.lotes enable row level security;
drop policy if exists lote_ler on public.lotes;
create policy lote_ler on public.lotes for select to authenticated using (
  public.eh_admin()
  or (public.meu_comprador() is not null and visivel and (status in ('disponivel','reservado') or comprador_id = public.meu_comprador()))
);
drop policy if exists lote_admin on public.lotes;
create policy lote_admin on public.lotes for all to authenticated
  using (public.eh_admin()) with check (public.eh_admin());

-- Valores da negociação: só o administrador vê (o comprador nunca vê quanto foi pago)
create table if not exists public.lotes_financeiro (
  lote_id        uuid primary key references public.lotes(id) on delete cascade,
  valor_pago     numeric,   -- quanto o administrador pagou pelo gado (total R$)
  despesas       numeric,   -- frete, pasto, vacina etc. (total R$)
  valor_vendido  numeric,   -- quanto recebeu do comprador (total R$)
  obs            text
);
alter table public.lotes_financeiro enable row level security;
drop policy if exists fin_admin on public.lotes_financeiro;
create policy fin_admin on public.lotes_financeiro for all to authenticated
  using (public.eh_admin()) with check (public.eh_admin());

-- ---------- Perguntas e pedidos de compra dos compradores ----------
create table if not exists public.lote_mensagens (
  id            uuid primary key default gen_random_uuid(),
  lote_id       uuid not null references public.lotes(id) on delete cascade,
  comprador_id  uuid not null references public.compradores(id) on delete cascade,
  papel         text not null check (papel in ('comp','adm','sys')),
  texto         text not null default '',
  quer_comprar  boolean not null default false,
  autor_nome    text,
  adm_novo      boolean not null default false,
  comp_novo     boolean not null default false,
  criado_em     timestamptz not null default now()
);
create index if not exists lmsg_lote on public.lote_mensagens(lote_id, criado_em);

create or replace function public.lmsg_antes() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;
  new.criado_em := now();
  if new.papel = 'comp' then
    new.comprador_id := public.meu_comprador();
    new.autor_nome := (select nome from public.compradores where id = new.comprador_id);
    new.adm_novo := true; new.comp_novo := false;
  elsif new.papel = 'adm' then
    new.autor_nome := (select nome from public.perfis where id = auth.uid());
    new.adm_novo := false; new.comp_novo := true; new.quer_comprar := false;
  end if;
  return new;
end $$;
drop trigger if exists lmsg_antes on public.lote_mensagens;
create trigger lmsg_antes before insert on public.lote_mensagens
  for each row execute function public.lmsg_antes();

-- "Quero comprar": o lote fica reservado para o primeiro comprador que confirmar
create or replace function public.lmsg_depois() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.papel = 'comp' and new.quer_comprar then
    update public.lotes set status = 'reservado', comprador_id = new.comprador_id, atualizado_em = now()
      where id = new.lote_id and status = 'disponivel';
  end if;
  return new;
end $$;
drop trigger if exists lmsg_depois on public.lote_mensagens;
create trigger lmsg_depois after insert on public.lote_mensagens
  for each row execute function public.lmsg_depois();

alter table public.lote_mensagens enable row level security;
drop policy if exists lmsg_ler on public.lote_mensagens;
create policy lmsg_ler on public.lote_mensagens for select to authenticated
  using (public.eh_admin() or comprador_id = public.meu_comprador());
drop policy if exists lmsg_criar on public.lote_mensagens;
create policy lmsg_criar on public.lote_mensagens for insert to authenticated with check (
  (papel = 'adm' and public.eh_admin())
  or (papel = 'comp' and comprador_id = public.meu_comprador()
      and exists (select 1 from public.lotes l where l.id = lote_id and l.visivel
                  and (l.status in ('disponivel','reservado') or l.comprador_id = public.meu_comprador())))
);
drop policy if exists lmsg_admin on public.lote_mensagens;
create policy lmsg_admin on public.lote_mensagens for update to authenticated
  using (public.eh_admin()) with check (public.eh_admin());

-- O comprador marca como lidas as respostas do administrador
create or replace function public.lote_lido(p_lote uuid) returns void
language sql security definer set search_path = public as $$
  update public.lote_mensagens set comp_novo = false
   where lote_id = p_lote and comprador_id = public.meu_comprador() and comp_novo
$$;

grant select, insert, update, delete on public.compradores, public.lotes, public.lotes_financeiro to authenticated;
grant select, insert, update on public.lote_mensagens to authenticated;
grant execute on function public.meu_fone(), public.meu_comprador(), public.lote_lido(uuid) to authenticated;

do $$ begin
  begin alter publication supabase_realtime add table public.lotes; exception when others then null; end;
  begin alter publication supabase_realtime add table public.lote_mensagens; exception when others then null; end;
end $$;

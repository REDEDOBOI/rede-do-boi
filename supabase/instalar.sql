-- Rede do Boi: instalação completa do banco (colar no SQL Editor do Supabase e clicar em Run)
-- =====================================================================
-- Rede do Boi: banco de dados (Supabase / PostgreSQL)
-- Rodar uma vez no Supabase: SQL Editor > New query > colar tudo > Run.
-- Pode rodar de novo sem problema (usa "if not exists" / "or replace").
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- Perfis (produtores e administradores) ----------
create table if not exists public.perfis (
  id         uuid primary key references auth.users(id) on delete cascade,
  nome       text not null check (length(trim(nome)) > 1),
  fone       text not null unique,
  email      text,
  prop       text not null,
  local      text,
  mun        text not null,
  vic        text,
  km         text,
  admin      boolean not null default false,
  senha_definida boolean not null default false, -- administrador já criou a senha própria
  criado_em  timestamptz not null default now()
);
alter table public.perfis add column if not exists senha_definida boolean not null default false;

-- Telefones que viram administrador automaticamente ao se cadastrar (ninguém lê pelo app)
create table if not exists public.admins_previstos (fone text primary key);
alter table public.admins_previstos enable row level security;

create or replace function public.eh_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select admin and senha_definida from public.perfis where id = auth.uid()), false)
$$;

-- Só um administrador (ou o próprio painel do Supabase) pode dar ou tirar acesso de administrador.
create or replace function public.perfis_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if; -- SQL Editor / painel do Supabase
  -- o telefone é o da conta (login); não pode ser trocado por outro
  new.fone := coalesce(split_part((select email from auth.users where id = new.id), '@', 1), new.fone);
  if tg_op = 'INSERT' then
    if not public.eh_admin() then
      new.admin := exists (select 1 from public.admins_previstos where fone = new.fone);
    end if;
    new.senha_definida := false;
    new.criado_em := now();
  else
    new.id := old.id;
    if not public.eh_admin() then new.admin := old.admin; end if;
    -- só a própria pessoa marca que criou a senha, e não dá para desmarcar
    if old.id <> auth.uid() then new.senha_definida := old.senha_definida;
    else new.senha_definida := old.senha_definida or new.senha_definida; end if;
  end if;
  return new;
end $$;
drop trigger if exists perfis_guard on public.perfis;
create trigger perfis_guard before insert or update on public.perfis
  for each row execute function public.perfis_guard();

alter table public.perfis enable row level security;
drop policy if exists perfis_ler on public.perfis;
create policy perfis_ler on public.perfis for select to authenticated
  using (id = auth.uid() or public.eh_admin());
drop policy if exists perfis_criar on public.perfis;
create policy perfis_criar on public.perfis for insert to authenticated
  with check (id = auth.uid());
drop policy if exists perfis_alterar on public.perfis;
create policy perfis_alterar on public.perfis for update to authenticated
  using (id = auth.uid() or public.eh_admin()) with check (id = auth.uid() or public.eh_admin());

-- ---------- Vicinais ----------
create table if not exists public.vicinais (
  nome       text primary key,
  criado_em  timestamptz not null default now()
);
alter table public.vicinais enable row level security;
drop policy if exists vic_ler on public.vicinais;
create policy vic_ler on public.vicinais for select to anon, authenticated using (true);
drop policy if exists vic_admin on public.vicinais;
create policy vic_admin on public.vicinais for all to authenticated
  using (public.eh_admin()) with check (public.eh_admin());

create table if not exists public.vicinal_sugestoes (
  id         uuid primary key default gen_random_uuid(),
  nome       text not null,
  por        uuid default auth.uid() references public.perfis(id) on delete set null,
  por_nome   text,
  criado_em  timestamptz not null default now()
);
alter table public.vicinal_sugestoes enable row level security;
drop policy if exists sug_criar on public.vicinal_sugestoes;
create policy sug_criar on public.vicinal_sugestoes for insert to authenticated
  with check (por = auth.uid());
drop policy if exists sug_admin on public.vicinal_sugestoes;
create policy sug_admin on public.vicinal_sugestoes for all to authenticated
  using (public.eh_admin()) with check (public.eh_admin());

-- ---------- Lançamentos de compra e venda ----------
create table if not exists public.lancamentos (
  id             uuid primary key,              -- criado no aparelho (funciona offline)
  user_id        uuid not null default auth.uid() references public.perfis(id) on delete cascade,
  tipo           text not null check (tipo in ('venda','compra')),
  cat            text not null check (cat in ('boi_gordo','boi_magro','vaca_gorda','vaca_magra','vaca_parida','garrote','novilha','bezerro','bezerra')),
  qtd            integer not null check (qtd > 0),
  peso           numeric not null check (peso > 0),
  un             text not null default '@' check (un in ('@','kg')),
  valor          numeric not null check (valor >= 0),
  midias         jsonb not null default '[]',  -- [{path, kind:'img'|'video'}]
  criado_em      timestamptz not null default now(), -- data do lançamento (automática, no aparelho)
  recebido_em    timestamptz not null default now(),
  status         text not null default 'novo' check (status in ('novo','negociacao','visita','fechado','cancelado')),
  valor_fechado  numeric,
  responsavel    uuid references public.perfis(id) on delete set null,
  adm_novo       boolean not null default true,  -- aviso para os administradores
  prod_novo      boolean not null default false, -- aviso para o produtor
  excluido_em    timestamptz,                    -- produtor excluiu (fica no relatório)
  atualizado_em  timestamptz not null default now()
);
create index if not exists lanc_user on public.lancamentos(user_id);
create index if not exists lanc_data on public.lancamentos(criado_em desc);

-- ---------- Mensagens e ofertas (histórico da negociação) ----------
create table if not exists public.mensagens (
  id         uuid primary key default gen_random_uuid(),
  lanc_id    uuid not null references public.lancamentos(id) on delete cascade,
  autor      uuid default auth.uid() references public.perfis(id) on delete set null,
  autor_nome text,
  papel      text not null check (papel in ('prod','adm','sys')),
  texto      text not null default '',
  oferta     numeric,
  criado_em  timestamptz not null default now()
);
create index if not exists msg_lanc on public.mensagens(lanc_id, criado_em);

-- Regras automáticas dos lançamentos
create or replace function public.lanc_antes() returns trigger
language plpgsql security definer set search_path = public as $$
declare adm boolean := public.eh_admin();
begin
  if current_setting('rdb.sistema', true) = '1' then
    new.atualizado_em := now(); return new;
  end if;
  if tg_op = 'INSERT' then
    new.user_id := auth.uid();
    new.status := 'novo'; new.valor_fechado := null; new.responsavel := null;
    new.adm_novo := true; new.prod_novo := false; new.excluido_em := null;
    new.recebido_em := now();
    if new.criado_em is null or new.criado_em > now() + interval '1 day' then new.criado_em := now(); end if;
    new.atualizado_em := now();
    return new;
  end if;

  new.id := old.id; new.user_id := old.user_id; new.recebido_em := old.recebido_em; new.criado_em := old.criado_em;
  if old.user_id = auth.uid() then
    -- produtor: pode mudar o lote, excluir e marcar como lido
    new.status := old.status; new.valor_fechado := old.valor_fechado; new.responsavel := old.responsavel;
    new.prod_novo := old.prod_novo and new.prod_novo;
    if old.excluido_em is not null then new.excluido_em := old.excluido_em; end if;
    if (new.tipo, new.cat, new.qtd, new.peso, new.un, new.valor, new.midias)
       is distinct from (old.tipo, old.cat, old.qtd, old.peso, old.un, old.valor, old.midias) then
      new.adm_novo := true;
      insert into public.mensagens(lanc_id, autor, papel, texto)
        values (new.id, auth.uid(), 'sys', 'Produtor alterou o lançamento');
    elsif new.excluido_em is not null and old.excluido_em is null then
      new.adm_novo := true;
      insert into public.mensagens(lanc_id, autor, papel, texto)
        values (new.id, auth.uid(), 'sys', 'Produtor excluiu o lançamento');
    else
      new.adm_novo := old.adm_novo;
    end if;
  elsif adm then
    -- administrador: muda situação, valor fechado e avisos; não mexe no lote
    new.tipo := old.tipo; new.cat := old.cat; new.qtd := old.qtd; new.peso := old.peso; new.un := old.un;
    new.valor := old.valor; new.midias := old.midias; new.excluido_em := old.excluido_em;
    new.prod_novo := old.prod_novo or new.prod_novo;
    if new.status is distinct from old.status or new.valor_fechado is distinct from old.valor_fechado then
      new.responsavel := auth.uid();
      insert into public.mensagens(lanc_id, autor, papel, texto) values (new.id, auth.uid(), 'sys',
        case when new.status = 'fechado'
          then 'Negócio fechado' || coalesce(' a R$ ' || replace(to_char(new.valor_fechado, 'FM999999990.00'), '.', ',') || '/@', '')
          else 'Status: ' || case new.status when 'novo' then 'Novo' when 'negociacao' then 'Em negociação'
               when 'visita' then 'Em visita técnica' when 'cancelado' then 'Cancelado' else new.status end
        end || ' (' || coalesce((select nome from public.perfis where id = auth.uid()), 'Administrador') || ')');
    end if;
  else
    raise exception 'sem permissão';
  end if;
  new.atualizado_em := now();
  return new;
end $$;
drop trigger if exists lanc_antes on public.lancamentos;
create trigger lanc_antes before insert or update on public.lancamentos
  for each row execute function public.lanc_antes();

create or replace function public.lanc_depois() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.mensagens(lanc_id, autor, papel, texto, criado_em)
    values (new.id, new.user_id, 'sys',
            case when new.tipo = 'venda' then 'Lançamento recebido' else 'Pedido de compra recebido' end,
            new.recebido_em);
  return new;
end $$;
drop trigger if exists lanc_depois on public.lancamentos;
create trigger lanc_depois after insert on public.lancamentos
  for each row execute function public.lanc_depois();

-- Regras automáticas das mensagens
create or replace function public.msg_antes() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.papel <> 'sys' then new.autor := auth.uid(); new.criado_em := now(); end if;
  new.autor_nome := coalesce((select nome from public.perfis where id = new.autor), new.autor_nome);
  return new;
end $$;
drop trigger if exists msg_antes on public.mensagens;
create trigger msg_antes before insert on public.mensagens
  for each row execute function public.msg_antes();

create or replace function public.msg_depois() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.papel = 'sys' then return new; end if;
  perform set_config('rdb.sistema', '1', true);
  if new.papel = 'prod' then
    update public.lancamentos set adm_novo = true,
      status = case when status = 'novo' then 'negociacao' else status end
      where id = new.lanc_id;
  else
    update public.lancamentos set prod_novo = true, responsavel = new.autor,
      status = case when status = 'novo' then 'negociacao' else status end
      where id = new.lanc_id;
  end if;
  perform set_config('rdb.sistema', '', true);
  return new;
end $$;
drop trigger if exists msg_depois on public.mensagens;
create trigger msg_depois after insert on public.mensagens
  for each row execute function public.msg_depois();

alter table public.lancamentos enable row level security;
drop policy if exists lanc_ler on public.lancamentos;
create policy lanc_ler on public.lancamentos for select to authenticated
  using (user_id = auth.uid() or public.eh_admin()); -- o app esconde os excluídos do produtor
drop policy if exists lanc_criar on public.lancamentos;
create policy lanc_criar on public.lancamentos for insert to authenticated
  with check (true); -- o gatilho grava o dono como o usuário logado
drop policy if exists lanc_alterar on public.lancamentos;
create policy lanc_alterar on public.lancamentos for update to authenticated
  using ((user_id = auth.uid() and excluido_em is null) or public.eh_admin()) with check (true);

alter table public.mensagens enable row level security;
drop policy if exists msg_ler on public.mensagens;
create policy msg_ler on public.mensagens for select to authenticated
  using (public.eh_admin() or exists (select 1 from public.lancamentos l where l.id = lanc_id and l.user_id = auth.uid()));
drop policy if exists msg_criar on public.mensagens;
create policy msg_criar on public.mensagens for insert to authenticated
  with check (
    (papel = 'prod' and exists (select 1 from public.lancamentos l where l.id = lanc_id and l.user_id = auth.uid() and l.excluido_em is null))
    or (papel = 'adm' and public.eh_admin())
  );

-- ---------- Banners de campanha ----------
create table if not exists public.banners (
  id         uuid primary key default gen_random_uuid(),
  titulo     text not null,
  sub        text,
  cor        text not null default 'verde',
  img        text,                 -- caminho no armazenamento "banners"
  tipo       text not null default 'campanha' check (tipo in ('campanha','link')),
  url        text,
  descr      text,
  ate        date,
  ativo      boolean not null default true,
  criado_em  timestamptz not null default now()
);
alter table public.banners enable row level security;
drop policy if exists ban_ler on public.banners;
create policy ban_ler on public.banners for select to authenticated using (ativo or public.eh_admin());
drop policy if exists ban_admin on public.banners;
create policy ban_admin on public.banners for all to authenticated
  using (public.eh_admin()) with check (public.eh_admin());

create table if not exists public.interesses (
  banner_id  uuid not null references public.banners(id) on delete cascade,
  user_id    uuid not null default auth.uid() references public.perfis(id) on delete cascade,
  novo       boolean not null default true,
  criado_em  timestamptz not null default now(),
  primary key (banner_id, user_id)
);
alter table public.interesses enable row level security;
drop policy if exists int_criar on public.interesses;
create policy int_criar on public.interesses for insert to authenticated with check (user_id = auth.uid());
drop policy if exists int_ler on public.interesses;
create policy int_ler on public.interesses for select to authenticated using (user_id = auth.uid() or public.eh_admin());
drop policy if exists int_admin on public.interesses;
create policy int_admin on public.interesses for update to authenticated using (public.eh_admin()) with check (public.eh_admin());

-- ---------- Avisos no celular (notificações push) ----------
create table if not exists public.push_inscricoes (
  endpoint   text primary key,
  user_id    uuid not null default auth.uid() references public.perfis(id) on delete cascade,
  dados      jsonb not null,
  criado_em  timestamptz not null default now()
);
alter table public.push_inscricoes enable row level security;
drop policy if exists push_dono on public.push_inscricoes;
create policy push_dono on public.push_inscricoes for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------- Permissões das tabelas ----------
grant usage on schema public to anon, authenticated;
grant select on public.vicinais to anon;
grant select, insert, update on public.perfis, public.lancamentos, public.mensagens, public.banners,
  public.interesses, public.vicinais, public.vicinal_sugestoes to authenticated;
grant delete on public.banners, public.vicinais, public.vicinal_sugestoes to authenticated;
grant select, insert, update, delete on public.push_inscricoes to authenticated;
grant execute on function public.eh_admin() to authenticated;
-- ---------- Armazenamento de fotos e vídeos ----------
insert into storage.buckets (id, name, public, file_size_limit)
  values ('midias', 'midias', true, 52428800)
  on conflict (id) do update set public = true, file_size_limit = 52428800;
insert into storage.buckets (id, name, public, file_size_limit)
  values ('banners', 'banners', true, 5242880)
  on conflict (id) do update set public = true;

drop policy if exists "midias enviar" on storage.objects;
create policy "midias enviar" on storage.objects for insert to authenticated
  with check (bucket_id = 'midias' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "midias ler" on storage.objects;
create policy "midias ler" on storage.objects for select to authenticated
  using (bucket_id = 'midias' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "midias atualizar" on storage.objects;
create policy "midias atualizar" on storage.objects for update to authenticated
  using (bucket_id = 'midias' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'midias' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "midias apagar" on storage.objects;
create policy "midias apagar" on storage.objects for delete to authenticated
  using (bucket_id = 'midias' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "banners admin" on storage.objects;
create policy "banners admin" on storage.objects for all to authenticated
  using (bucket_id = 'banners' and public.eh_admin()) with check (bucket_id = 'banners' and public.eh_admin());

-- ---------- Atualização em tempo real ----------
do $$ begin
  begin alter publication supabase_realtime add table public.lancamentos; exception when others then null; end;
  begin alter publication supabase_realtime add table public.mensagens; exception when others then null; end;
  begin alter publication supabase_realtime add table public.interesses; exception when others then null; end;
end $$;
-- ---------- Vicinais iniciais (lista enviada pelo Ronaldo) ----------
insert into public.vicinais(nome) values
  ('Cangalhão'),
  ('Boa Esperança'),
  ('Nova Vida'),
  ('Paraíso'),
  ('Surubim'),
  ('São Francisco'),
  ('Índia / Setor Sucunduri'),
  ('Novo Aripuanã / Estrada Nova'),
  ('Nova União'),
  ('Nova Jerusalém'),
  ('Planalto'),
  ('Aripuanã / Sulino'),
  ('Seringueira'),
  ('Vicinal 10'),
  ('Amazonas'),
  ('Dom Pedro'),
  ('Três de Julho'),
  ('Zacarias'),
  ('Nova Canaã'),
  ('Beno Mota'),
  ('Julho Fabiano'),
  ('Nova Linhares'),
  ('Campo Grande'),
  ('Kennedy'),
  ('Linha Onze'),
  ('Sebastião Pedro'),
  ('Morena'),
  ('Soldado da Borracha'),
  ('Mineira'),
  ('Fábio Lucena'),
  ('Douradão'),
  ('Solimões'),
  ('Zé Branco'),
  ('Coruja 03'),
  ('Paulista'),
  ('Bunda de Ema'),
  ('Coruja'),
  ('Mariano'),
  ('Marianinho'),
  ('Zeni'),
  ('Pombos'),
  ('Alemães'),
  ('Zenir'),
  ('Dez'),
  ('Jung'),
  ('Onze'),
  ('Cupuaçu'),
  ('Nova Lacerda'),
  ('Bueno'),
  ('Baiano'),
  ('União'),
  ('Lima 10')
on conflict do nothing;

-- ---------- Administradores (pedido do Ronaldo em 24/11/2026) ----------
insert into public.admins_previstos(fone) values ('5569984899474'), ('5569984495915') on conflict do nothing;

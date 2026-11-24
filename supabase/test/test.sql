\set ON_ERROR_STOP 1
insert into auth.users values ('00000000-0000-0000-0000-00000000000a','5597900000001@tel.rededoboi.app'),('00000000-0000-0000-0000-00000000000b','5597900000002@tel.rededoboi.app'),('00000000-0000-0000-0000-0000000000ad','5597900000009@tel.rededoboi.app');
-- produtor A cria perfil e tenta virar admin
set role authenticated; select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
insert into perfis(id,nome,fone,prop,mun,vic,km,admin) values (auth.uid(),'João','(97) 90000-0001','Faz A','Apuí','Boa Esperança','14',true);
select 'A admin?' t, admin from perfis;
-- B cria perfil
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
insert into perfis(id,nome,fone,prop,mun) values (auth.uid(),'Maria','(97) 90000-0002','Sítio B','Manicoré');
select 'B vê perfis' t, count(*) from perfis;
-- admin
reset role; select set_config('request.jwt.claim.sub','',false); insert into perfis(id,nome,fone,prop,mun,admin) values ('00000000-0000-0000-0000-0000000000ad','Carlos','(97) 90000-0009','Rede do Boi','Apuí',false); update perfis set admin=true, senha_definida=true where nome='Carlos';
-- A lança venda (tentando burlar status)
set role authenticated; select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
insert into lancamentos(id,tipo,cat,qtd,peso,un,valor,status,criado_em) values ('11111111-1111-1111-1111-111111111111','venda','boi_gordo',40,19,'@',310,'fechado', now()-interval '2 hours');
insert into lancamentos(id,tipo,cat,qtd,peso,un,valor) values ('11111111-1111-1111-1111-111111111111','venda','boi_gordo',40,19,'@',310) on conflict (id) do nothing;
select 'A lanc' t, status, adm_novo, user_id from lancamentos;
-- B não vê lanc de A, não consegue alterar nem mandar msg
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
select 'B vê lancs' t, count(*) from lancamentos;
update lancamentos set valor=1 where id='11111111-1111-1111-1111-111111111111';
do $$ begin insert into mensagens(lanc_id,papel,texto) values ('11111111-1111-1111-1111-111111111111','prod','oi'); raise notice 'FALHA: B mandou msg'; exception when others then raise notice 'ok B bloqueado: %', sqlerrm; end $$;
do $$ begin insert into mensagens(lanc_id,papel,texto) values ('11111111-1111-1111-1111-111111111111','adm','oi'); raise notice 'FALHA: B msg adm'; exception when others then raise notice 'ok B adm bloqueado: %', sqlerrm; end $$;
-- admin vê, faz oferta
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000ad',false);
select 'adm vê' t, count(*) from lancamentos;
update lancamentos set adm_novo=false where id='11111111-1111-1111-1111-111111111111';
insert into mensagens(lanc_id,papel,texto,oferta) values ('11111111-1111-1111-1111-111111111111','adm','Faço 300',300);
select 'após oferta' t, status, adm_novo, prod_novo, valor, responsavel is not null resp from lancamentos;
-- admin tenta mudar o valor do lote (não pode) e muda status
update lancamentos set valor=1, status='visita' where id='11111111-1111-1111-1111-111111111111';
-- A vê aviso, responde, marca lido, altera lote
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
select 'A vê' t, status, prod_novo, valor from lancamentos;
update lancamentos set prod_novo=false where id='11111111-1111-1111-1111-111111111111';
insert into mensagens(lanc_id,papel,texto) values ('11111111-1111-1111-1111-111111111111','prod','Fecho por 308');
update lancamentos set qtd=45, status='fechado', adm_novo=false where id='11111111-1111-1111-1111-111111111111';
select 'A depois' t, qtd, status, prod_novo, adm_novo from lancamentos;
-- admin fecha
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000ad',false);
update lancamentos set status='fechado', valor_fechado=305 where id='11111111-1111-1111-1111-111111111111';
-- A exclui
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
update lancamentos set excluido_em=now() where id='11111111-1111-1111-1111-111111111111';
select 'A vê após excluir' t, count(*) from lancamentos where excluido_em is null; update lancamentos set qtd=1 where id='11111111-1111-1111-1111-111111111111'; select 'A nao altera excluido' t, qtd from lancamentos;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000ad',false);
select 'hist' t, papel, autor_nome, texto, oferta from mensagens order by criado_em, papel;
select 'final' t, status, valor_fechado, qtd, excluido_em is not null exc from lancamentos;
-- banners/interesse
insert into banners(titulo,descr) values ('Touros PO','x');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
insert into interesses(banner_id) select id from banners;
select 'B int' t, count(*) from interesses;
do $$ begin insert into banners(titulo) values ('hack'); raise notice 'FALHA banner'; exception when others then raise notice 'ok banner bloqueado'; end $$;
insert into vicinal_sugestoes(nome,por_nome) values ('Ramal Novo','Maria');
select 'B sug visíveis' t, count(*) from vicinal_sugestoes;
select 'vic' t, count(*) from vicinais;
select 'fones' t, nome, fone, admin, senha_definida from perfis order by nome;
-- A tenta marcar senha e virar admin
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
update perfis set senha_definida=true, admin=true, fone='123' where id=auth.uid();
select 'A tenta' t, admin, senha_definida, fone, eh_admin() from perfis where id=auth.uid();

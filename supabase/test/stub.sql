-- Imita o mínimo do Supabase para testar localmente
do $$ begin create role anon nologin; create role authenticated nologin; exception when others then null; end $$;
create schema auth;
create table auth.users(id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
grant usage on schema auth to anon, authenticated;

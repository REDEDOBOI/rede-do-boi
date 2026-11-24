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

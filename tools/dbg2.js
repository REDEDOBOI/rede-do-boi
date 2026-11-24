const { createClient } = require('@supabase/supabase-js');
(async () => {
 const sb = createClient('http://127.0.0.1:54321', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0', { auth: { persistSession: false } });
 console.log((await sb.auth.signInWithPassword({ email: '5597900000009@tel.rededoboi.app', password: 'senha-forte-1' })).error);
 const { data: ls } = await sb.from('lancamentos').select('id');
 console.log(await sb.from('mensagens').upsert({ id: require('crypto').randomUUID(), lanc_id: ls[0].id, papel: 'adm', texto: 'teste', oferta: 300 }, { onConflict: 'id', ignoreDuplicates: true }));
})();

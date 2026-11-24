// Comunicação com o servidor. Dois modos:
//  - "supabase": servidor de verdade (config.js preenchido)
//  - "demo": tudo fica neste aparelho, para testar sem servidor
const CFG = window.RDB_CONFIG || {};
export const MODO = CFG.supabaseUrl && CFG.supabaseKey ? 'supabase' : 'demo';
export const DOMINIO = 'tel.rededoboi.app';

export const soDigitos = s => String(s ?? '').replace(/\D/g, '');
// Guarda sempre no formato 55 + DDD + número (ex.: 5597999998888)
export function foneNormal(s) {
  let d = soDigitos(s).replace(/^0+/, '');
  if (d.length === 10 || d.length === 11) d = '55' + d;
  return d;
}
export function foneValido(s) { const d = foneNormal(s); return /^55\d{10,11}$/.test(d); }
export function foneBonito(d) {
  d = soDigitos(d); if (d.startsWith('55') && d.length >= 12) d = d.slice(2);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return d;
}
export const novoId = () => (crypto.randomUUID ? crypto.randomUUID() :
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));

// Erro de rede (sem internet ou servidor fora): o item fica na fila para tentar de novo.
export class SemRede extends Error {}
function checar(res) {
  if (res && res.error) {
    const m = String(res.error.message || res.error);
    if (!navigator.onLine || /fetch|network|Load failed|timeout|ECONN|Failed/i.test(m) || res.error.status === 0) throw new SemRede(m);
    const e = new Error(m); e.code = res.error.code; e.status = res.error.status; throw e;
  }
  return res ? res.data : undefined;
}

const LANC_CAMPOS = ['tipo', 'cat', 'qtd', 'peso', 'un', 'valor', 'midias'];

// =====================================================================
// Servidor Supabase
// =====================================================================
function criarSupabase() {
  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'rdb-auth' },
  });
  const senhaProdutor = fone => `rdb:${fone}:${CFG.chaveApp || 'rede-do-boi'}`;
  let sessao = null;
  const LANC_SEL = '*, mensagens(*)';

  const api = {
    modo: 'supabase',
    async iniciar() {
      const { data } = await sb.auth.getSession();
      sessao = data.session;
      sb.auth.onAuthStateChange((_e, s) => { sessao = s; });
    },
    usuario() { return sessao ? { id: sessao.user.id, fone: (sessao.user.email || '').split('@')[0] } : null; },
    async entrar(fone) {
      const email = `${fone}@${DOMINIO}`;
      let r = await sb.auth.signInWithPassword({ email, password: senhaProdutor(fone) });
      if (!r.error) { sessao = r.data.session; return { ok: true }; }
      if (!/invalid login credentials/i.test(r.error.message)) checar(r);
      r = await sb.auth.signUp({ email, password: senhaProdutor(fone) });
      if (!r.error && r.data.session) { sessao = r.data.session; return { ok: true, novo: true }; }
      if (r.error && /already|registered|exists/i.test(r.error.message)) return { precisaSenha: true };
      if (!r.error && !r.data.session) throw new Error('No Supabase, desligue "Confirm email" em Authentication > Sign In / Providers > Email.');
      checar(r);
    },
    async entrarComSenha(fone, senha) {
      const r = await sb.auth.signInWithPassword({ email: `${fone}@${DOMINIO}`, password: senha });
      if (r.error && /invalid login credentials/i.test(r.error.message)) return { ok: false };
      checar(r); sessao = r.data.session; return { ok: true };
    },
    async definirSenha(senha) {
      checar(await sb.auth.updateUser({ password: senha }));
      checar(await sb.from('perfis').update({ senha_definida: true }).eq('id', sessao.user.id));
    },
    async sair() { try { await sb.auth.signOut({ scope: 'local' }); } catch (e) {} sessao = null; },

    async perfil() {
      return checar(await sb.from('perfis').select('*').eq('id', sessao.user.id).maybeSingle());
    },
    async salvarPerfil(d) {
      const u = api.usuario();
      const linha = { id: u.id, fone: u.fone, nome: d.nome, email: d.email || null, prop: d.prop, local: d.local || null, mun: d.mun, vic: d.vic || null, km: d.km || null };
      return checar(await sb.from('perfis').upsert(linha).select().single());
    },
    async vicinais() { return checar(await sb.from('vicinais').select('nome')).map(v => v.nome); },
    async sugerirVicinal(nome, porNome) { checar(await sb.from('vicinal_sugestoes').insert({ nome, por_nome: porNome })); },

    async meusLancamentos() {
      return checar(await sb.from('lancamentos').select(LANC_SEL).eq('user_id', sessao.user.id).is('excluido_em', null)
        .order('criado_em', { ascending: false }));
    },
    async enviarArquivo(caminho, blob, tipo) {
      checar(await sb.storage.from('midias').upload(`${sessao.user.id}/${caminho}`, blob, { upsert: true, contentType: tipo, cacheControl: '31536000' }));
      return `${sessao.user.id}/${caminho}`;
    },
    urlArquivo(caminho, balde = 'midias') { return sb.storage.from(balde).getPublicUrl(caminho).data.publicUrl; },
    async criarLancamento(l) {
      const linha = { id: l.id, criado_em: l.criado_em }; LANC_CAMPOS.forEach(k => linha[k] = l[k]);
      checar(await sb.from('lancamentos').upsert(linha, { onConflict: 'id', ignoreDuplicates: true }));
    },
    async alterarLancamento(id, campos) {
      const linha = {}; LANC_CAMPOS.forEach(k => { if (k in campos) linha[k] = campos[k]; });
      checar(await sb.from('lancamentos').update(linha).eq('id', id));
    },
    async excluirLancamento(id) { checar(await sb.from('lancamentos').update({ excluido_em: new Date().toISOString() }).eq('id', id)); },
    async marcarLidoProdutor(id) { checar(await sb.from('lancamentos').update({ prod_novo: false }).eq('id', id)); },
    async enviarMensagem(m) {
      checar(await sb.from('mensagens').upsert({ id: m.id, lanc_id: m.lanc_id, papel: m.papel, texto: m.texto, oferta: m.oferta ?? null },
        { onConflict: 'id', ignoreDuplicates: true }));
    },
    async banners() { return checar(await sb.from('banners').select('*').order('criado_em', { ascending: false })); },
    async meusInteresses() { return checar(await sb.from('interesses').select('banner_id').eq('user_id', sessao.user.id)).map(i => i.banner_id); },
    async registrarInteresse(bannerId) {
      checar(await sb.from('interesses').upsert({ banner_id: bannerId, user_id: sessao.user.id }, { onConflict: 'banner_id,user_id', ignoreDuplicates: true }));
    },

    // ----- administrador -----
    async todosLancamentos() {
      return checar(await sb.from('lancamentos').select('*, mensagens(*), perfil:perfis!lancamentos_user_id_fkey(*)')
        .order('criado_em', { ascending: false }).limit(2000));
    },
    async marcarLidoAdmin(id) { checar(await sb.from('lancamentos').update({ adm_novo: false }).eq('id', id)); },
    async salvarSituacao(id, status, valorFechado) {
      checar(await sb.from('lancamentos').update({ status, valor_fechado: valorFechado }).eq('id', id));
    },
    async bannersAdmin() {
      return checar(await sb.from('banners').select('*, interesses(*, perfil:perfis(nome, fone))').order('criado_em', { ascending: false }));
    },
    async salvarBanner(b) {
      const linha = { titulo: b.titulo, sub: b.sub || null, cor: b.cor, img: b.img || null, tipo: b.tipo, url: b.url || null, descr: b.descr || null, ate: b.ate || null, ativo: !!b.ativo };
      if (b.id) checar(await sb.from('banners').update(linha).eq('id', b.id));
      else checar(await sb.from('banners').insert(linha));
    },
    async excluirBanner(id) { checar(await sb.from('banners').delete().eq('id', id)); },
    async enviarImagemBanner(blob) {
      const caminho = `${novoId()}.jpg`;
      checar(await sb.storage.from('banners').upload(caminho, blob, { contentType: 'image/jpeg', cacheControl: '31536000' }));
      return caminho;
    },
    // parceiros e clube de vantagens (se a atualização 2 do banco ainda não rodou, volta vazio)
    async parceiros() { const r = await sb.from('parceiros').select('*').order('nome'); if (r.error && /relation|does not exist|schema cache/i.test(r.error.message)) return []; return checar(r); },
    async vantagens() { const r = await sb.from('vantagens').select('*').order('criado_em', { ascending: false }); if (r.error && /relation|does not exist|schema cache/i.test(r.error.message)) return []; return checar(r); },
    async salvarParceiro(x) {
      const linha = { nome: x.nome, categoria: x.categoria || null, oferece: x.oferece || null, descr: x.descr || null, fone: x.fone || null, endereco: x.endereco || null, mun: x.mun || null, img: x.img || null, ativo: !!x.ativo };
      if (x.id) checar(await sb.from('parceiros').update(linha).eq('id', x.id)); else checar(await sb.from('parceiros').insert(linha));
    },
    async excluirParceiro(id) { checar(await sb.from('parceiros').delete().eq('id', id)); },
    async salvarVantagem(x) {
      const linha = { titulo: x.titulo, desconto: x.desconto || null, descr: x.descr || null, parceiro_id: x.parceiro_id || null, img: x.img || null, ate: x.ate || null, ativo: !!x.ativo };
      if (x.id) checar(await sb.from('vantagens').update(linha).eq('id', x.id)); else checar(await sb.from('vantagens').insert(linha));
    },
    async excluirVantagem(id) { checar(await sb.from('vantagens').delete().eq('id', id)); },
    async marcarInteressesLidos(bannerId) { checar(await sb.from('interesses').update({ novo: false }).eq('banner_id', bannerId).eq('novo', true)); },
    async adicionarVicinal(nome) { checar(await sb.from('vicinais').upsert({ nome }, { onConflict: 'nome', ignoreDuplicates: true })); },
    async removerVicinal(nome) { checar(await sb.from('vicinais').delete().eq('nome', nome)); },
    async sugestoes() { return checar(await sb.from('vicinal_sugestoes').select('*').order('criado_em')); },
    async descartarSugestao(id) { checar(await sb.from('vicinal_sugestoes').delete().eq('id', id)); },
    async perfis() { return checar(await sb.from('perfis').select('*').order('nome')); },
    async definirAdmin(id, admin) { checar(await sb.from('perfis').update({ admin }).eq('id', id)); },

    aoMudar(cb) {
      let t; const avisar = () => { clearTimeout(t); t = setTimeout(cb, 600); };
      sb.channel('mudancas')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'lancamentos' }, avisar)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'mensagens' }, avisar)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'interesses' }, avisar)
        .subscribe();
    },
  };
  return api;
}

// =====================================================================
// Modo demonstração: um "servidor" de mentira guardado neste aparelho.
// Segue as mesmas regras do banco de dados real (supabase/schema.sql).
// =====================================================================
function criarDemo() {
  const CH = 'rdb-demo-servidor-v1', CHS = 'rdb-demo-sessao';
  const agora = () => new Date().toISOString();
  const atras = (dias, h = 9) => { const d = new Date(); d.setDate(d.getDate() - dias); d.setHours(h, 15, 0, 0); return d.toISOString(); };
  function semente() {
    const u = (id, nome, fone, x) => ({ id, nome, fone, email: null, local: null, km: null, vic: null, admin: false, senha_definida: false, criado_em: atras(20), ...x });
    const perfis = [
      u('u1', 'João da Silva', '5597988881111', { prop: 'Fazenda Boa Vista', local: 'Zona rural de Apuí', mun: 'Apuí', vic: 'Boa Esperança', km: '14' }),
      u('u2', 'Maria Souza', '5597977772222', { prop: 'Sítio Recanto', local: 'Santo Antônio do Matupi', mun: 'Manicoré', vic: 'São Francisco', km: '7', email: 'maria@exemplo.com' }),
      u('a1', 'Carlos', '5597900000009', { prop: 'Rede do Boi', mun: 'Apuí', admin: true, senha_definida: true }),
      u('a2', 'Pedro', '5597900000008', { prop: 'Rede do Boi', mun: 'Manicoré', admin: true, senha_definida: true }),
    ];
    const L = (id, user_id, tipo, cat, qtd, peso, un, valor, dias, x = {}) => ({ id, user_id, tipo, cat, qtd, peso, un, valor, midias: [], criado_em: atras(dias), recebido_em: atras(dias),
      status: 'novo', valor_fechado: null, responsavel: null, adm_novo: false, prod_novo: false, excluido_em: null, atualizado_em: atras(dias), ...x });
    const M = (lanc_id, papel, autor, autor_nome, texto, criado_em, oferta = null) => ({ id: novoId(), lanc_id, papel, autor, autor_nome, texto, criado_em, oferta });
    return {
      senhas: { a1: 'boi123', a2: 'boi123' },
      perfis,
      vicinais: ["Cangalhão", "Boa Esperança", "Nova Vida", "Paraíso", "Surubim", "São Francisco", "Índia / Setor Sucunduri", "Novo Aripuanã / Estrada Nova", "Nova União", "Nova Jerusalém", "Planalto", "Aripuanã / Sulino", "Seringueira", "Vicinal 10", "Amazonas", "Dom Pedro", "Três de Julho", "Zacarias", "Nova Canaã", "Beno Mota", "Julho Fabiano", "Nova Linhares", "Campo Grande", "Kennedy", "Linha Onze", "Sebastião Pedro", "Morena", "Soldado da Borracha", "Mineira", "Fábio Lucena", "Douradão", "Solimões", "Zé Branco", "Coruja 03", "Paulista", "Bunda de Ema", "Coruja", "Mariano", "Marianinho", "Zeni", "Pombos", "Alemães", "Zenir", "Dez", "Jung", "Onze", "Cupuaçu", "Nova Lacerda", "Bueno", "Baiano", "União", "Lima 10"],
      sugestoes: [{ id: 's1', nome: 'Ramal do Igarapé', por: 'u2', por_nome: 'Maria Souza', criado_em: atras(2) }],
      lancamentos: [
        L('d0000000-0000-4000-8000-000000000001', 'u1', 'venda', 'boi_gordo', 40, 19, '@', 310, 4, { status: 'negociacao', responsavel: 'a1', prod_novo: true, midias: [{ id: 'f1', kind: 'img', demo: 'icons/exemplo-lote.jpg' }] }),
        L('d0000000-0000-4000-8000-000000000002', 'u1', 'venda', 'bezerro', 25, 180, 'kg', 330, 1, { adm_novo: true }),
        L('d0000000-0000-4000-8000-000000000003', 'u2', 'venda', 'vaca_parida', 12, 14, '@', 290, 9, { status: 'fechado', valor_fechado: 285, responsavel: 'a2' }),
        L('d0000000-0000-4000-8000-000000000004', 'u2', 'compra', 'novilha', 20, 9, '@', 280, 2, { status: 'visita', responsavel: 'a2' }),
      ],
      mensagens: [
        M('d0000000-0000-4000-8000-000000000001', 'sys', 'u1', 'João da Silva', 'Lançamento recebido', atras(4)),
        M('d0000000-0000-4000-8000-000000000001', 'adm', 'a1', 'Carlos', 'Bom dia, seu João. Tenho interesse nos 40 bois. Consegue entregar na balança do frigorífico?', atras(3, 10), 300),
        M('d0000000-0000-4000-8000-000000000001', 'prod', 'u1', 'João da Silva', 'Consigo sim. Mas 300 está baixo, fecho por 308.', atras(3, 14)),
        M('d0000000-0000-4000-8000-000000000001', 'adm', 'a1', 'Carlos', 'Passo para 305 a @ e mando o caminhão na sexta.', atras(0, 8), 305),
        M('d0000000-0000-4000-8000-000000000002', 'sys', 'u1', 'João da Silva', 'Lançamento recebido', atras(1)),
        M('d0000000-0000-4000-8000-000000000003', 'sys', 'u2', 'Maria Souza', 'Lançamento recebido', atras(9)),
        M('d0000000-0000-4000-8000-000000000003', 'adm', 'a2', 'Pedro', 'Faço 280 a @.', atras(8), 280),
        M('d0000000-0000-4000-8000-000000000003', 'prod', 'u2', 'Maria Souza', '285 e fechamos.', atras(8, 15)),
        M('d0000000-0000-4000-8000-000000000003', 'sys', 'a2', 'Pedro', 'Negócio fechado a R$ 285,00/@ (Pedro)', atras(6)),
        M('d0000000-0000-4000-8000-000000000004', 'sys', 'u2', 'Maria Souza', 'Pedido de compra recebido', atras(2)),
        M('d0000000-0000-4000-8000-000000000004', 'adm', 'a2', 'Pedro', 'Tenho um lote de 20 novilhas na região. Vamos marcar a visita para quinta?', atras(1, 11)),
        M('d0000000-0000-4000-8000-000000000004', 'sys', 'a2', 'Pedro', 'Status: Em visita técnica (Pedro)', atras(1, 12)),
      ],
      banners: [
        { id: 'b1', titulo: 'Touros PO Nelore em condições especiais', sub: 'Genética registrada, entrega na fazenda', cor: 'verde', img: 'demo:icons/exemplo-banner.jpg', tipo: 'campanha', url: null,
          descr: 'Lote de 15 touros Nelore PO, 30 a 36 meses, com exame andrológico e registro. Condição especial para produtores da Rede do Boi: entrada + parcelamento na venda do bezerro. Entrega nas vicinais de Apuí e Matupi.', ate: null, ativo: true, criado_em: atras(3) },
        { id: 'b2', titulo: 'Sal mineral com 12% de desconto', sub: 'Compra coletiva da Rede do Boi', cor: 'ouro', img: null, tipo: 'campanha', url: null,
          descr: 'Compra coletiva de sal mineral para cria e engorda. Quanto mais produtores entrarem, melhor o preço. Retirada no Matupi ou entrega na vicinal.', ate: null, ativo: true, criado_em: atras(5) },
      ],
      interesses: [{ banner_id: 'b1', user_id: 'u2', novo: true, criado_em: atras(1, 16) }],
      parceiros: [
        { id: 'p1', nome: 'Agropecuária Campo Forte (exemplo)', categoria: 'Agropecuária', oferece: 'Ração, sal mineral, arame, vacinas', descr: 'Entrega nas vicinais às terças e sextas.', fone: '5597999990001', endereco: 'Av. Principal, 100', mun: 'Apuí', img: null, ativo: true, criado_em: atras(10) },
        { id: 'p2', nome: 'Clínica Vet Rural (exemplo)', categoria: 'Veterinário', oferece: 'Atendimento na fazenda, exame andrológico, inseminação', descr: '', fone: '5597999990002', endereco: '', mun: 'Manicoré', img: null, ativo: true, criado_em: atras(10) },
      ],
      vantagens: [
        { id: 'v1', titulo: 'Desconto em ração e suplemento', desconto: '10%', descr: 'Mostre o app no caixa. Válido para compras acima de R$ 200.', parceiro_id: 'p1', img: null, ate: null, ativo: true, criado_em: atras(5) },
        { id: 'v2', titulo: 'Visita técnica com desconto', desconto: '15%', descr: 'Agende pelo WhatsApp e diga que é da Rede do Boi.', parceiro_id: 'p2', img: null, ate: null, ativo: true, criado_em: atras(4) },
      ],
      arquivos: {},
    };
  }
  let S; try { S = JSON.parse(localStorage.getItem(CH)); } catch (e) {}
  if (!S || !S.perfis) S = semente();
  let uid = localStorage.getItem(CHS) || null;
  const salvar = () => { try { localStorage.setItem(CH, JSON.stringify(S)); } catch (e) { console.warn('demo: sem espaço', e); } };
  const ouvintes = [];
  const mudou = () => { salvar(); ouvintes.forEach(f => setTimeout(f, 50)); };
  const rede = () => { if (!navigator.onLine) throw new SemRede('sem internet'); };
  const eu = () => S.perfis.find(p => p.id === uid);
  const ehAdmin = () => { const p = eu(); return !!(p && p.admin && p.senha_definida); };
  const copia = x => JSON.parse(JSON.stringify(x));
  const comMsgs = l => ({ ...copia(l), mensagens: S.mensagens.filter(m => m.lanc_id === l.id).map(copia) });
  const nome = id => (S.perfis.find(p => p.id === id) || {}).nome;
  const sys = (lanc_id, texto) => S.mensagens.push({ id: novoId(), lanc_id, papel: 'sys', autor: uid, autor_nome: nome(uid), texto, oferta: null, criado_em: agora() });
  const ST = { novo: 'Novo', negociacao: 'Em negociação', visita: 'Em visita técnica', cancelado: 'Cancelado' };
  const arquivosDemo = {}; // blobs desta sessão (no modo demo não sobem para lugar nenhum)

  return {
    modo: 'demo',
    async iniciar() {},
    usuario() { const p = S.perfis.find(x => x.id === uid); return uid ? { id: uid, fone: p ? p.fone : localStorage.getItem(CHS + '-fone') } : null; },
    async entrar(fone) {
      rede();
      const p = S.perfis.find(x => x.fone === fone);
      if (p && S.senhas[p.id]) return { precisaSenha: true };
      if (p) { uid = p.id; } else { uid = 'u' + novoId().slice(0, 8); localStorage.setItem(CHS + '-fone', fone); }
      localStorage.setItem(CHS, uid); return { ok: true, novo: !p };
    },
    async entrarComSenha(fone, senha) {
      rede(); const p = S.perfis.find(x => x.fone === fone);
      if (!p || S.senhas[p.id] !== senha) return { ok: false };
      uid = p.id; localStorage.setItem(CHS, uid); return { ok: true };
    },
    async definirSenha(senha) { rede(); S.senhas[uid] = senha; eu().senha_definida = true; mudou(); },
    async sair() { uid = null; localStorage.removeItem(CHS); },
    async perfil() { rede(); const p = eu(); return p ? copia(p) : null; },
    async salvarPerfil(d) {
      rede(); let p = eu();
      const campos = { nome: d.nome, email: d.email || null, prop: d.prop, local: d.local || null, mun: d.mun, vic: d.vic || null, km: d.km || null };
      if (p) Object.assign(p, campos);
      else { p = { id: uid, fone: localStorage.getItem(CHS + '-fone'), admin: false, senha_definida: false, criado_em: agora(), ...campos }; S.perfis.push(p); }
      mudou(); return copia(p);
    },
    async vicinais() { rede(); return [...S.vicinais]; },
    async sugerirVicinal(nome, por_nome) { rede(); S.sugestoes.push({ id: novoId(), nome, por: uid, por_nome, criado_em: agora() }); mudou(); },
    async meusLancamentos() { rede(); return S.lancamentos.filter(l => l.user_id === uid && !l.excluido_em).sort((a, b) => b.criado_em.localeCompare(a.criado_em)).map(comMsgs); },
    async enviarArquivo(caminho, blob) {
      rede(); const c = uid + '/' + caminho; arquivosDemo[c] = URL.createObjectURL(blob);
      if (blob.type.startsWith('image') && blob.size < 400000) S.arquivos[c] = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
      salvar(); return c;
    },
    urlArquivo(caminho) { if (!caminho) return ''; if (caminho.startsWith('demo:')) return caminho.slice(5); return arquivosDemo[caminho] || S.arquivos[caminho] || 'icons/sem-foto.svg'; },
    async criarLancamento(l) {
      rede(); if (S.lancamentos.some(x => x.id === l.id)) return;
      const n = { id: l.id, user_id: uid, criado_em: l.criado_em || agora(), recebido_em: agora(), status: 'novo', valor_fechado: null, responsavel: null, adm_novo: true, prod_novo: false, excluido_em: null, atualizado_em: agora() };
      LANC_CAMPOS.forEach(k => n[k] = l[k]); S.lancamentos.push(n);
      S.mensagens.push({ id: novoId(), lanc_id: n.id, papel: 'sys', autor: uid, autor_nome: nome(uid), texto: n.tipo === 'venda' ? 'Lançamento recebido' : 'Pedido de compra recebido', oferta: null, criado_em: agora() });
      mudou();
    },
    async alterarLancamento(id, campos) {
      rede(); const l = S.lancamentos.find(x => x.id === id && x.user_id === uid && !x.excluido_em); if (!l) throw new Error('sem permissão');
      LANC_CAMPOS.forEach(k => { if (k in campos) l[k] = campos[k]; }); l.adm_novo = true; sys(id, 'Produtor alterou o lançamento'); mudou();
    },
    async excluirLancamento(id) {
      rede(); const l = S.lancamentos.find(x => x.id === id && x.user_id === uid); if (!l || l.excluido_em) return;
      l.excluido_em = agora(); l.adm_novo = true; sys(id, 'Produtor excluiu o lançamento'); mudou();
    },
    async marcarLidoProdutor(id) { rede(); const l = S.lancamentos.find(x => x.id === id && x.user_id === uid); if (l) { l.prod_novo = false; salvar(); } },
    async enviarMensagem(m) {
      rede(); if (S.mensagens.some(x => x.id === m.id)) return;
      const l = S.lancamentos.find(x => x.id === m.lanc_id); if (!l) throw new Error('lançamento não existe');
      if (m.papel === 'prod' && l.user_id !== uid) throw new Error('sem permissão');
      if (m.papel === 'adm' && !ehAdmin()) throw new Error('sem permissão');
      S.mensagens.push({ id: m.id, lanc_id: m.lanc_id, papel: m.papel, autor: uid, autor_nome: nome(uid), texto: m.texto, oferta: m.oferta ?? null, criado_em: agora() });
      if (l.status === 'novo') l.status = 'negociacao';
      if (m.papel === 'prod') l.adm_novo = true; else { l.prod_novo = true; l.responsavel = uid; }
      mudou();
    },
    async banners() { rede(); return S.banners.filter(b => b.ativo || ehAdmin()).map(copia); },
    async meusInteresses() { rede(); return S.interesses.filter(i => i.user_id === uid).map(i => i.banner_id); },
    async registrarInteresse(banner_id) { rede(); if (!S.interesses.some(i => i.banner_id === banner_id && i.user_id === uid)) S.interesses.push({ banner_id, user_id: uid, novo: true, criado_em: agora() }); mudou(); },

    async todosLancamentos() {
      rede(); if (!ehAdmin()) return [];
      return S.lancamentos.slice().sort((a, b) => b.criado_em.localeCompare(a.criado_em)).map(l => ({ ...comMsgs(l), perfil: copia(S.perfis.find(p => p.id === l.user_id) || {}) }));
    },
    async marcarLidoAdmin(id) { rede(); const l = S.lancamentos.find(x => x.id === id); if (l && ehAdmin()) { l.adm_novo = false; mudou(); } },
    async salvarSituacao(id, status, valor_fechado) {
      rede(); const l = S.lancamentos.find(x => x.id === id); if (!l || !ehAdmin()) throw new Error('sem permissão');
      if (l.status !== status || l.valor_fechado !== valor_fechado) {
        sys(id, (status === 'fechado' ? 'Negócio fechado' + (valor_fechado != null ? ' a R$ ' + Number(valor_fechado).toFixed(2).replace('.', ',') + '/@' : '') : 'Status: ' + ST[status]) + ` (${nome(uid)})`);
        l.responsavel = uid;
      }
      l.status = status; l.valor_fechado = valor_fechado; mudou();
    },
    async bannersAdmin() {
      rede(); return S.banners.map(b => ({ ...copia(b), interesses: S.interesses.filter(i => i.banner_id === b.id).map(i => ({ ...i, perfil: copia(S.perfis.find(p => p.id === i.user_id) || {}) })) }));
    },
    async salvarBanner(b) {
      rede(); const campos = { titulo: b.titulo, sub: b.sub, cor: b.cor, img: b.img, tipo: b.tipo, url: b.url, descr: b.descr, ate: b.ate || null, ativo: !!b.ativo };
      if (b.id) Object.assign(S.banners.find(x => x.id === b.id), campos); else S.banners.unshift({ id: novoId(), criado_em: agora(), ...campos });
      mudou();
    },
    async excluirBanner(id) { rede(); S.banners = S.banners.filter(b => b.id !== id); S.interesses = S.interesses.filter(i => i.banner_id !== id); mudou(); },
    async enviarImagemBanner(blob) {
      rede(); const url = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
      const c = 'b-' + novoId() + '.jpg'; S.arquivos[c] = url; mudou(); return c;
    },
    async parceiros() { rede(); return (S.parceiros || []).filter(x => x.ativo || ehAdmin()).map(copia).sort((a, b) => a.nome.localeCompare(b.nome)); },
    async vantagens() { rede(); return (S.vantagens || []).filter(x => x.ativo || ehAdmin()).map(copia); },
    async salvarParceiro(x) {
      rede(); S.parceiros = S.parceiros || []; const c = { nome: x.nome, categoria: x.categoria, oferece: x.oferece, descr: x.descr, fone: x.fone, endereco: x.endereco, mun: x.mun, img: x.img, ativo: !!x.ativo };
      if (x.id) Object.assign(S.parceiros.find(y => y.id === x.id), c); else S.parceiros.push({ id: novoId(), criado_em: agora(), ...c }); mudou();
    },
    async excluirParceiro(id) { rede(); S.parceiros = S.parceiros.filter(x => x.id !== id); (S.vantagens || []).forEach(v => { if (v.parceiro_id === id) v.parceiro_id = null; }); mudou(); },
    async salvarVantagem(x) {
      rede(); S.vantagens = S.vantagens || []; const c = { titulo: x.titulo, desconto: x.desconto, descr: x.descr, parceiro_id: x.parceiro_id || null, img: x.img, ate: x.ate || null, ativo: !!x.ativo };
      if (x.id) Object.assign(S.vantagens.find(y => y.id === x.id), c); else S.vantagens.unshift({ id: novoId(), criado_em: agora(), ...c }); mudou();
    },
    async excluirVantagem(id) { rede(); S.vantagens = S.vantagens.filter(x => x.id !== id); mudou(); },
    async marcarInteressesLidos(id) { rede(); S.interesses.forEach(i => { if (i.banner_id === id) i.novo = false; }); mudou(); },
    async adicionarVicinal(n) { rede(); if (!S.vicinais.includes(n)) S.vicinais.push(n); mudou(); },
    async removerVicinal(n) { rede(); S.vicinais = S.vicinais.filter(v => v !== n); mudou(); },
    async sugestoes() { rede(); return copia(S.sugestoes); },
    async descartarSugestao(id) { rede(); S.sugestoes = S.sugestoes.filter(s => s.id !== id); mudou(); },
    async perfis() { rede(); return S.perfis.map(copia).sort((a, b) => a.nome.localeCompare(b.nome)); },
    async definirAdmin(id, admin) { rede(); const p = S.perfis.find(x => x.id === id); p.admin = admin; if (admin && !S.senhas[id]) p.senha_definida = false; mudou(); },
    aoMudar(cb) { ouvintes.push(cb); addEventListener('storage', e => { if (e.key === CH) { try { S = JSON.parse(e.newValue); } catch (x) {} cb(); } }); },
    reiniciarDemo() { S = semente(); salvar(); },
  };
}

export const api = MODO === 'supabase' ? criarSupabase() : criarDemo();

export function urlBanner(img) {
  if (!img) return '';
  if (MODO === 'supabase') return api.urlArquivo(img, 'banners');
  return api.urlArquivo(img);
}

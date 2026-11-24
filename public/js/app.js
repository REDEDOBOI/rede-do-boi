// Rede do Boi: aplicativo do produtor e painel do comprador (administrador)
import { api, MODO, SemRede, foneNormal, foneValido, foneBonito, soDigitos, novoId, urlBanner } from './api.js';
import { kv, fila, arquivos, pedirPersistencia } from './store.js';

const CFG = window.RDB_CONFIG || {};
const WA = soDigitos(CFG.whatsapp || '');
const CATS = [['boi_gordo', 'Boi gordo'], ['boi_magro', 'Boi magro'], ['vaca_gorda', 'Vaca gorda'], ['vaca_magra', 'Vaca magra'], ['vaca_parida', 'Vaca parida'], ['garrote', 'Garrote'], ['novilha', 'Novilha'], ['bezerro', 'Bezerro'], ['bezerra', 'Bezerra']];
const CAT = Object.fromEntries(CATS);
const ST = { novo: 'Novo', negociacao: 'Em negociação', visita: 'Em visita técnica', fechado: 'Negócio fechado', cancelado: 'Cancelado' };
const MUNICIPIOS = ['Apuí', 'Manicoré'];
const KG_POR_ARROBA = 30; // gado vivo: 1 @ = 30 kg
const MSG_ACEITO = 'Seu lançamento foi aceito, entraremos em contato em breve, obrigado!';
const VIDEO_MAX_MB = 50;
const MODO_COMPRADOR = window.RDB_MODO === 'comprador'; // comprador.html: área dos compradores de lotes

// ---------- formatação ----------
const brl = v => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const brl0 = v => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const num = v => (Number(v) || 0).toLocaleString('pt-BR');
const fdt = t => new Date(t).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fd = t => new Date(t).toLocaleDateString('pt-BR');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const arroba = l => l.un === 'kg' ? (Number(l.peso) || 0) / KG_POR_ARROBA : (Number(l.peso) || 0);
const pesoTxt = l => l.un === 'kg' ? `${num(l.peso)} kg (≈ ${num(Math.round(arroba(l) * 10) / 10)} @)` : `${num(l.peso)} @ (${num(Math.round(arroba(l) * KG_POR_ARROBA))} kg)`;
const total = l => (Number(l.qtd) || 0) * arroba(l) * (Number(l.valor) || 0);
const lancTitulo = l => `${num(l.qtd)} × ${CAT[l.cat] || l.cat}`;
const norm = t => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const ordenarPt = arr => [...arr].sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base', numeric: true }));
const waLink = (fone, texto) => `https://wa.me/${soDigitos(fone)}${texto ? '?text=' + encodeURIComponent(texto) : ''}`;

// ---------- estado ----------
const E = {
  usuario: null, perfil: null, vicinais: [], lancs: [], banners: [], interesses: [], parceiros: [], vantagens: [],
  adm: { lancs: [], banners: [], sugestoes: [], perfis: [], compradores: [], lotes: [] },
  comprador: null, lotesComp: [],
  fila: [], online: navigator.onLine, visao: MODO_COMPRADOR ? 'comp' : 'prod', filtroAdm: 'todos', carregado: false,
};
let pilha = [], rascunho = null;
const app = document.getElementById('app');
const ehAdmin = () => !!(E.perfil && E.perfil.admin && E.perfil.senha_definida);

async function salvarCache() {
  if (!E.usuario) return;
  const { perfil, vicinais, lancs, banners, interesses, adm, parceiros, vantagens, comprador, lotesComp } = E;
  try { await kv.set(chaveCache(), { perfil, vicinais, lancs, banners, interesses, adm, parceiros, vantagens, comprador, lotesComp, em: Date.now() }); } catch (e) {}
}
const chaveCache = () => (MODO_COMPRADOR ? 'cachec:' : 'cache:') + E.usuario.id;
async function lerCache() {
  const c = await kv.get(chaveCache()).catch(() => null);
  if (c) Object.assign(E, { perfil: c.perfil, vicinais: c.vicinais || [], lancs: c.lancs || [], banners: c.banners || [], interesses: c.interesses || [], adm: { ...E.adm, ...(c.adm || {}) }, parceiros: c.parceiros || [], vantagens: c.vantagens || [], comprador: c.comprador || null, lotesComp: c.lotesComp || [] });
  return !!c;
}

// ---------- fotos e vídeos guardados no aparelho ----------
const URLS = new Map();
const carregando = new Set();
function urlMidia(m) {
  if (m.demo) return m.demo;
  if (URLS.has(m.id)) return URLS.get(m.id);
  if (m.path) return api.urlArquivo(m.path);
  if (!carregando.has(m.id)) {
    carregando.add(m.id);
    arquivos.get(m.id).then(b => { if (b) { URLS.set(m.id, URL.createObjectURL(b)); pintar(); } }).catch(() => {});
  }
  return 'icons/sem-foto.svg';
}

// ---------- fila de envio (funciona sem internet) ----------
async function lerFila() { E.fila = (await fila.todos().catch(() => [])) || []; }
async function enfileirar(op, dados) {
  await fila.add({ op, uid: E.usuario.id, dados, tentativas: 0, em: Date.now() });
  await lerFila();
  sincronizar();
}
// Lançamentos do produtor = dados do servidor + o que ainda está na fila
function meusLancs() {
  let ls = E.lancs.filter(l => !l.excluido_em).map(l => ({ ...l, mensagens: [...(l.mensagens || [])] }));
  for (const it of E.fila) {
    if (it.uid !== E.usuario.id) continue;
    const d = it.dados, l = ls.find(x => x.id === (d.id || d.lanc_id));
    if (it.op === 'lanc_novo' && !l) ls.unshift({ ...d, status: 'novo', mensagens: [], pendente: true });
    else if (it.op === 'lanc_alt' && l) { Object.assign(l, d.campos); l.altPendente = true; }
    else if (it.op === 'lanc_exc') ls = ls.filter(x => x.id !== d.id);
    else if (it.op === 'msg' && l) l.mensagens.push({ ...d, autor_nome: E.perfil && E.perfil.nome, pendente: true });
    else if (it.op === 'lido' && l) l.prod_novo = false;
  }
  ls.forEach(l => l.mensagens.sort((a, b) => String(a.criado_em).localeCompare(String(b.criado_em))));
  return ls.sort((a, b) => String(b.criado_em).localeCompare(String(a.criado_em)));
}

async function subirMidias(lancId, midias, item) {
  for (const m of midias) {
    if (m.path || m.demo) continue;
    const blob = await arquivos.get(m.id);
    if (!blob) { m.perdida = true; continue; }
    const ext = m.kind === 'video' ? (m.mime && m.mime.includes('quicktime') ? 'mov' : 'mp4') : 'jpg';
    m.path = await api.enviarArquivo(`${lancId}/${m.id}.${ext}`, blob, m.mime || (m.kind === 'video' ? 'video/mp4' : 'image/jpeg'));
    URLS.set(m.id, URLS.get(m.id) || URL.createObjectURL(blob));
    await fila.put(item); // guarda o progresso: se cair a internet não envia de novo
  }
  return midias.filter(m => !m.perdida).map(({ id, kind, path, demo }) => (demo ? { id, kind, demo } : { id, kind, path }));
}

let sincronizando = false, aceitosPendentes = 0;
async function sincronizar() {
  if (sincronizando || !E.usuario || !navigator.onLine) return;
  sincronizando = true; let enviados = 0, mudou = false;
  try {
    await lerFila();
    for (const it of [...E.fila]) {
      if (it.uid !== E.usuario.id) continue;
      const d = it.dados;
      try {
        if (it.op === 'lanc_novo') {
          const midias = await subirMidias(d.id, d.midias, it);
          await api.criarLancamento({ ...d, midias });
          enviados++;
        } else if (it.op === 'lanc_alt') {
          const campos = { ...d.campos };
          if (campos.midias) campos.midias = await subirMidias(d.id, campos.midias, it);
          await api.alterarLancamento(d.id, campos);
        } else if (it.op === 'lanc_exc') await api.excluirLancamento(d.id);
        else if (it.op === 'msg') await api.enviarMensagem(d);
        else if (it.op === 'lido') await api.marcarLidoProdutor(d.id);
        else if (it.op === 'interesse') await api.registrarInteresse(d.banner_id);
        await fila.del(it.seq);
        for (const m of (d.midias || (d.campos && d.campos.midias) || [])) if (m.path) arquivos.del(m.id).catch(() => {});
        mudou = true;
      } catch (e) {
        if (e instanceof SemRede) break;
        console.error('Falha ao enviar', it, e);
        it.tentativas = (it.tentativas || 0) + 1; it.erro = String(e.message || e);
        if (it.tentativas >= 5) { await fila.del(it.seq); aviso('Um envio falhou várias vezes e foi descartado: ' + it.erro); }
        else await fila.put(it);
      }
    }
  } finally { sincronizando = false; await lerFila(); }
  if (mudou) await atualizar();
  if (enviados) {
    aceitosPendentes += enviados;
    if (E.visao === 'prod') { caixa(MSG_ACEITO, enviados > 1 ? `${enviados} lançamentos enviados.` : '', 'OK', null, true); aceitosPendentes = 0; }
  }
}

// ---------- buscar dados do servidor ----------
let atualizando = null;
async function atualizar() {
  if (!E.usuario || !navigator.onLine) { pintar(); return; }
  if (atualizando) return atualizando;
  atualizando = (async () => {
    try {
      const antes = avisosIds();
      if (MODO_COMPRADOR) { await atualizarComprador(); E.carregado = true; await salvarCache(); notificarNovos(antes); return; }
      const perfil = await api.perfil();
      E.perfil = perfil;
      if (!perfil) { salvarCache(); return; }
      const [vic, lancs, bans, ints, parcs, vants] = await Promise.all([api.vicinais(), api.meusLancamentos(), api.banners(), api.meusInteresses(),
        api.parceiros().catch(() => E.parceiros), api.vantagens().catch(() => E.vantagens)]);
      Object.assign(E, { vicinais: vic, lancs, banners: bans, interesses: ints, parceiros: parcs, vantagens: vants });
      if (ehAdmin()) {
        const [al, ab, sg, pf, cp, lt] = await Promise.all([api.todosLancamentos(), api.bannersAdmin(), api.sugestoes(), api.perfis(),
          api.compradores().catch(() => E.adm.compradores || []), api.lotesAdmin().catch(() => E.adm.lotes || [])]);
        E.adm = { lancs: al, banners: ab, sugestoes: sg, perfis: pf, compradores: cp, lotes: lt };
      }
      E.carregado = true;
      await salvarCache();
      notificarNovos(antes);
    } catch (e) {
      if (!(e instanceof SemRede)) console.error(e);
    } finally { atualizando = null; }
    pintar();
  })();
  return atualizando;
}

// Área do comprador: lotes que ele pode ver. Administrador sem cadastro de comprador vê uma prévia.
async function atualizarComprador() {
  const c = await api.souComprador();
  if (c && c.ativo !== false) { E.comprador = c; E.lotesComp = await api.lotesComprador(); return; }
  const p = await api.perfil().catch(() => null);
  if (p && p.admin && p.senha_definida) {
    E.perfil = p;
    const ls = await api.lotesAdmin();
    E.comprador = { id: null, nome: p.nome, previa: true };
    E.lotesComp = ls.filter(l => l.visivel && ['disponivel', 'reservado'].includes(l.status)).map(({ fin, comprador, ...l }) => ({ ...l, lote_mensagens: [] }));
    return;
  }
  E.comprador = null; E.lotesComp = [];
}

// ---------- avisos (notificações) ----------
function avisosProd() { return meusLancs().filter(l => l.prod_novo); }
function avisosAdm() { return E.adm.lancs.filter(l => l.adm_novo); }
function interessesNovos() { return E.adm.banners.reduce((s, b) => s + (b.interesses || []).filter(i => i.novo).length, 0); }
function contarAvisos() { return E.visao === 'comp' ? lotesNovosComp().length : E.visao === 'adm' ? avisosAdm().length + interessesNovos() + lotesNovosAdm().length : avisosProd().length; }
function avisosIds() {
  const ids = new Set(avisosProd().map(l => 'p' + l.id + l.mensagens.length));
  if (ehAdmin()) avisosAdm().forEach(l => ids.add('a' + l.id + (l.mensagens || []).length));
  if (ehAdmin()) lotesNovosAdm().forEach(l => ids.add('l' + l.id + (l.lote_mensagens || []).length));
  lotesNovosComp().forEach(l => ids.add('c' + l.id + (l.lote_mensagens || []).length));
  return ids;
}
async function notificarNovos(antes) {
  if (!E.carregado || !antes.size && !avisosIds().size) return;
  const novos = [...avisosIds()].filter(i => !antes.has(i));
  if (!novos.length || !document.hidden) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const reg = await navigator.serviceWorker?.getRegistration();
  const titulo = novos.some(i => i[0] === 'a') ? 'Novo lançamento ou resposta no Rede do Boi' : novos.some(i => i[0] === 'l') ? 'Comprador perguntou ou pediu um lote'
    : novos.some(i => i[0] === 'c') ? 'Resposta da Rede do Boi sobre o lote' : 'Nova mensagem do comprador';
  const corpo = 'Toque para abrir.';
  if (reg) reg.showNotification(titulo, { body: corpo, icon: 'icons/icon-192.png', badge: 'icons/icon-64.png', tag: 'rdb' });
  else new Notification(titulo, { body: corpo, icon: 'icons/icon-192.png' });
}
async function pedirAvisos() {
  if (!('Notification' in window)) return aviso('Este celular não permite avisos pelo navegador. Instale o app na tela inicial.');
  const p = await Notification.requestPermission();
  aviso(p === 'granted' ? 'Avisos ativados.' : 'Avisos não autorizados. Dá para ativar nas configurações do navegador.');
  pintar();
}
function setarBadgeIcone() { try { const n = contarAvisos(); if (navigator.setAppBadge) n ? navigator.setAppBadge(n) : navigator.clearAppBadge(); } catch (e) {} }

// ---------- navegação ----------
function ir(tela, arg) { pilha.push([tela, arg]); pintar(true); history.pushState({ n: pilha.length }, ''); }
function voltar() { if (pilha.length > 1) history.back(); else inicio(); }
addEventListener('popstate', () => { if (visor.lista.length) { fecharVisor(); return; } if (pilha.length > 1) pilha.pop(); pintar(true); });
function inicio() { pilha = [[telaInicial()]]; pintar(true); }
function telaInicial() {
  if (!E.usuario) return 'login';
  if (MODO_COMPRADOR) return E.comprador ? 'compLotes' : 'naoComprador';
  if (!E.perfil) return 'cadastro';
  if (E.perfil.admin && !E.perfil.senha_definida) return 'criarSenha';
  return E.visao === 'adm' ? 'admLista' : 'inicio';
}
function pintar(topo) {
  if (!pilha.length) pilha = [[telaInicial()]];
  const [tela, arg] = pilha[pilha.length - 1];
  const f = TELAS[tela] || TELAS.inicio;
  const foco = document.activeElement && document.activeElement.id;
  const rolagem = app.scrollTop;
  // não redesenhar formulários enquanto a pessoa digita
  if (!topo && FORMULARIOS.has(tela) && app.dataset.tela === tela + (arg || '')) { barraRede(); return; }
  // guarda o que a pessoa estava digitando (a tela pode ser redesenhada quando chega novidade)
  const digitado = topo ? [] : [...app.querySelectorAll('[data-sujo]')].map(e => [e.id, e.type === 'checkbox' ? e.checked : e.value]);
  app.innerHTML = barraRedeHtml() + f(arg);
  app.dataset.tela = tela + (arg || '');
  for (const [id, v] of digitado) { const e = id && document.getElementById(id); if (e) { if (e.type === 'checkbox') e.checked = v; else e.value = v; e.dataset.sujo = 1; } }
  document.body.classList.toggle('adm', E.visao === 'adm');
  ligar(tela, arg);
  if (topo) app.scrollTop = 0; else { app.scrollTop = rolagem; if (foco) { const el = document.getElementById(foco); if (el && el.tagName !== 'BUTTON') el.focus(); } }
  setarBadgeIcone();
}
app.addEventListener('input', e => { if (e.target.id && e.target.type !== 'file') e.target.dataset.sujo = 1; });
const limparDigitado = () => app.querySelectorAll('[data-sujo]').forEach(e => delete e.dataset.sujo);
const FORMULARIOS = new Set(['lancar', 'cadastro', 'admBanner', 'admVantagem', 'admParceiro', 'login', 'senha', 'criarSenha', 'admRevForm', 'admComprador']);
function barraRedeHtml() {
  const q = E.fila.filter(i => E.usuario && i.uid === E.usuario.id).length;
  if (!E.online) return `<div class="net" id="net">Sem internet. ${E.visao !== 'prod' ? 'Mostrando os dados da última conexão.' : q ? `${q} envio(s) guardado(s) no aparelho, vão sozinhos quando conectar.` : 'Você pode lançar normalmente.'}</div>`;
  if (q) return `<div class="net sync" id="net">Enviando ${q} item(ns) guardado(s)...</div>`;
  return '<div id="net" hidden></div>';
}
function barraRede() { const el = document.getElementById('net'); if (el) el.outerHTML = barraRedeHtml(); }

function topo(titulo, sino) {
  return `<header class="bar"><button class="back" data-a="voltar" aria-label="Voltar">‹</button><h1>${titulo}</h1>${sino ? botaoSino() : ''}</header>`;
}
function botaoSino() {
  const n = contarAvisos();
  return `<button class="bell" data-a="avisos" aria-label="Avisos${n ? ' (' + n + ' novos)' : ''}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>${n ? `<span class="badge">${n}</span>` : ''}</button>`;
}
function selo(l) {
  if (l.excluido_em) return '<span class="pill p-cancelado">Excluído pelo produtor</span>';
  if (l.pendente) return '<span class="pill p-fila">Aguardando internet</span>';
  return `<span class="pill p-${l.status}">${ST[l.status]}</span>${l.altPendente ? ' <span class="pill p-fila">Alteração aguardando internet</span>' : ''}`;
}
const seloTipo = l => `<span class="pill p-${l.tipo}">${l.tipo === 'venda' ? 'Venda' : 'Compra'}</span>`;
function ultimaOferta(l) { const ms = l.mensagens || []; for (let i = ms.length - 1; i >= 0; i--) if (ms[i].oferta) return ms[i].oferta; return null; }
function responsavel(l) { const ms = l.mensagens || []; for (let i = ms.length - 1; i >= 0; i--) if (ms[i].papel === 'adm' || (ms[i].papel === 'sys' && / \(([^)]+)\)$/.test(ms[i].texto))) return ms[i].papel === 'adm' ? ms[i].autor_nome : ms[i].texto.match(/ \(([^)]+)\)$/)[1]; return '–'; }
const ICON = 'icons/logo.jpg';

// ---------- galeria e visor de fotos ----------
function galeria(l, grande) {
  if (!l.midias || !l.midias.length) return '';
  return `${grande ? '<h2 class="sec">Fotos e vídeos do lote · toque para ampliar</h2>' : ''}<div class="media${grande ? ' big' : ''}">${l.midias.map((m, i) => `<button type="button" class="m" data-ver="${i}" aria-label="Ampliar ${m.kind === 'video' ? 'vídeo' : 'foto'} ${i + 1}">${m.kind === 'video' ? `<video src="${esc(urlMidia(m))}#t=0.1" muted preload="metadata"></video><span class="play">▶</span>` : `<img src="${esc(urlMidia(m))}" alt="" loading="lazy">`}</button>`).join('')}</div>`;
}
let visor = { lista: [], i: 0, z: 1 };
function abrirVisor(lista, i) { visor = { lista, i, z: 1 }; desenharVisor(); history.pushState({ visor: 1 }, ''); }
function fecharVisor() { visor.lista = []; desenharVisor(); }
function desenharVisor() {
  const el = document.getElementById('viewer'), m = visor.lista[visor.i];
  if (!m) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false; const n = visor.lista.length, src = esc(urlMidia(m));
  el.innerHTML = `<div class="vtop"><span>${visor.i + 1} de ${n}</span><span class="vz">${m.kind === 'video' ? '' : `<button data-z="-1" aria-label="Diminuir">−</button><b>${Math.round(visor.z * 100)}%</b><button data-z="1" aria-label="Ampliar">+</button>`}</span><button class="vx" aria-label="Fechar">✕</button></div>
   <div class="vstage" id="vstage">${m.kind === 'video' ? `<video src="${src}" controls autoplay playsinline></video>` : `<img src="${src}" alt="Foto ${visor.i + 1}" style="width:${visor.z * 100}%">`}</div>
   ${n > 1 ? '<button class="vnav vp" aria-label="Anterior">‹</button><button class="vnav vn" aria-label="Próxima">›</button>' : ''}
   <div class="vhint">${m.kind === 'video' ? '' : 'Toque duas vezes na foto ou use + e − para ampliar. Arraste para ver os detalhes.'}</div>`;
  el.querySelector('.vx').onclick = () => history.back();
  el.querySelectorAll('[data-z]').forEach(b => b.onclick = () => zoom(visor.z + (+b.dataset.z)));
  const p = el.querySelector('.vp'), nx = el.querySelector('.vn');
  if (p) p.onclick = () => { visor.i = (visor.i - 1 + n) % n; visor.z = 1; desenharVisor(); };
  if (nx) nx.onclick = () => { visor.i = (visor.i + 1) % n; visor.z = 1; desenharVisor(); };
  const img = el.querySelector('.vstage img');
  if (img) img.ondblclick = e => { const r = img.getBoundingClientRect(); zoom(visor.z > 1 ? 1 : 2.5, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height); };
}
function zoom(z, fx = .5, fy = .5) {
  visor.z = Math.max(1, Math.min(4, z)); desenharVisor();
  const st = document.getElementById('vstage'), img = st.querySelector('img');
  if (img && img.complete) { st.scrollLeft = img.offsetWidth * fx - st.clientWidth / 2; st.scrollTop = img.offsetHeight * fy - st.clientHeight / 2; }
}
document.addEventListener('keydown', e => {
  if (!visor.lista.length) return; const n = visor.lista.length;
  if (e.key === 'Escape') history.back();
  else if (e.key === 'ArrowRight') { visor.i = (visor.i + 1) % n; visor.z = 1; desenharVisor(); }
  else if (e.key === 'ArrowLeft') { visor.i = (visor.i - 1 + n) % n; visor.z = 1; desenharVisor(); }
});

// ---------- campo de vicinal com busca ----------
function ligarVicinal() {
  const inp = document.getElementById('c-vic'), dd = document.getElementById('vic-dd'); let at = -1, opts = [];
  const fechar = () => { dd.hidden = true; inp.setAttribute('aria-expanded', 'false'); at = -1; };
  const render = () => {
    const q = norm(inp.value), todas = ordenarPt(E.vicinais);
    const comeca = todas.filter(v => norm(v).startsWith(q)), contem = todas.filter(v => !norm(v).startsWith(q) && norm(v).includes(q));
    opts = q ? [...comeca, ...contem] : todas; const exata = todas.some(v => norm(v) === q);
    dd.innerHTML = opts.map((v, i) => `<button type="button" role="option" class="op${i === at ? ' on' : ''}" data-v="${esc(v)}">${esc(v)}</button>`).join('') +
      (q && !exata ? `<div class="op new">Não achou? <b>“${esc(inp.value.trim())}”</b> será enviada como nova vicinal.</div>` : '') +
      (!opts.length && !q ? '<div class="op new">Nenhuma vicinal cadastrada ainda.</div>' : '');
    dd.hidden = false; inp.setAttribute('aria-expanded', 'true');
    dd.querySelectorAll('[data-v]').forEach(b => b.onmousedown = e => { e.preventDefault(); inp.value = b.dataset.v; fechar(); });
  };
  inp.addEventListener('focus', () => { render(); setTimeout(() => inp.scrollIntoView({ block: 'start', behavior: 'smooth' }), 250); });
  inp.addEventListener('input', () => { at = -1; render(); });
  inp.addEventListener('blur', () => setTimeout(fechar, 150));
  inp.addEventListener('keydown', e => {
    if (dd.hidden) return;
    if (e.key === 'ArrowDown') { at = Math.min(at + 1, opts.length - 1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { at = Math.max(at - 1, 0); render(); e.preventDefault(); }
    else if (e.key === 'Enter' && at >= 0) { inp.value = opts[at]; fechar(); e.preventDefault(); }
    else if (e.key === 'Escape') fechar();
  });
}

// ---------- banners ----------
const bannersAtivos = () => E.banners.filter(b => b.ativo && (!b.ate || new Date(b.ate + 'T23:59') >= new Date()));
function bannerTexto(b, link = true) { return `<span class="bt">${esc(b.titulo)}</span>${b.sub ? `<span class="bs">${esc(b.sub)}</span>` : ''}${link ? `<span class="bl">${b.tipo === 'link' ? 'Abrir link ›' : 'Ver campanha ›'}</span>` : ''}`; }
function bannerDentro(b, link = true) { const src = b._previa || urlBanner(b.img); return src ? `<img class="bimg" src="${esc(src)}" alt="${esc(b.titulo)}"><span class="cap">${bannerTexto(b, link)}</span>` : `<span class="tagc">Campanha</span>${bannerTexto(b, link)}`; }
const bnCls = b => `bn c-${b.cor || 'verde'}${b.img || b._previa ? ' has-img' : ''}`;
function bannerEl(b) {
  return b.tipo === 'link' && b.url ? `<a class="${bnCls(b)}" href="${esc(b.url)}" target="_blank" rel="noopener">${bannerDentro(b)}</a>`
    : `<button class="${bnCls(b)}" data-camp="${b.id}">${bannerDentro(b)}</button>`;
}
function carrossel() {
  const bs = bannersAtivos();
  if (!bs.length) return '<p class="slogan" style="margin-top:10px;padding:0 20px">Negócios e vantagens para o pecuarista.</p>';
  return `<div class="carwrap"><div class="carousel" id="car">${bs.map(bannerEl).join('')}</div></div>${bs.length > 1 ? `<div class="dots" id="dots">${bs.map((_, i) => `<i class="${i ? '' : 'on'}"></i>`).join('')}</div>` : ''}`;
}
let timerCarrossel;
function iniciarCarrossel() {
  clearInterval(timerCarrossel); const c = document.getElementById('car'); if (!c || c.children.length < 2) return;
  const dots = [...document.querySelectorAll('#dots i')], idx = () => Math.round(c.scrollLeft / c.clientWidth);
  c.onscroll = () => dots.forEach((d, i) => d.className = i === idx() ? 'on' : '');
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  timerCarrossel = setInterval(() => { if (!document.body.contains(c)) return clearInterval(timerCarrossel); c.scrollTo({ left: ((idx() + 1) % c.children.length) * c.clientWidth, behavior: 'smooth' }); }, 4500);
}

// =====================================================================
// TELAS
// =====================================================================
const TELAS = {};
const iconeVoltarAdm = () => ehAdmin() ? `<button class="ghost" data-a="trocarVisao" style="width:100%">${E.visao === 'adm' ? 'Abrir a área do produtor' : 'Voltar ao painel do comprador'}</button>` : '';

TELAS.login = () => MODO_COMPRADOR ? `<div class="login"><img src="${ICON}" alt="Logo Rede do Boi"><p class="slogan">Área do comprador<br>Lotes de gado à venda</p>
  <form id="f-login" novalidate><label for="l-fone">Seu telefone / WhatsApp com DDD<input id="l-fone" type="tel" inputmode="tel" autocomplete="tel" placeholder="(69) 99999-9999" required></label>
  <button class="cta green" type="submit">Ver os lotes</button></form>
  <p class="meta" style="text-align:center">Entre com o telefone que você informou à Rede do Boi. Não precisa de senha.</p>
  ${MODO === 'demo' ? '<p class="note"><b>Modo demonstração</b>. Comprador de exemplo: (69) 91111-2222.</p>' : ''}
  <a class="meta" href="./" style="text-align:center;margin-top:auto">Sou produtor: abrir o app Rede do Boi</a></div>`
  : `<div class="login"><img src="${ICON}" alt="Logo Rede do Boi"><p class="slogan">Negócios e vantagens<br>para o pecuarista.</p>
  <form id="f-login" novalidate><label for="l-fone">Seu telefone / WhatsApp com DDD<input id="l-fone" type="tel" inputmode="tel" autocomplete="tel" placeholder="(97) 99999-9999" required></label>
  <button class="cta green" type="submit">Entrar</button></form>
  <button class="cta inst-login" type="button" data-instalar>📲 Colocar o app na tela do celular</button>
  <p class="meta" style="text-align:center">Primeira vez? Digite seu telefone e toque em Entrar para fazer o cadastro. Não precisa de senha.</p>
  ${MODO === 'demo' ? '<p class="note"><b>Modo demonstração</b> (sem servidor). Produtor: João (97) 98888-1111. Comprador: Carlos (97) 90000-0009, senha boi123. Ou digite outro número para testar o cadastro.</p>' : ''}
  <p class="meta" style="text-align:center;margin-top:auto">Funciona sem internet depois do primeiro acesso.</p></div>`;

TELAS.senha = fone => `${topo('Acesso do comprador')}<div class="body"><form id="f-senha">
  <p class="meta">Este telefone é de um administrador. Digite a sua senha para entrar no painel.</p>
  <label>Telefone<input value="${esc(foneBonito(fone))}" disabled></label>
  <label for="s-senha">Senha<input id="s-senha" type="password" autocomplete="current-password" required></label>
  <button class="cta green" type="submit">Entrar</button></form></div>`;

TELAS.criarSenha = () => `<div class="login"><img src="${ICON}" alt=""><form id="f-csenha">
  <h2 class="sec">Você agora é administrador</h2>
  <p class="meta">Crie uma senha para proteger o painel do comprador. Ela será pedida quando você entrar em outro aparelho.</p>
  <label for="cs-1">Nova senha (mínimo 6)<input id="cs-1" type="password" minlength="6" autocomplete="new-password" required></label>
  <label for="cs-2">Repita a senha<input id="cs-2" type="password" minlength="6" autocomplete="new-password" required></label>
  <button class="cta green" type="submit">Salvar senha</button>
  <button class="ghost red" type="button" data-a="sair">Sair</button></form></div>`;

TELAS.cadastro = editar => {
  const u = editar ? E.perfil : {};
  return `${editar ? topo('Meus dados') : `<header class="bar"><h1 style="padding-left:4px">Cadastro</h1></header>`}
  <div class="body"><form id="f-cad">
  ${editar ? '' : '<p class="meta">Falta pouco! Preencha seus dados uma única vez. Depois o app entra direto.</p>'}
  <label for="c-nome">Nome completo<input id="c-nome" required autocomplete="name" value="${esc(u.nome)}"></label>
  <label>Telefone / WhatsApp<input value="${esc(foneBonito(E.usuario.fone))}" disabled></label>
  <label for="c-email">E-mail <span class="opt">(se tiver)</span><input id="c-email" type="email" autocomplete="email" value="${esc(u.email)}"></label>
  <label for="c-prop">Nome da propriedade<input id="c-prop" required value="${esc(u.prop)}"></label>
  <label for="c-local">Localidade<input id="c-local" value="${esc(u.local)}" placeholder="Ex.: Santo Antônio do Matupi"></label>
  <label for="c-mun">Município<select id="c-mun" required><option value="">Escolha</option>${[...new Set([...MUNICIPIOS, u.mun].filter(Boolean))].map(m => `<option ${u.mun === m ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></label>
  <label for="c-vic">Vicinal<span class="combo"><input id="c-vic" autocomplete="off" role="combobox" aria-expanded="false" aria-controls="vic-dd" value="${esc(u.vic)}" placeholder="Comece a digitar o nome"><span class="dd" id="vic-dd" role="listbox" hidden></span></span></label>
  <div class="two"><label for="c-km">Km na vicinal<input id="c-km" inputmode="decimal" value="${esc(u.km)}"></label></div>
  <p class="note">Escolha a sua vicinal na lista. Se ela não aparecer, digite o nome completo: o administrador recebe o nome para conferir.</p>
  <button class="cta green" type="submit">${editar ? 'Salvar dados' : 'Criar cadastro e entrar'}</button>
  ${editar ? '<button type="button" class="ghost red" data-a="sair">Sair desta conta</button>' : '<button type="button" class="ghost" data-a="sair">Usar outro telefone</button>'}
  </form></div>`;
};

TELAS.inicio = () => {
  const u = E.perfil;
  return `<div class="hello"><img src="${ICON}" alt="Rede do Boi"><button class="me" data-a="meusDados" aria-label="Meus dados"><span class="t">Olá,</span><span class="n">${esc(u.nome.split(' ')[0])}</span><span class="t">${esc(u.prop)} · <u>meus dados</u></span></button>${botaoSino()}</div>
  ${carrossel()}
  <div class="grid home-grid">
    <button class="tile wide" data-a="lancar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>Lançar compra ou venda</button>
    <button class="tile" data-a="meus"><svg viewBox="0 0 48 48" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 20c0-3 2-5 5-5h18c3 0 5 1 6 3l4 2-1 4h-3v12M12 20v16M16 30v6M30 30v6M12 28h22"/></svg>Meus<br>lançamentos${avisosProd().length ? ' <span class="dot"></span>' : ''}</button>
    <button class="tile alt" data-a="vantagens"><svg viewBox="0 0 48 48" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"><path d="M24 5l4 4 6-1 1 6 5 3-3 5 3 5-5 3-1 6-6-1-4 4-4-4-6 1-1-6-5-3 3-5-3-5 5-3 1-6 6 1z"/><path d="M18 30l12-12"/></svg>Clube de<br>Vantagens</button>
    <button class="tile alt" data-a="ofertas"><svg viewBox="0 0 48 48" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 20v8h6l14 8V12l-14 8z"/><path d="M14 28l3 10h4l-2-9"/><path d="M34 18l4-3M35 24h5M34 30l4 3"/></svg>Ofertas<br>Especiais</button>
    <button class="tile" data-a="parceiros"><svg viewBox="0 0 48 48" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 18l8-6 8 3 4-2 4 2 8-3 8 6"/><path d="M20 15l-6 7c2 2 4 2 6 0l4-3 10 9"/></svg>Nossos<br>Parceiros</button>
  </div>
  ${ehAdmin() ? `<div style="padding:0 20px 10px">${iconeVoltarAdm()}</div>` : ''}
  <div class="foot">Juntos pelo produtor rural!</div>`;
};

TELAS.lancar = () => {
  const d = rascunho; if (!d) return topo('Lançamento') + '<div class="empty">Nada para lançar.</div>';
  const venda = d.tipo === 'venda';
  return `${topo(d.editando ? 'Alterar lançamento' : 'Novo lançamento')}<div class="body">
  ${d.editando ? '' : `<h2 class="sec">1. O que você quer fazer?</h2>
  <div class="choice"><button type="button" data-tipo="venda" aria-pressed="${d.tipo === 'venda'}">Vender<small>Ofertar meu gado</small></button><button type="button" data-tipo="compra" aria-pressed="${d.tipo === 'compra'}">Comprar<small>Procuro animais</small></button></div>`}
  ${d.tipo ? `<h2 class="sec">${d.editando ? '' : '2. '}Tipo de animal</h2>
  <div class="cats">${CATS.map(([k, v]) => `<button type="button" data-cat="${k}" aria-pressed="${d.cat === k}">${v}</button>`).join('')}</div>` : ''}
  ${d.cat ? `<form id="f-lanc" novalidate>
   <div class="two"><label for="d-qtd">Quantidade (cabeças)<input id="d-qtd" type="number" inputmode="numeric" min="1" step="1" required value="${d.qtd ?? ''}"></label>
   <label for="d-peso">Peso médio<span style="display:flex;gap:6px;min-width:0"><input style="flex:1" id="d-peso" type="number" inputmode="decimal" min="0.5" step="0.1" required value="${d.peso ?? ''}"><select id="d-un" aria-label="Unidade" style="width:66px;flex:none;padding:10px 4px">${['@', 'kg'].map(u => `<option ${(d.un || '@') === u ? 'selected' : ''}>${u}</option>`).join('')}</select></span></label></div>
   <label for="d-valor">${venda ? 'Valor que pretende receber por @ (R$)' : 'Valor que pretende pagar por @ (R$)'}<input id="d-valor" type="number" inputmode="decimal" min="0" step="0.01" required value="${d.valor ?? ''}"></label>
   <div class="total"><span>Total estimado do lote<br><span class="meta" id="d-conv">${d.peso ? pesoTxt({ peso: d.peso, un: d.un || '@' }) + ' por cabeça' : '1 @ = 30 kg (peso vivo)'}</span></span><b class="price" id="d-total">${brl0(total(d))}</b></div>
   <label>Fotos ou vídeos dos animais <span class="opt">${venda ? '' : '(opcional)'}</span></label>
   <div class="media" id="d-media">${d.midias.map((m, i) => `<div class="m">${m.kind === 'video' ? `<video src="${esc(urlMidia(m))}#t=0.1" muted preload="metadata"></video><span class="play">▶</span>` : `<img src="${esc(urlMidia(m))}" alt="Foto ${i + 1}">`}<button type="button" class="x" data-rm="${i}" aria-label="Remover">×</button></div>`).join('')}
   <label class="addm" for="d-cam">📷<br>Tirar foto<input id="d-cam" type="file" accept="image/*" capture="environment"></label>
   <label class="addm" for="d-vid">🎥<br>Gravar vídeo<input id="d-vid" type="file" accept="video/*" capture="environment"></label>
   <label class="addm" for="d-file">＋<br>Da galeria<input id="d-file" type="file" accept="image/*,video/*" multiple></label></div>
   <div class="meta">Data do lançamento: <b>${fdt(d.criado_em || Date.now())}</b> (automática)</div>
   <button class="cta green" type="submit">${d.editando ? 'Salvar alterações' : (venda ? 'Lançar venda' : 'Lançar pedido de compra')}</button>
   ${d.editando ? '<button type="button" class="ghost red" data-a="excluir">Excluir lançamento</button>' : ''}
  </form>` : ''}
  </div>`;
};

TELAS.meus = () => {
  const ls = meusLancs();
  return `${topo('Meus lançamentos', true)}<div class="body">
  ${ls.length ? ls.map(l => `<button class="item" data-abrir="${l.id}"><div class="row"><span>${seloTipo(l)} ${selo(l)}</span>${l.prod_novo ? '<span class="dot" title="Nova mensagem"></span>' : ''}</div>
   <h3>${lancTitulo(l)}</h3><div class="meta">${pesoTxt(l)} · ${brl(l.valor)}/@ · ${fd(l.criado_em)}</div>
   ${ultimaOferta(l) ? `<div class="meta">Última oferta do comprador: <b>${brl(ultimaOferta(l))}/@</b></div>` : ''}</button>`).join('') : '<div class="empty">Você ainda não lançou nada.</div>'}
  <button class="cta" data-a="lancar">+ Novo lançamento</button></div>`;
};

function conversa(l, lado) {
  return `<div class="chat">${(l.mensagens || []).map(h => {
    if (h.papel === 'sys') return `<div class="msg sys">${esc(h.texto)} · ${fdt(h.criado_em)}</div>`;
    const meu = (lado === 'prod' && h.papel === 'prod') || (lado === 'adm' && h.papel === 'adm' && h.autor === E.usuario.id);
    const quem = h.papel === 'adm' ? (h.autor_nome || 'Comprador') + ' · Rede do Boi' : (h.autor_nome || 'Produtor');
    return `<div class="msg ${meu ? 'me' : 'them'}">${h.oferta ? `<div class="offer">Oferta: <b>${brl(h.oferta)}/@</b><br><span class="meta">Lote: ${brl0(h.oferta * l.qtd * arroba(l))}</span></div>` : ''}${esc(h.texto)}<span class="w">${esc(quem)} · ${h.pendente ? 'aguardando internet' : fdt(h.criado_em)}</span></div>`;
  }).join('')}</div>`;
}

TELAS.lote = id => {
  const l = meusLancs().find(x => x.id === id);
  if (!l) return topo('Lançamento') + '<div class="empty">Lançamento excluído.</div>';
  return `${topo(lancTitulo(l))}<div class="body">
  <div class="row"><span>${seloTipo(l)} ${selo(l)}</span>${l.status === 'fechado' || l.status === 'cancelado' ? '' : '<button class="ghost" data-a="editar">Alterar</button>'}</div>
  ${galeria(l, false)}
  <dl class="kv"><dt>Peso médio</dt><dd>${pesoTxt(l)}</dd><dt>${l.tipo === 'venda' ? 'Valor pedido' : 'Valor que paga'}</dt><dd>${brl(l.valor)}/@</dd><dt>Total estimado</dt><dd>${brl0(total(l))}</dd><dt>Lançado em</dt><dd>${fdt(l.criado_em)}</dd>${l.valor_fechado ? `<dt>Fechado por</dt><dd>${brl(l.valor_fechado)}/@</dd>` : ''}</dl>
  <h2 class="sec">Negociação</h2>
  ${l.pendente ? '<p class="note">Este lançamento está guardado no aparelho e será enviado sozinho quando houver internet.</p>' : `${conversa(l, 'prod')}
  <form id="f-resp" class="reply"><textarea id="r-txt" rows="2" placeholder="Responder ao comprador" aria-label="Responder ao comprador"></textarea><button class="cta green" style="width:auto" type="submit">Enviar</button></form>
  ${WA ? `<a class="wa" href="${waLink(WA, 'Olá, sobre meu lançamento de ' + lancTitulo(l) + ' no Rede do Boi')}" target="_blank" rel="noopener">Continuar pelo WhatsApp</a>` : ''}`}
  </div>`;
};

TELAS.avisos = () => {
  if (E.visao === 'comp') {
    const ls = lotesNovosComp();
    return `${topo('Avisos')}<div class="body">${botaoPermitirAvisos()}${ls.length ? ls.map(l => { const ult = msgsLote(l).filter(m => m.papel === 'adm').pop() || {};
      return `<button class="item" data-cl="${l.id}"><h3>Resposta da Rede do Boi</h3><div class="meta">${lancTitulo(l)} · “${esc(ult.texto)}”</div></button>`; }).join('') : '<div class="empty">Nenhum aviso novo.</div>'}</div>`;
  }
  if (E.visao === 'adm') {
    const ls = avisosAdm(), bs = E.adm.banners.filter(b => (b.interesses || []).some(i => i.novo)), lr = lotesNovosAdm();
    return `${topo('Avisos')}<div class="body">${botaoPermitirAvisos()}
    ${lr.map(l => { const ns = msgsLote(l).filter(m => m.adm_novo), ult = ns[ns.length - 1] || {};
      return `<button class="item" data-rl="${l.id}"><h3>${ns.some(m => m.quer_comprar) ? 'Comprador quer comprar o lote' : 'Pergunta de comprador'}</h3><div class="meta">${esc(ult.autor_nome || '')} · ${lancTitulo(l)} · ${fdt(ult.criado_em)}</div>${ult.texto ? `<div class="meta">“${esc(ult.texto)}”</div>` : ''}</button>`; }).join('')}
    ${bs.map(b => `<button class="item" data-banner="${b.id}"><h3>${(b.interesses || []).filter(i => i.novo).length} novo(s) interessado(s) na campanha</h3><div class="meta">${esc(b.titulo)}</div></button>`).join('')}
    ${ls.map(l => { const ult = (l.mensagens || [])[(l.mensagens || []).length - 1]; const novo = (l.mensagens || []).filter(m => m.papel !== 'sys').length === 0 && !l.excluido_em;
      return `<button class="item" data-abrir="${l.id}"><h3>${l.excluido_em ? 'Lançamento excluído pelo produtor' : novo ? `Novo ${l.tipo === 'venda' ? 'lançamento de venda' : 'pedido de compra'}` : (ult && ult.papel === 'prod' ? 'Resposta do produtor' : 'Lançamento alterado')}</h3><div class="meta">${esc((l.perfil || {}).nome)} · ${lancTitulo(l)} · ${fdt(ult ? ult.criado_em : l.criado_em)}</div>${ult && ult.papel === 'prod' ? `<div class="meta">“${esc(ult.texto)}”</div>` : ''}</button>`; }).join('')}
    ${!ls.length && !bs.length && !lr.length ? '<div class="empty">Nenhum aviso novo.</div>' : ''}</div>`;
  }
  const ls = avisosProd();
  return `${topo('Avisos')}<div class="body">${botaoPermitirAvisos()}${ls.length ? ls.map(l => { const ult = l.mensagens[l.mensagens.length - 1] || {};
    return `<button class="item" data-abrir="${l.id}"><h3>${ult.oferta ? 'Nova oferta: ' + brl(ult.oferta) + '/@' : 'Nova mensagem do comprador'}</h3><div class="meta">${lancTitulo(l)} · ${esc(ult.texto)}</div></button>`; }).join('') : '<div class="empty">Nenhum aviso novo.</div>'}</div>`;
};
function botaoPermitirAvisos() {
  if (!('Notification' in window) || Notification.permission === 'granted') return '';
  return `<button class="ghost" data-a="permitirAvisos" style="width:100%">🔔 Receber avisos no celular</button>`;
}

const vantagemValida = v => v.ativo && (!v.ate || new Date(v.ate + 'T23:59') >= new Date());
const parceiroDe = v => E.parceiros.find(p => p.id === v.parceiro_id);
const imgOuIcone = (img, letra) => img ? `<img class="thumb" src="${esc(urlBanner(img))}" alt="" loading="lazy">` : `<span class="thumb ph" aria-hidden="true">${esc((letra || '?').slice(0, 1).toUpperCase())}</span>`;
function cartaoVantagem(v, comParceiro = true) {
  const p = parceiroDe(v);
  return `<div class="item card-v">${v.img ? `<img class="capa" src="${esc(urlBanner(v.img))}" alt="" loading="lazy">` : ''}
   <div class="row"><h3>${esc(v.titulo)}</h3>${v.desconto ? `<span class="selo-desc">${esc(v.desconto)}</span>` : ''}</div>
   ${comParceiro && p ? `<button class="lnk" data-parc="${p.id}">${esc(p.nome)} ›</button>` : ''}
   ${v.descr ? `<div class="meta">${esc(v.descr).replace(/\n/g, '<br>')}</div>` : ''}
   ${v.ate ? `<div class="meta">Válida até <b>${new Date(v.ate + 'T12:00').toLocaleDateString('pt-BR')}</b></div>` : ''}
   ${p && p.fone ? `<a class="wa" href="${waLink(p.fone, `Olá, sou produtor da Rede do Boi e quero usar a vantagem: ${v.titulo}`)}" target="_blank" rel="noopener">Usar vantagem pelo WhatsApp</a>` : ''}</div>`;
}
TELAS.vantagens = () => {
  const vs = E.vantagens.filter(vantagemValida);
  return `${topo('Clube de Vantagens')}<div class="body">
  ${vs.length ? `<p class="meta">Descontos exclusivos para os produtores da Rede do Boi. Mostre o app ou chame o parceiro pelo WhatsApp.</p>${vs.map(v => cartaoVantagem(v)).join('')}`
    : `<div class="empty">Em breve: descontos exclusivos para os produtores da Rede do Boi em lojas e serviços parceiros da região.</div>${WA ? `<a class="wa" href="${waLink(WA, 'Olá, quero saber do Clube de Vantagens da Rede do Boi')}" target="_blank" rel="noopener">Quero saber mais</a>` : ''}`}</div>`;
};
TELAS.ofertas = () => `${topo('Ofertas Especiais')}<div class="body">${bannersAtivos().length ? bannersAtivos().map(b => `<div>${bannerEl(b)}</div>`).join('') : '<div class="empty">Nenhuma oferta no momento. Volte em breve.</div>'}</div>`;
TELAS.parceiros = () => {
  const ps = E.parceiros.filter(p => p.ativo);
  return `${topo('Nossos Parceiros')}<div class="body">
  ${ps.length ? ps.map(p => { const n = E.vantagens.filter(v => v.parceiro_id === p.id && vantagemValida(v)).length;
    return `<button class="item parc" data-parc="${p.id}">${imgOuIcone(p.img, p.nome)}<span class="parc-t"><h3>${esc(p.nome)}</h3>${p.categoria ? `<span class="meta">${esc(p.categoria)}${p.mun ? ' · ' + esc(p.mun) : ''}</span>` : ''}${p.oferece ? `<span class="meta">${esc(p.oferece)}</span>` : ''}${n ? `<span class="selo-desc">${n} vantagem${n > 1 ? 'ns' : ''}</span>` : ''}</span></button>`; }).join('')
    : '<div class="empty">Em breve: a lista de parceiros da região (agropecuárias, veterinários, transportadores).</div>'}
  ${WA ? `<a class="wa" href="${waLink(WA, 'Olá, quero ser parceiro da Rede do Boi')}" target="_blank" rel="noopener">Quero ser parceiro</a>` : ''}</div>`;
};
TELAS.parceiro = id => {
  const p = E.parceiros.find(x => x.id === id);
  if (!p) return topo('Parceiro') + '<div class="empty">Parceiro não encontrado.</div>';
  const vs = E.vantagens.filter(v => v.parceiro_id === p.id && vantagemValida(v));
  return `${topo(esc(p.nome))}<div class="body">
  <div class="parc parc-top">${imgOuIcone(p.img, p.nome)}<span class="parc-t"><h3>${esc(p.nome)}</h3>${p.categoria ? `<span class="pill p-venda" style="align-self:flex-start">${esc(p.categoria)}</span>` : ''}</span></div>
  ${p.oferece ? `<h2 class="sec">O que oferece</h2><p style="margin:0;line-height:1.5">${esc(p.oferece)}</p>` : ''}
  ${p.descr ? `<p class="meta" style="font-size:14px;line-height:1.5;margin:0">${esc(p.descr).replace(/\n/g, '<br>')}</p>` : ''}
  ${p.endereco || p.mun ? `<div class="meta">📍 ${esc([p.endereco, p.mun].filter(Boolean).join(' · '))}</div>` : ''}
  ${p.fone ? `<a class="wa" href="${waLink(p.fone, 'Olá, sou produtor da Rede do Boi.')}" target="_blank" rel="noopener">Chamar no WhatsApp</a><div class="copy">${esc(foneBonito(p.fone))}</div>` : ''}
  ${vs.length ? `<h2 class="sec">Vantagens para você</h2>${vs.map(v => cartaoVantagem(v, false)).join('')}` : ''}</div>`;
};

// ---------- administrador: vantagens e parceiros ----------
TELAS.admVantagens = () => `${topo('Clube de Vantagens')}<div class="body">
  <p class="note">As vantagens ativas aparecem para os produtores em Clube de Vantagens. Ligue cada uma a um parceiro para o produtor poder chamar no WhatsApp.</p>
  <button class="cta green" data-a="novaVantagem">+ Nova vantagem</button>
  ${E.vantagens.map(v => { const p = parceiroDe(v), venc = v.ate && !vantagemValida({ ...v, ativo: true });
    return `<div class="item"><div class="row"><h3>${esc(v.titulo)}</h3>${v.desconto ? `<span class="selo-desc">${esc(v.desconto)}</span>` : ''}</div>
    <div class="meta">${p ? esc(p.nome) : 'Sem parceiro'}${v.ate ? ' · até ' + new Date(v.ate + 'T12:00').toLocaleDateString('pt-BR') : ''}</div>
    <div class="row"><span>${venc ? '<span class="pill p-cancelado">Vencida</span>' : v.ativo ? '<span class="pill p-fechado">Ativa</span>' : '<span class="pill p-cancelado">Pausada</span>'}</span>
    <span class="btns"><button class="ghost" data-ev="${v.id}">Editar</button><button class="ghost" data-pv="${v.id}">${v.ativo ? 'Pausar' : 'Ativar'}</button></span></div></div>`; }).join('') || '<div class="empty">Nenhuma vantagem ainda.</div>'}
  </div>`;

TELAS.admVantagem = id => {
  const d = rascunho;
  return `${topo(id ? 'Editar vantagem' : 'Nova vantagem')}<div class="body"><form id="f-vant">
  <label for="v-tit">Título da vantagem<input id="v-tit" required maxlength="80" value="${esc(d.titulo)}" placeholder="Ex.: Desconto em ração e suplemento"></label>
  <label for="v-desc">Desconto <span class="opt">(aparece em destaque)</span><input id="v-desc" maxlength="30" value="${esc(d.desconto)}" placeholder="Ex.: 10% ou R$ 0,20 por litro"></label>
  <label for="v-parc">Parceiro<select id="v-parc"><option value="">Sem parceiro</option>${E.parceiros.map(p => `<option value="${p.id}" ${d.parceiro_id === p.id ? 'selected' : ''}>${esc(p.nome)}${p.ativo ? '' : ' (pausado)'}</option>`).join('')}</select></label>
  ${E.parceiros.length ? '' : '<p class="meta">Cadastre primeiro o parceiro em Nossos Parceiros para ligar a vantagem a ele.</p>'}
  <label for="v-regras">Como usar / regras<textarea id="v-regras" rows="4" placeholder="Ex.: Mostre o app no caixa. Válido para compras acima de R$ 200.">${esc(d.descr)}</textarea></label>
  <label>Foto <span class="opt">(opcional)</span></label>
  <div class="media">${d._previa || d.img ? `<div class="m"><img src="${esc(d._previa || urlBanner(d.img))}" alt=""><button type="button" class="x" data-a="tirarFoto" aria-label="Remover foto">×</button></div>` : ''}<label class="addm" for="v-img">＋<br>${d.img || d._previa ? 'Trocar' : 'Foto'}<input id="v-img" type="file" accept="image/*"></label></div>
  <div class="two"><label for="v-ate">Válida até <span class="opt">(opcional)</span><input id="v-ate" type="date" value="${esc(d.ate || '')}"></label>
  <label class="sw" for="v-at" style="flex-direction:row;align-self:end;padding-bottom:12px"><input id="v-at" type="checkbox" ${d.ativo ? 'checked' : ''}> Ativa</label></div>
  <button class="cta green" type="submit">${id ? 'Salvar vantagem' : 'Publicar vantagem'}</button>
  ${id ? '<button type="button" class="ghost red" data-a="excluirVantagem">Excluir vantagem</button>' : ''}</form></div>`;
};

TELAS.admParceiros = () => `${topo('Nossos Parceiros')}<div class="body">
  <p class="note">Os parceiros ativos aparecem para os produtores em Nossos Parceiros, com o que cada um oferece e o WhatsApp.</p>
  <button class="cta green" data-a="novoParceiro">+ Novo parceiro</button>
  ${E.parceiros.map(p => { const n = E.vantagens.filter(v => v.parceiro_id === p.id).length;
    return `<div class="item"><div class="parc">${imgOuIcone(p.img, p.nome)}<span class="parc-t"><h3>${esc(p.nome)}</h3><span class="meta">${esc([p.categoria, p.mun].filter(Boolean).join(' · '))}</span>${p.oferece ? `<span class="meta">${esc(p.oferece)}</span>` : ''}</span></div>
    <div class="row"><span>${p.ativo ? '<span class="pill p-fechado">Ativo</span>' : '<span class="pill p-cancelado">Pausado</span>'} <span class="meta">${n} vantagem(ns)</span></span>
    <span class="btns"><button class="ghost" data-ep="${p.id}">Editar</button><button class="ghost" data-pp="${p.id}">${p.ativo ? 'Pausar' : 'Ativar'}</button></span></div></div>`; }).join('') || '<div class="empty">Nenhum parceiro ainda.</div>'}
  </div>`;

TELAS.admParceiro = id => {
  const d = rascunho;
  const vs = id ? E.vantagens.filter(v => v.parceiro_id === id) : [];
  return `${topo(id ? 'Editar parceiro' : 'Novo parceiro')}<div class="body"><form id="f-parc">
  <label for="pa-nome">Nome do parceiro<input id="pa-nome" required maxlength="80" value="${esc(d.nome)}" placeholder="Ex.: Agropecuária Campo Forte"></label>
  <label for="pa-cat">Tipo de negócio<input id="pa-cat" list="pa-cats" maxlength="40" value="${esc(d.categoria)}" placeholder="Ex.: Agropecuária"></label>
  <datalist id="pa-cats">${['Agropecuária', 'Veterinário', 'Transporte de gado', 'Posto de combustível', 'Frigorífico', 'Leiloeiro', 'Máquinas e peças', 'Material de construção', 'Banco / crédito rural', 'Assistência técnica'].map(c => `<option value="${c}">`).join('')}</datalist>
  <label for="pa-of">O que oferece<textarea id="pa-of" rows="2" placeholder="Ex.: Ração, sal mineral, arame, vacinas">${esc(d.oferece)}</textarea></label>
  <label for="pa-desc">Mais informações <span class="opt">(opcional)</span><textarea id="pa-desc" rows="3" placeholder="Ex.: Entrega nas vicinais às terças e sextas.">${esc(d.descr)}</textarea></label>
  <label for="pa-fone">WhatsApp do parceiro<input id="pa-fone" type="tel" inputmode="tel" value="${esc(d.fone ? foneBonito(d.fone) : '')}" placeholder="(97) 99999-9999"></label>
  <div class="two"><label for="pa-end">Endereço <span class="opt">(opcional)</span><input id="pa-end" value="${esc(d.endereco)}"></label>
  <label for="pa-mun">Município<input id="pa-mun" list="pa-muns" value="${esc(d.mun)}"></label></div>
  <datalist id="pa-muns">${MUNICIPIOS.map(m => `<option value="${m}">`).join('')}</datalist>
  <label>Logo ou foto <span class="opt">(opcional)</span></label>
  <div class="media">${d._previa || d.img ? `<div class="m"><img src="${esc(d._previa || urlBanner(d.img))}" alt=""><button type="button" class="x" data-a="tirarFoto" aria-label="Remover foto">×</button></div>` : ''}<label class="addm" for="pa-img">＋<br>${d.img || d._previa ? 'Trocar' : 'Foto'}<input id="pa-img" type="file" accept="image/*"></label></div>
  <label class="sw" for="pa-at" style="flex-direction:row"><input id="pa-at" type="checkbox" ${d.ativo ? 'checked' : ''}> Ativo (aparece para os produtores)</label>
  <button class="cta green" type="submit">${id ? 'Salvar parceiro' : 'Cadastrar parceiro'}</button>
  ${id ? '<button type="button" class="ghost red" data-a="excluirParceiro">Excluir parceiro</button>' : ''}</form>
  ${id ? `<h2 class="sec">Vantagens deste parceiro (${vs.length})</h2>${vs.map(v => `<div class="item"><div class="row"><h3>${esc(v.titulo)}</h3>${v.desconto ? `<span class="selo-desc">${esc(v.desconto)}</span>` : ''}</div><button class="ghost" data-ev="${v.id}" style="align-self:flex-start">Editar</button></div>`).join('')}
  <button class="ghost" data-a="novaVantagem" style="width:100%">+ Nova vantagem deste parceiro</button>` : ''}</div>`;
};

TELAS.campanha = id => {
  const b = E.banners.find(x => x.id === id) || E.adm.banners.find(x => x.id === id);
  if (!b) return topo('Campanha') + '<div class="empty">Campanha encerrada.</div>';
  const ja = E.interesses.includes(b.id) || E.fila.some(i => i.op === 'interesse' && i.dados.banner_id === b.id);
  return `${topo('Campanha')}<div class="${bnCls(b)}" style="border-radius:0">${bannerDentro(b, false)}</div>
  <div class="body">${b.img ? `<h2 style="margin:0;font-family:var(--display);color:var(--pasto)">${esc(b.titulo)}</h2>` : ''}<p style="margin:0;line-height:1.5;font-size:15px">${esc(b.descr).replace(/\n/g, '<br>')}</p>
  ${b.ate ? `<div class="meta">Válida até <b>${new Date(b.ate + 'T12:00').toLocaleDateString('pt-BR')}</b></div>` : ''}
  <button class="cta green" data-a="interesse" ${ja ? 'disabled style="opacity:.6"' : ''}>${ja ? 'Interesse enviado ✓' : 'Tenho interesse'}</button>
  ${WA ? `<a class="wa" href="${waLink(WA, 'Olá, tenho interesse na campanha: ' + b.titulo)}" target="_blank" rel="noopener">Falar pelo WhatsApp</a>` : ''}</div>`;
};

// ---------- administrador ----------
TELAS.admLista = () => {
  const fs = ['todos', 'novo', 'negociacao', 'visita', 'fechado', 'cancelado'];
  const ls = E.adm.lancs.filter(l => (E.filtroAdm === 'todos' ? !l.excluido_em : l.status === E.filtroAdm && !l.excluido_em))
    .sort((a, b) => (b.adm_novo - a.adm_novo) || String(b.criado_em).localeCompare(String(a.criado_em)));
  const sug = E.adm.sugestoes.length, novosInt = interessesNovos();
  return `<header class="bar"><img src="${ICON}" alt="" style="width:34px;height:34px;border-radius:9px"><h1>Painel do comprador</h1><span class="who">${esc(E.perfil.nome.split(' ')[0])}</span>${botaoSino()}</header><div class="body">
  <div class="chips">${fs.map(f => `<button class="chip" data-f="${f}" aria-pressed="${E.filtroAdm === f}">${f === 'todos' ? 'Todos' : ST[f]} <small>${f === 'todos' ? E.adm.lancs.filter(l => !l.excluido_em).length : E.adm.lancs.filter(l => l.status === f && !l.excluido_em).length}</small></button>`).join('')}</div>
  ${!E.carregado && !E.adm.lancs.length ? '<div class="empty">Carregando...</div>' : ls.length ? ls.map(l => { const u = l.perfil || {};
    return `<button class="item" data-abrir="${l.id}"><div class="row"><span>${seloTipo(l)} ${selo(l)}</span>${l.adm_novo ? '<span class="dot" title="Não lido"></span>' : ''}</div>
   <h3>${lancTitulo(l)}</h3><div class="meta">${esc(u.nome)} · ${esc(u.prop)} · ${esc(u.mun)}${u.vic ? ' · ' + esc(u.vic) : ''}${u.km ? ' km ' + esc(u.km) : ''}</div><div class="meta">Responsável: ${esc(responsavel(l))} · ${fd(l.criado_em)}</div>
   <div class="row"><span class="meta">${pesoTxt(l)} · ${l.tipo === 'venda' ? 'pede' : 'paga'} ${brl(l.valor)}/@</span><span class="price">${brl0(total(l))}</span></div></button>`; }).join('') : '<div class="empty">Nada neste filtro.</div>'}
  <div class="admbtns">
  <button class="cta" data-a="relatorio">Relatório de negociações</button>
  <button class="cta green" data-a="admRevenda">Lotes para revenda${lotesNovosAdm().length ? ' <span class="dot"></span>' : ''}</button>
  <button class="ghost" data-a="admCompradores">Compradores dos lotes</button>
  <button class="ghost" data-a="admBanners">Banners da tela inicial${novosInt ? ' <span class="dot"></span>' : ''}</button>
  <button class="ghost" data-a="admVic">Vicinais${sug ? ` · ${sug} nova(s) para conferir` : ''}</button>
  <button class="ghost" data-a="admVantagens">Clube de Vantagens</button>
  <button class="ghost" data-a="admParceiros">Nossos Parceiros</button>
  <button class="ghost" data-a="admProdutores">Produtores e administradores</button>
  ${iconeVoltarAdm()}
  <button class="ghost red" data-a="sair">Sair</button></div></div>`;
};

// Mensagem que já vem escrita abaixo da oferta (o administrador pode mudar antes de enviar)
const mensagemPadraoOferta = u => `Olá ${((u && u.nome) || '').trim().split(/\s+/)[0] || 'produtor'}, temos interessados no seu rebanho, caso aceite a proposta podemos agendar uma visita.`;
TELAS.admLote = id => {
  const l = E.adm.lancs.find(x => x.id === id);
  if (!l) return topo('Lançamento') + '<div class="empty">Lançamento não encontrado.</div>';
  const u = l.perfil || {};
  return `${topo(lancTitulo(l))}<div class="body">
  <div class="row"><span>${seloTipo(l)} ${selo(l)}</span><span class="meta">${fdt(l.criado_em)}</span></div>
  ${galeria(l, true)}
  <dl class="kv"><dt>Quantidade</dt><dd>${num(l.qtd)} cabeças</dd><dt>Peso médio</dt><dd>${pesoTxt(l)}</dd><dt>${l.tipo === 'venda' ? 'Valor pedido' : 'Valor que paga'}</dt><dd>${brl(l.valor)}/@</dd><dt>Total</dt><dd>${brl0(total(l))}</dd></dl>
  <div class="item"><h3>${esc(u.nome)}</h3><div class="meta">${esc(u.prop)}${u.local ? ' · ' + esc(u.local) : ''}<br>${esc(u.mun)}${u.vic ? ' · ' + esc(u.vic) : ''}${u.km ? ', km ' + esc(u.km) : ''}<br>WhatsApp: ${esc(foneBonito(u.fone))}${u.email ? ' · ' + esc(u.email) : ''}</div>
   <a class="wa" href="${waLink(u.fone, `Olá ${(u.nome || '').split(' ')[0]}, aqui é da Rede do Boi, sobre seu lançamento de ${lancTitulo(l)}.`)}" target="_blank" rel="noopener">Chamar no WhatsApp</a></div>
  <h2 class="sec">Situação</h2>
  <form id="f-st" class="two"><label for="s-st">Status<select id="s-st">${Object.entries(ST).map(([k, v]) => `<option value="${k}" ${l.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
   <label for="s-val">Valor fechado (R$/@)<input id="s-val" type="number" inputmode="decimal" step="0.01" value="${l.valor_fechado ?? ''}" placeholder="Ao fechar"></label>
   <button class="ghost" type="submit" style="grid-column:1/-1">Salvar situação</button></form>
  ${l.tipo === 'venda' && l.status === 'fechado' ? (() => { const ja = E.adm.lotes.find(x => x.origem_lanc === l.id);
    return ja ? `<button class="ghost" data-rl="${ja.id}" style="width:100%">Ver o lote de revenda deste gado</button>` : '<button class="ghost" data-a="separarRevenda" style="width:100%">Separar este gado para revenda</button>'; })() : ''}
  <h2 class="sec">Histórico</h2>${conversa(l, 'adm')}
  ${l.excluido_em ? '<p class="note">O produtor excluiu este lançamento. Ele continua no relatório.</p>' : `<h2 class="sec">Fazer oferta ou mandar mensagem</h2>
  <form id="f-of"><label for="o-val">Oferta por @ (R$) <span class="opt">(opcional)</span><input id="o-val" type="number" inputmode="decimal" step="0.01" placeholder="Ex.: ${Math.max(0, (Number(l.valor) || 0) - 5)}"></label>
   <label for="o-txt">Mensagem<textarea id="o-txt" rows="4" placeholder="Escreva para o produtor">${l.tipo === 'venda' ? esc(mensagemPadraoOferta(u)) : ''}</textarea></label>
   <button class="cta green" type="submit">Enviar ao produtor</button></form>`}</div>`;
};

TELAS.admBanners = () => `${topo('Banners da tela inicial')}<div class="body">
  <p class="note">Os banners ativos aparecem no topo da tela inicial do produtor, passando um a um. Arte ideal: imagem deitada de 1200 × 400.</p>
  <button class="cta green" data-a="novoBanner">+ Novo banner</button>
  ${E.adm.banners.map(b => { const ni = (b.interesses || []).filter(i => i.novo).length;
    return `<div class="item"><div class="${bnCls(b)}">${bannerDentro(b)}</div>
   <div class="row"><span class="meta">${b.ativo ? '<span class="pill p-fechado">Ativo</span>' : '<span class="pill p-cancelado">Pausado</span>'} ${b.ate ? ' até ' + new Date(b.ate + 'T12:00').toLocaleDateString('pt-BR') : ''}</span>
   <span class="meta">${b.tipo === 'link' ? 'Link externo' : `${(b.interesses || []).length} interessado(s)`}${ni ? ' <span class="dot"></span>' : ''}</span></div>
   <div class="btns"><button class="ghost" data-banner="${b.id}">Editar${b.tipo === 'campanha' ? ' e ver interessados' : ''}</button><button class="ghost" data-pausar="${b.id}">${b.ativo ? 'Pausar' : 'Ativar'}</button></div></div>`; }).join('') || '<div class="empty">Nenhum banner ainda.</div>'}
  </div>`;

TELAS.admBanner = id => {
  const d = rascunho; const b = E.adm.banners.find(x => x.id === id) || { interesses: [] };
  return `${topo(id ? 'Editar banner' : 'Novo banner')}<div class="body">
  <h2 class="sec">Prévia</h2><div class="${bnCls(d)}" id="pv">${bannerDentro({ ...d, titulo: d.titulo || 'Título do banner' })}</div>
  <form id="f-bn">
   <label for="b-tit">Título<input id="b-tit" required maxlength="60" value="${esc(d.titulo)}" placeholder="Ex.: Touros PO em condições especiais"></label>
   <label for="b-sub">Frase curta <span class="opt">(opcional)</span><input id="b-sub" maxlength="70" value="${esc(d.sub)}"></label>
   <label>Fundo <span class="opt">(cor, ou foto deitada de 1200 × 400)</span></label>
   <div class="colors">${[['verde', '#1a6b2f'], ['ouro', '#f4b81c'], ['terra', '#7a4c22']].map(([k, c]) => `<button type="button" data-cor="${k}" aria-pressed="${!d.img && !d._previa && d.cor === k}" style="background:${c}" aria-label="${k}"></button>`).join('')}
    <label class="addm" for="b-img" style="width:auto;height:32px;padding:0 10px;font-size:12px">${d.img || d._previa ? 'Trocar foto' : 'Usar foto'}<input id="b-img" type="file" accept="image/*"></label></div>
   <label>Ao tocar no banner, abrir</label>
   <div class="choice"><button type="button" data-tp="campanha" aria-pressed="${d.tipo === 'campanha'}">Página da campanha<small>Texto + botão "Tenho interesse"</small></button><button type="button" data-tp="link" aria-pressed="${d.tipo === 'link'}">Link externo<small>Site, formulário, vídeo</small></button></div>
   ${d.tipo === 'link' ? `<label for="b-url">Endereço do link<input id="b-url" type="url" required placeholder="https://..." value="${esc(d.url)}"></label>`
    : `<label for="b-desc">Texto da campanha<textarea id="b-desc" rows="5" required>${esc(d.descr)}</textarea></label>`}
   <div class="two"><label for="b-ate">Válido até <span class="opt">(opcional)</span><input id="b-ate" type="date" value="${esc(d.ate || '')}"></label>
   <label class="sw" for="b-at" style="flex-direction:row;align-self:end;padding-bottom:12px"><input id="b-at" type="checkbox" ${d.ativo ? 'checked' : ''}> Ativo</label></div>
   <button class="cta green" type="submit">${id ? 'Salvar banner' : 'Publicar banner'}</button>
   ${id ? '<button type="button" class="ghost red" data-a="excluirBanner">Excluir banner</button>' : ''}
  </form>
  ${id && b.tipo === 'campanha' ? `<h2 class="sec">Interessados (${b.interesses.length})</h2>${b.interesses.length ? b.interesses.map(i => `<div class="item"><div class="row"><h3>${esc((i.perfil || {}).nome)}${i.novo ? ' <span class="dot"></span>' : ''}</h3><span class="meta">${fdt(i.criado_em)}</span></div><a class="wa" href="${waLink((i.perfil || {}).fone, 'Olá, aqui é da Rede do Boi, sobre a campanha: ' + b.titulo)}" target="_blank" rel="noopener">Chamar ${esc(foneBonito((i.perfil || {}).fone))}</a></div>`).join('') : '<div class="empty">Ninguém ainda.</div>'}` : ''}
  </div>`;
};

TELAS.admVic = () => `${topo('Vicinais')}<div class="body">
  <form id="f-vic"><label for="v-nome">Lançar nova vicinal<input id="v-nome" required placeholder="Nome da vicinal"></label>
  <button class="cta green" type="submit">Adicionar à lista</button></form>
  ${E.adm.sugestoes.length ? `<h2 class="sec">Informadas pelos produtores</h2>${E.adm.sugestoes.map(v => `<div class="item"><div class="row"><h3>${esc(v.nome)}</h3><span class="pill p-novo">Para conferir</span></div><div class="meta">Digitada por ${esc(v.por_nome || '?')} no cadastro</div><div class="btns"><button class="ghost" data-ok="${v.id}">Aprovar</button><button class="ghost red" data-no="${v.id}">Descartar</button></div></div>`).join('')}` : ''}
  <h2 class="sec">Vicinais cadastradas (${E.vicinais.length})</h2>
  ${ordenarPt(E.vicinais).map(v => `<div class="item"><div class="row"><h3>${esc(v)}</h3><button class="ghost red" data-del="${esc(v)}">Remover</button></div></div>`).join('')}
  </div>`;

let buscaProd = '';
TELAS.admProdutores = () => {
  const q = norm(buscaProd);
  const ps = E.adm.perfis.filter(p => !q || norm(p.nome + ' ' + p.prop + ' ' + p.fone + ' ' + (p.vic || '') + ' ' + p.mun).includes(q));
  return `${topo('Produtores')}<div class="body">
  <label for="p-busca">Buscar<input id="p-busca" type="search" placeholder="Nome, telefone, vicinal..." value="${esc(buscaProd)}"></label>
  <p class="meta">${E.adm.perfis.length} cadastro(s). Administradores entram com senha própria.</p>
  ${ps.map(p => { const n = E.adm.lancs.filter(l => l.user_id === p.id && !l.excluido_em).length;
    return `<div class="item"><div class="row"><h3>${esc(p.nome)}</h3>${p.admin ? '<span class="pill p-fechado">Administrador</span>' : ''}</div>
    <div class="meta">${esc(p.prop)} · ${esc(p.mun)}${p.vic ? ' · ' + esc(p.vic) : ''}${p.km ? ', km ' + esc(p.km) : ''}<br>${esc(foneBonito(p.fone))}${p.email ? ' · ' + esc(p.email) : ''} · ${n} lançamento(s) · desde ${fd(p.criado_em)}</div>
    <div class="btns"><a class="ghost" href="${waLink(p.fone)}" target="_blank" rel="noopener">WhatsApp</a>${p.id === E.usuario.id ? '' : `<button class="ghost${p.admin ? ' red' : ''}" data-admin="${p.id}" data-v="${p.admin ? 0 : 1}">${p.admin ? 'Tirar acesso de administrador' : 'Tornar administrador'}</button>`}</div></div>`; }).join('')}
  </div>`;
};

let filtroRel = { de: '', ate: '', st: 'todos', tipo: 'todos', ver: 'lanc' };
// Agrupa os lançamentos por produtor ou por vicinal, com totais
function agrupar(ls, por) {
  const g = new Map();
  for (const l of ls) {
    const u = l.perfil || {};
    const chave = por === 'prod' ? (l.user_id || u.id || '?') : (u.vic || 'Sem vicinal');
    if (!g.has(chave)) g.set(chave, { chave, nome: por === 'prod' ? (u.nome || '?') : chave, perfil: u, ls: [], prods: new Set() });
    const x = g.get(chave); x.ls.push(l); x.prods.add(l.user_id);
  }
  return [...g.values()].map(x => somar(x)).sort((a, b) => b.valor - a.valor || b.lancs - a.lancs || a.nome.localeCompare(b.nome, 'pt-BR'));
}
function somar(x) {
  const ls = x.ls, f = ls.filter(l => l.status === 'fechado');
  return { ...x, lancs: ls.length, vendas: ls.filter(l => l.tipo === 'venda').length, compras: ls.filter(l => l.tipo === 'compra').length,
    cab: ls.reduce((s, l) => s + Number(l.qtd || 0), 0), andamento: ls.filter(l => l.status === 'negociacao' || l.status === 'visita').length,
    fechados: f.length, cabFech: f.reduce((s, l) => s + Number(l.qtd || 0), 0), valor: f.reduce((s, l) => s + valorFechado(l), 0),
    pedido: ls.reduce((s, l) => s + total(l), 0), nProd: x.prods ? x.prods.size : 0 };
}
function grupoHtml(ls, por) {
  const gs = agrupar(ls, por), T = somar({ ls, prods: new Set(ls.map(l => l.user_id)) });
  if (!gs.length) return '<div class="empty">Nenhum lançamento no período.</div>';
  const linhaTotais = (x, rot) => `<tr class="tot"><td>${rot}</td>${por === 'vic' ? `<td class="r">${x.nProd}</td>` : ''}<td class="r">${x.lancs}</td><td class="r">${x.vendas}</td><td class="r">${x.compras}</td><td class="r">${num(x.cab)}</td><td class="r">${brl0(x.pedido)}</td><td class="r">${x.andamento}</td><td class="r">${x.fechados}</td><td class="r">${num(x.cabFech)}</td><td class="r">${brl0(x.valor)}</td></tr>`;
  const resumo = `<h2 class="sec">Resumo ${por === 'prod' ? 'por produtor' : 'por vicinal'} (${gs.length})</h2><div class="tbl"><table><thead><tr><th>${por === 'prod' ? 'Produtor' : 'Vicinal'}</th>${por === 'vic' ? '<th class="r">Produtores</th>' : ''}<th class="r">Lançamentos</th><th class="r">Vendas</th><th class="r">Compras</th><th class="r">Cabeças</th><th class="r">Valor pedido</th><th class="r">Em andamento</th><th class="r">Fechados</th><th class="r">Cabeças fechadas</th><th class="r">Valor fechado</th></tr></thead><tbody>
    ${gs.map(x => linhaTotais(x, `<button type="button" class="lnk" data-grupo="g-${esc(String(x.chave)).replace(/[^\w-]/g, '_')}">${esc(x.nome)}</button>`).replace('class="tot"', '')).join('')}${linhaTotais(T, '<b>Total geral</b>')}</tbody></table></div>`;
  const detalhes = gs.map(x => { const u = x.perfil || {};
    return `<div class="item grupo" id="g-${esc(String(x.chave)).replace(/[^\w-]/g, '_')}"><div class="row"><h3>${esc(x.nome)}</h3><span class="price">${brl0(x.valor)}</span></div>
    <div class="meta">${por === 'prod' ? `${esc(u.prop || '')}${u.vic ? ' · ' + esc(u.vic) : ''}${u.km ? ', km ' + esc(u.km) : ''} · ${esc(foneBonito(u.fone))}` : `${x.nProd} produtor(es)`}</div>
    <div class="meta"><b>${x.lancs}</b> lançamento(s): ${x.vendas} venda(s), ${x.compras} compra(s) · <b>${num(x.cab)}</b> cabeças · ${x.fechados} fechado(s) (${num(x.cabFech)} cab.) · ${x.andamento} em andamento</div>
    <div class="tbl"><table><thead><tr><th>Data</th>${por === 'vic' ? '<th>Produtor</th>' : ''}<th>Tipo</th><th>Lote</th><th class="r">Pedido/@</th><th class="r">Fechado/@</th><th class="r">Valor fechado</th><th>Status</th></tr></thead><tbody>
    ${x.ls.map(l => `<tr data-abrir="${l.id}"><td>${fd(l.criado_em)}</td>${por === 'vic' ? `<td>${esc((l.perfil || {}).nome)}</td>` : ''}<td>${l.tipo === 'venda' ? 'Venda' : 'Compra'}</td><td>${lancTitulo(l)}, ${pesoTxt(l)}</td><td class="r">${brl(l.valor)}</td><td class="r">${l.valor_fechado ? brl(l.valor_fechado) : '–'}</td><td class="r">${l.status === 'fechado' ? brl0(valorFechado(l)) : '–'}</td><td>${ST[l.status]}${l.excluido_em ? ' (excluído)' : ''}</td></tr>`).join('')}
    <tr class="tot"><td colspan="${por === 'vic' ? 6 : 5}">Total</td><td class="r">${brl0(x.valor)}</td><td></td></tr></tbody></table></div></div>`; }).join('');
  return resumo + `<h2 class="sec">Lançamentos de cada ${por === 'prod' ? 'produtor' : 'vicinal'}</h2>` + detalhes;
}
function linhasRelatorio() {
  return E.adm.lancs.filter(l => {
    const d = String(l.criado_em).slice(0, 10);
    return (!filtroRel.de || d >= filtroRel.de) && (!filtroRel.ate || d <= filtroRel.ate) &&
      (filtroRel.st === 'todos' || l.status === filtroRel.st) && (filtroRel.tipo === 'todos' || l.tipo === filtroRel.tipo);
  }).sort((a, b) => String(b.criado_em).localeCompare(String(a.criado_em)));
}
const valorFechado = l => l.status === 'fechado' ? l.qtd * arroba(l) * (l.valor_fechado || l.valor) : 0;
TELAS.relatorio = () => {
  const ls = linhasRelatorio(), cnt = k => ls.filter(l => l.status === k).length;
  const fech = ls.filter(l => l.status === 'fechado'), vol = fech.reduce((s, l) => s + valorFechado(l), 0), cab = fech.reduce((s, l) => s + Number(l.qtd), 0);
  return `${topo('Relatório de negociações')}<div class="body">
  <form id="f-rel" class="filtros"><label for="r-de">De<input id="r-de" type="date" value="${filtroRel.de}"></label><label for="r-ate">Até<input id="r-ate" type="date" value="${filtroRel.ate}"></label>
  <label for="r-st">Status<select id="r-st"><option value="todos">Todos</option>${Object.entries(ST).map(([k, v]) => `<option value="${k}" ${filtroRel.st === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
  <label for="r-tipo">Tipo<select id="r-tipo"><option value="todos">Compra e venda</option><option value="venda" ${filtroRel.tipo === 'venda' ? 'selected' : ''}>Venda</option><option value="compra" ${filtroRel.tipo === 'compra' ? 'selected' : ''}>Compra</option></select></label></form>
  <div class="stats"><div class="stat"><div class="v">${ls.length}</div><div class="k">Lançamentos recebidos</div></div><div class="stat"><div class="v">${cnt('fechado')}</div><div class="k">Negócios fechados</div></div>
  <div class="stat"><div class="v">${cnt('negociacao') + cnt('visita')}</div><div class="k">Em andamento</div></div><div class="stat"><div class="v">${num(cab)}</div><div class="k">Cabeças negociadas</div></div></div>
  <div class="total"><span>Valor dos negócios fechados</span><b class="price">${brl0(vol)}</b></div>
  <div class="chips" role="group" aria-label="Agrupar">${[['lanc', 'Todos os lançamentos'], ['prod', 'Por produtor'], ['vic', 'Por vicinal']].map(([k, v]) => `<button class="chip" data-ver="${k}" aria-pressed="${filtroRel.ver === k}">${v}</button>`).join('')}</div>
  <div class="btns"><button class="ghost" data-a="baixarPlanilha">Baixar planilha (Excel)</button><button class="ghost" data-a="imprimir">Imprimir ou salvar PDF</button></div>
  ${filtroRel.ver !== 'lanc' ? grupoHtml(ls, filtroRel.ver) + '</div>' : ''}${filtroRel.ver !== 'lanc' ? '' : `<div class="tbl"><table><thead><tr><th>Data</th><th>Produtor</th><th>Vicinal</th><th>Tipo</th><th>Lote</th><th class="r">Pedido/@</th><th class="r">Última oferta</th><th class="r">Fechado/@</th><th class="r">Valor fechado</th><th>Status</th><th>Responsável</th><th class="r">Msgs</th></tr></thead><tbody>
  ${ls.map(l => `<tr data-abrir="${l.id}"><td>${fd(l.criado_em)}</td><td>${esc((l.perfil || {}).nome)}</td><td>${esc((l.perfil || {}).vic || '')}</td><td>${l.tipo === 'venda' ? 'Venda' : 'Compra'}</td><td>${lancTitulo(l)}, ${pesoTxt(l)}</td><td class="r">${brl(l.valor)}</td><td class="r">${ultimaOferta(l) ? brl(ultimaOferta(l)) : '–'}</td><td class="r">${l.valor_fechado ? brl(l.valor_fechado) : '–'}</td><td class="r">${l.status === 'fechado' ? brl0(valorFechado(l)) : '–'}</td><td>${ST[l.status]}${l.excluido_em ? ' (excluído)' : ''}</td><td>${esc(responsavel(l))}</td><td class="r">${(l.mensagens || []).filter(h => h.papel !== 'sys').length}</td></tr>`).join('') || '<tr><td colspan="12">Nenhum lançamento no período.</td></tr>'}
  </tbody></table></div></div>`}`;
};
function baixarPlanilha() {
  const ls = linhasRelatorio();
  const cab = ['Data', 'Produtor', 'Telefone', 'Propriedade', 'Município', 'Vicinal', 'Km', 'Tipo', 'Animal', 'Quantidade', 'Peso médio', 'Unidade', 'Peso em @', 'Pedido R$/@', 'Total pedido R$', 'Última oferta R$/@', 'Fechado R$/@', 'Valor fechado R$', 'Status', 'Responsável', 'Mensagens', 'Excluído pelo produtor'];
  const n = v => v == null || v === '' ? '' : String(Math.round(Number(v) * 100) / 100).replace('.', ',');
  const linhaDe = l => { const u = l.perfil || {};
    return [fd(l.criado_em), u.nome, foneBonito(u.fone), u.prop, u.mun, u.vic, u.km, l.tipo === 'venda' ? 'Venda' : 'Compra', CAT[l.cat], l.qtd, n(l.peso), l.un, n(arroba(l)), n(l.valor), n(total(l)), n(ultimaOferta(l)), n(l.valor_fechado), l.status === 'fechado' ? n(valorFechado(l)) : '', ST[l.status], responsavel(l), (l.mensagens || []).filter(h => h.papel !== 'sys').length, l.excluido_em ? 'Sim' : '']; };
  let linhas;
  if (filtroRel.ver === 'lanc') linhas = ls.map(linhaDe);
  else {
    // agrupado: lançamentos de cada produtor (ou vicinal) e uma linha de total depois de cada grupo
    const totalLinha = (rot, x) => { const r = new Array(cab.length).fill(''); r[0] = rot; r[9] = x.cab; r[14] = n(x.pedido); r[17] = n(x.valor); r[18] = `${x.lancs} lançamento(s), ${x.fechados} fechado(s)`; return r; };
    linhas = [];
    for (const x of agrupar(ls, filtroRel.ver)) { x.ls.forEach(l => linhas.push(linhaDe(l))); linhas.push(totalLinha(`TOTAL ${filtroRel.ver === 'prod' ? 'PRODUTOR' : 'VICINAL'}: ${x.nome}`, x)); linhas.push(new Array(cab.length).fill('')); }
    linhas.push(totalLinha('TOTAL GERAL', somar({ ls, prods: new Set(ls.map(l => l.user_id)) })));
  }
  const csv = '﻿' + [cab, ...linhas].map(r => r.map(c => { c = String(c ?? ''); return /[;"\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c; }).join(';')).join('\r\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `rede-do-boi-negociacoes${filtroRel.ver === 'prod' ? '-por-produtor' : filtroRel.ver === 'vic' ? '-por-vicinal' : ''}-${new Date().toISOString().slice(0, 10)}.csv`; document.body.appendChild(a); a.click(); a.remove();
}

// =====================================================================
// REVENDA DE LOTES (administrador separa lotes e vende para compradores cadastrados)
// =====================================================================
const LST = { disponivel: 'À venda', reservado: 'Reservado', vendido: 'Vendido', no_pasto: 'Vendido, no pasto', entregue: 'Entregue', cancelado: 'Cancelado' };
const VENDIDOS = ['vendido', 'no_pasto', 'entregue'];
const seloLote = (l, meu) => `<span class="pill pl-${l.status}">${meu && l.status === 'reservado' ? 'Reservado para você' : LST[l.status] || l.status}</span>`;
const umSo = x => (Array.isArray(x) ? x[0] : x) || null;
const finDe = l => umSo(l.fin) || {};
const nv = v => v == null || v === '' || isNaN(Number(String(v).replace(',', '.'))) ? null : Number(String(v).replace(',', '.'));
function contas(l) {
  const f = finDe(l), pago = nv(f.valor_pago), desp = nv(f.despesas), vend = nv(f.valor_vendido);
  return { pago, desp, vend, lucro: vend == null ? null : vend - (pago || 0) - (desp || 0) };
}
const msgsLote = l => [...(l.lote_mensagens || [])].sort((a, b) => String(a.criado_em).localeCompare(String(b.criado_em)));
const compradorDe = id => E.adm.compradores.find(c => c.id === id);
const linkComprador = () => new URL('comprador.html', location.href).href;
const lotesNovosAdm = () => E.adm.lotes.filter(l => (l.lote_mensagens || []).some(m => m.adm_novo));
const lotesNovosComp = () => E.lotesComp.filter(l => (l.lote_mensagens || []).some(m => m.comp_novo));
const meuLote = l => !!(E.comprador && E.comprador.id && l.comprador_id === E.comprador.id);
const lucroHtml = v => v == null ? '–' : `<span class="${v < 0 ? 'neg' : 'pos'}">${brl0(v)}</span>`;

function conversaLote(ms, lado) {
  return `<div class="chat">${ms.map(h => {
    if (h.papel === 'sys') return `<div class="msg sys">${esc(h.texto)} · ${fdt(h.criado_em)}</div>`;
    const meu = (lado === 'comp' && h.papel === 'comp') || (lado === 'adm' && h.papel === 'adm');
    const quem = h.papel === 'adm' ? (lado === 'comp' ? 'Rede do Boi' : (h.autor_nome || 'Administrador') + ' · Rede do Boi') : (h.autor_nome || 'Comprador');
    return `<div class="msg ${meu ? 'me' : 'them'}">${h.quer_comprar ? '<div class="offer"><b>✔ Quero comprar este lote</b></div>' : ''}${esc(h.texto)}<span class="w">${esc(quem)} · ${fdt(h.criado_em)}</span></div>`;
  }).join('')}</div>`;
}
function capaLote(l) {
  const ms = l.midias || [], m = ms.find(x => x.kind !== 'video') || ms[0];
  if (!m) return '';
  return m.kind === 'video' ? `<span class="lc-img"><video src="${esc(urlMidia(m))}#t=0.1" muted preload="metadata"></video><span class="play">▶</span></span>`
    : `<span class="lc-img"><img src="${esc(urlMidia(m))}" alt="" loading="lazy"></span>`;
}
function cartaoLote(l, lado) {
  const novo = (l.lote_mensagens || []).some(m => lado === 'comp' ? m.comp_novo : m.adm_novo);
  const c = lado === 'adm' ? contas(l) : null, comp = lado === 'adm' ? umSo(l.comprador) : null;
  const pedidos = lado === 'adm' ? new Set((l.lote_mensagens || []).filter(m => m.papel === 'comp').map(m => m.comprador_id)).size : 0;
  return `<button class="item lote-c" data-${lado === 'comp' ? 'cl' : 'rl'}="${l.id}">${capaLote(l)}
   <div class="row"><span>${seloLote(l, lado === 'comp' && meuLote(l))}${lado === 'adm' && !l.visivel ? ' <span class="pill p-cancelado">Escondido</span>' : ''}</span>${novo ? '<span class="dot" title="Mensagem nova"></span>' : ''}</div>
   <h3>${lancTitulo(l)}</h3><div class="meta">Peso médio ${pesoTxt(l)}</div>
   <div class="row"><span class="meta">${brl(l.valor)} por @</span><span class="price">${brl0(total(l))}</span></div>
   ${lado === 'adm' ? `<div class="meta">${comp ? 'Comprador: <b>' + esc(comp.nome) + '</b>' : pedidos ? pedidos + ' comprador(es) conversando' : 'Sem comprador ainda'}${c.lucro != null ? ' · Lucro: <b>' + lucroHtml(c.lucro) + '</b>' : ''}</div>` : ''}</button>`;
}

// ---------- comprador ----------
TELAS.naoComprador = () => {
  if (!E.carregado) return `<div class="login"><img src="${ICON}" alt="Rede do Boi"><p class="slogan">Carregando os lotes...</p></div>`;
  return `<div class="login"><img src="${ICON}" alt="Rede do Boi"><h2 class="sec" style="text-align:center">Área do comprador</h2>
  <p class="meta" style="text-align:center;font-size:14px">O telefone <b>${esc(foneBonito(E.usuario.fone))}</b> ainda não está liberado para ver os lotes.<br>Fale com a Rede do Boi para fazer o seu cadastro de comprador.</p>
  ${WA ? `<a class="wa" href="${waLink(WA, 'Olá, quero me cadastrar como comprador de gado na Rede do Boi. Meu telefone: ' + foneBonito(E.usuario.fone))}" target="_blank" rel="noopener">Pedir cadastro pelo WhatsApp</a>` : ''}
  <button class="ghost" data-a="tentarDeNovo" style="width:100%">Já fui cadastrado, tentar de novo</button>
  <button class="ghost" data-a="sair" style="width:100%">Usar outro telefone</button></div>`;
};

let abaComp = 'venda';
TELAS.compLotes = () => {
  const c = E.comprador, meus = E.lotesComp.filter(meuLote), venda = E.lotesComp.filter(l => !meuLote(l) && ['disponivel', 'reservado'].includes(l.status));
  const ls = abaComp === 'meus' ? meus : venda;
  return `<header class="bar"><img src="${ICON}" alt="" style="width:34px;height:34px;border-radius:9px"><h1>Lotes à venda</h1><span class="who">${esc((c.nome || '').split(' ')[0])}</span>${botaoSino()}</header><div class="body">
  ${c.previa ? '<p class="note"><b>Prévia do administrador:</b> é assim que os compradores cadastrados veem os lotes. Para comprar ou perguntar, entre com o telefone de um comprador.</p>' : ''}
  <div class="chips"><button class="chip" data-aba="venda" aria-pressed="${abaComp === 'venda'}">À venda <small>${venda.length}</small></button><button class="chip" data-aba="meus" aria-pressed="${abaComp === 'meus'}">Minhas compras <small>${meus.length}</small></button></div>
  ${!E.carregado && !E.lotesComp.length ? '<div class="empty">Carregando...</div>' : ls.length ? ls.map(l => cartaoLote(l, 'comp')).join('')
    : `<div class="empty">${abaComp === 'meus' ? 'Você ainda não confirmou a compra de nenhum lote.' : 'Nenhum lote à venda agora. Volte em breve: os novos lotes aparecem aqui.'}</div>`}
  ${WA ? `<a class="wa" href="${waLink(WA, `Olá, sou ${c.nome}, comprador cadastrado na Rede do Boi.`)}" target="_blank" rel="noopener">Falar com a Rede do Boi no WhatsApp</a>` : ''}
  <button class="ghost" data-a="sair" style="width:100%">Sair</button></div>`;
};

TELAS.compLote = id => {
  const l = E.lotesComp.find(x => x.id === id);
  if (!l) return topo('Lote') + '<div class="empty">Este lote não está mais disponível.</div>';
  const c = E.comprador, meu = meuLote(l), ms = msgsLote(l);
  return `${topo(lancTitulo(l))}<div class="body">
  <div class="row"><span>${seloLote(l, meu)}</span><span class="meta">Lote de ${fd(l.criado_em)}</span></div>
  ${galeria(l, true)}
  <dl class="kv"><dt>Animais</dt><dd>${num(l.qtd)} × ${CAT[l.cat] || l.cat}</dd><dt>Peso médio</dt><dd>${pesoTxt(l)}</dd><dt>Valor da @</dt><dd>${brl(l.valor)}</dd><dt>Total do lote</dt><dd>${brl0(total(l))}</dd></dl>
  ${l.descr ? `<h2 class="sec">Sobre o lote</h2><p class="descr">${esc(l.descr).replace(/\n/g, '<br>')}</p>` : ''}
  ${l.status === 'disponivel' ? '<button class="cta green" data-a="queroLote">Quero comprar este lote</button>'
    : meu && l.status === 'reservado' ? '<p class="note"><b>Lote reservado para você.</b> A Rede do Boi vai entrar em contato para combinar o pagamento e a retirada.</p>'
    : meu ? `<p class="note">Situação da sua compra: <b>${LST[l.status]}</b>.</p>`
    : '<p class="note">Este lote está reservado para outro comprador. Se o negócio não fechar, ele volta a ficar à venda. Você pode deixar uma pergunta.</p>'}
  <h2 class="sec">Perguntas sobre o lote</h2>
  ${ms.length ? conversaLote(ms, 'comp') : '<p class="meta" style="margin:0">Tem alguma dúvida? Pergunte aqui. A Rede do Boi responde pelo app.</p>'}
  <form id="f-cperg" class="reply"><textarea id="cp-txt" rows="2" placeholder="Escreva sua pergunta" aria-label="Pergunta sobre o lote"></textarea><button class="cta green" style="width:auto" type="submit">Enviar</button></form>
  ${WA ? `<a class="wa" href="${waLink(WA, `Olá, sou ${c.nome}, comprador cadastrado. Tenho interesse no lote de ${lancTitulo(l)} (peso médio ${pesoTxt(l)}, ${brl(l.valor)}/@).`)}" target="_blank" rel="noopener">Falar no WhatsApp da Rede do Boi</a>` : ''}
  </div>`;
};

// ---------- administrador: lotes para revenda ----------
let filtroRev = 'todos';
TELAS.admRevenda = () => {
  const todos = E.adm.lotes, cnt = f => todos.filter(f).length;
  const ls = todos.filter(l => filtroRev === 'todos' ? l.status !== 'cancelado' : filtroRev === 'vendidos' ? VENDIDOS.includes(l.status) : l.status === filtroRev)
    .sort((a, b) => (lotesNovosAdm().includes(b) - lotesNovosAdm().includes(a)) || String(b.criado_em).localeCompare(String(a.criado_em)));
  const lucro = todos.filter(l => VENDIDOS.includes(l.status)).reduce((s, l) => s + (contas(l).lucro || 0), 0);
  const fs = [['todos', 'Todos', cnt(l => l.status !== 'cancelado')], ['disponivel', 'À venda', cnt(l => l.status === 'disponivel')], ['reservado', 'Reservados', cnt(l => l.status === 'reservado')],
    ['vendidos', 'Vendidos', cnt(l => VENDIDOS.includes(l.status))], ['no_pasto', 'No pasto', cnt(l => l.status === 'no_pasto')], ['entregue', 'Entregues', cnt(l => l.status === 'entregue')], ['cancelado', 'Cancelados', cnt(l => l.status === 'cancelado')]];
  return `${topo('Lotes para revenda', true)}<div class="body">
  <div class="stats"><div class="stat"><div class="v">${cnt(l => l.status === 'disponivel')}</div><div class="k">À venda</div></div><div class="stat"><div class="v">${cnt(l => l.status === 'reservado')}</div><div class="k">Reservados</div></div>
  <div class="stat"><div class="v">${cnt(l => VENDIDOS.includes(l.status))}</div><div class="k">Vendidos</div></div><div class="stat"><div class="v">${brl0(lucro)}</div><div class="k">Lucro dos vendidos</div></div></div>
  <button class="cta green" data-a="novoLoteRev">+ Novo lote para venda</button>
  <div class="chips">${fs.map(([k, v, n]) => `<button class="chip" data-fr="${k}" aria-pressed="${filtroRev === k}">${v} <small>${n}</small></button>`).join('')}</div>
  ${ls.length ? ls.map(l => cartaoLote(l, 'adm')).join('') : '<div class="empty">Nenhum lote neste filtro.</div>'}
  <div class="admbtns">
  <button class="cta" data-a="relRevenda">Relatório da revenda</button>
  <button class="ghost" data-a="admCompradores">Compradores cadastrados (${E.adm.compradores.length})</button>
  <button class="ghost" data-a="copiarLink">Copiar o link dos compradores</button>
  <a class="ghost" href="${esc(linkComprador())}" target="_blank" rel="noopener" style="text-align:center">Ver como o comprador vê</a></div></div>`;
};

TELAS.admRevLote = id => {
  const l = E.adm.lotes.find(x => x.id === id);
  if (!l) return topo('Lote') + '<div class="empty">Lote não encontrado.</div>';
  const c = contas(l), comp = umSo(l.comprador) || compradorDe(l.comprador_id), ms = msgsLote(l);
  const porComp = new Map(); ms.forEach(m => { if (!porComp.has(m.comprador_id)) porComp.set(m.comprador_id, []); porComp.get(m.comprador_id).push(m); });
  const ultimo = [...ms].reverse().find(m => m.papel === 'comp'), alvo = (ultimo && ultimo.comprador_id) || l.comprador_id || '';
  const origem = l.origem_lanc && E.adm.lancs.find(x => x.id === l.origem_lanc);
  return `${topo(lancTitulo(l))}<div class="body">
  <div class="row"><span>${seloLote(l)}${l.visivel ? '' : ' <span class="pill p-cancelado">Escondido dos compradores</span>'}</span><button class="ghost" data-a="editarLoteRev">Editar lote</button></div>
  ${galeria(l, true)}
  <dl class="kv"><dt>Animais</dt><dd>${num(l.qtd)} × ${CAT[l.cat] || l.cat}</dd><dt>Peso médio</dt><dd>${pesoTxt(l)}</dd><dt>Preço pedido</dt><dd>${brl(l.valor)}/@</dd><dt>Total pelo preço pedido</dt><dd>${brl0(total(l))}</dd>
   <dt>Lançado em</dt><dd>${fd(l.criado_em)}</dd>${l.vendido_em ? `<dt>Vendido em</dt><dd>${fd(l.vendido_em)}</dd>` : ''}</dl>
  ${l.descr ? `<p class="descr">${esc(l.descr).replace(/\n/g, '<br>')}</p>` : ''}
  ${origem ? `<p class="meta" style="margin:0">Gado comprado de <button class="lnk" data-abrir="${origem.id}">${esc((origem.perfil || {}).nome || 'produtor')}</button> em ${fd(origem.criado_em)}.</p>` : ''}
  <h2 class="sec">Valores da negociação <span class="opt">(só administradores veem)</span></h2>
  <dl class="kv fin"><dt>Valor pago pelo gado</dt><dd>${c.pago == null ? '–' : brl0(c.pago)}</dd><dt>Despesas</dt><dd>${c.desp == null ? '–' : brl0(c.desp)}</dd><dt>Valor vendido</dt><dd>${c.vend == null ? '–' : brl0(c.vend)}</dd></dl>
  <div class="total"><span>Lucro da negociação${c.vend == null ? '<br><span class="meta">Informe o valor vendido em Editar lote</span>' : ''}</span><b class="price">${lucroHtml(c.lucro)}</b></div>
  <h2 class="sec">Situação</h2>
  <form id="f-rst" class="two"><label for="rs-st">Status<select id="rs-st">${Object.entries(LST).map(([k, v]) => `<option value="${k}" ${l.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
   <label for="rs-comp">Comprador<select id="rs-comp"><option value="">Nenhum</option>${E.adm.compradores.map(x => `<option value="${x.id}" ${l.comprador_id === x.id ? 'selected' : ''}>${esc(x.nome)}</option>`).join('')}</select></label>
   <label for="rs-vend" style="grid-column:1/-1">Valor vendido (R$, total recebido do comprador)<input id="rs-vend" type="number" inputmode="decimal" min="0" step="0.01" value="${esc(c.vend ?? '')}" placeholder="Pelo preço pedido: ${Math.round(total(l))}"></label>
   <button class="ghost" type="submit" style="grid-column:1/-1">Salvar situação</button></form>
  ${comp ? `<div class="item"><h3>${esc(comp.nome)}</h3><div class="meta">${esc([comp.cidade, foneBonito(comp.fone)].filter(Boolean).join(' · '))}</div>
   <a class="wa" href="${waLink(comp.fone, `Olá ${(comp.nome || '').split(' ')[0]}, aqui é da Rede do Boi, sobre o lote de ${lancTitulo(l)}.`)}" target="_blank" rel="noopener">Chamar comprador no WhatsApp</a></div>` : ''}
  <h2 class="sec">Perguntas e pedidos dos compradores</h2>
  ${porComp.size ? [...porComp].map(([cid, m]) => { const x = compradorDe(cid) || {}; return `<div class="item"><div class="row"><h3>${esc(x.nome || m[0].autor_nome || 'Comprador')}</h3>${m.some(y => y.quer_comprar) ? '<span class="pill pl-reservado">Quer comprar</span>' : ''}</div>${conversaLote(m, 'adm')}</div>`; }).join('')
    : '<div class="empty">Nenhum comprador perguntou ainda.</div>'}
  ${E.adm.compradores.length ? `<form id="f-rresp"><label for="rr-comp">Mandar mensagem para<select id="rr-comp">${E.adm.compradores.map(x => `<option value="${x.id}" ${alvo === x.id ? 'selected' : ''}>${esc(x.nome)}</option>`).join('')}</select></label>
   <label for="rr-txt">Mensagem<textarea id="rr-txt" rows="3" placeholder="Escreva para o comprador"></textarea></label>
   <button class="cta green" type="submit">Enviar ao comprador</button></form>` : '<p class="note">Cadastre compradores para eles verem este lote.</p>'}
  </div>`;
};

TELAS.admRevForm = id => {
  const d = rascunho; if (!d) return topo('Lote') + '<div class="empty">Nada para editar.</div>';
  const f = d.fin, sug = total({ qtd: d.qtd, peso: d.peso, un: d.un, valor: d.valor });
  return `${topo(id ? 'Editar lote' : 'Novo lote para venda')}<div class="body"><form id="f-rev" novalidate>
  <h2 class="sec">Tipo de animal</h2>
  <div class="cats">${CATS.map(([k, v]) => `<button type="button" data-rcat="${k}" aria-pressed="${d.cat === k}">${v}</button>`).join('')}</div>
  <div class="two"><label for="rv-qtd">Quantidade (cabeças)<input id="rv-qtd" type="number" inputmode="numeric" min="1" step="1" required value="${esc(d.qtd ?? '')}"></label>
  <label for="rv-peso">Peso médio<span style="display:flex;gap:6px;min-width:0"><input style="flex:1" id="rv-peso" type="number" inputmode="decimal" min="0.5" step="0.1" required value="${esc(d.peso ?? '')}"><select id="rv-un" aria-label="Unidade" style="width:66px;flex:none;padding:10px 4px">${['@', 'kg'].map(u => `<option ${(d.un || '@') === u ? 'selected' : ''}>${u}</option>`).join('')}</select></span></label></div>
  <label for="rv-valor">Valor da @ para venda (R$)<input id="rv-valor" type="number" inputmode="decimal" min="0" step="0.01" required value="${esc(d.valor ?? '')}"></label>
  <div class="total"><span>Total do lote<br><span class="meta" id="rv-conv">${d.peso ? pesoTxt({ peso: d.peso, un: d.un || '@' }) + ' por cabeça' : '1 @ = 30 kg (peso vivo)'}</span></span><b class="price" id="rv-total">${brl0(sug)}</b></div>
  <label for="rv-desc">Descrição do lote<textarea id="rv-desc" rows="4" placeholder="Ex.: Nelore, 30 meses, vacinados, prontos para abate. Retirada na fazenda, km 40 da vicinal.">${esc(d.descr)}</textarea></label>
  <label>Fotos e vídeos do lote</label>
  <div class="media">${d.midias.map((m, i) => `<div class="m">${m.kind === 'video' ? `<video src="${esc(urlMidia(m))}#t=0.1" muted preload="metadata"></video><span class="play">▶</span>` : `<img src="${esc(urlMidia(m))}" alt="Foto ${i + 1}">`}<button type="button" class="x" data-rrm="${i}" aria-label="Remover">×</button></div>`).join('')}
   <label class="addm" for="rv-cam">📷<br>Tirar foto<input id="rv-cam" type="file" accept="image/*" capture="environment"></label>
   <label class="addm" for="rv-vid">🎥<br>Gravar vídeo<input id="rv-vid" type="file" accept="video/*" capture="environment"></label>
   <label class="addm" for="rv-file">＋<br>Da galeria<input id="rv-file" type="file" accept="image/*,video/*" multiple></label></div>
  <label class="sw" for="rv-vis" style="flex-direction:row"><input id="rv-vis" type="checkbox" ${d.visivel ? 'checked' : ''}> Mostrar este lote para os compradores</label>
  <h2 class="sec">Situação</h2>
  <div class="two"><label for="rv-st">Status<select id="rv-st">${Object.entries(LST).map(([k, v]) => `<option value="${k}" ${d.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
  <label for="rv-comp">Comprador<select id="rv-comp"><option value="">Nenhum</option>${E.adm.compradores.map(x => `<option value="${x.id}" ${d.comprador_id === x.id ? 'selected' : ''}>${esc(x.nome)}</option>`).join('')}</select></label></div>
  <h2 class="sec">Valores da negociação <span class="opt">(só administradores veem)</span></h2>
  <label for="rv-pago">Valor pago pelo gado (R$, total do lote)<input id="rv-pago" type="number" inputmode="decimal" min="0" step="0.01" value="${esc(f.valor_pago ?? '')}"></label>
  <label for="rv-desp">Despesas (frete, pasto, vacina...) R$ <span class="opt">(opcional)</span><input id="rv-desp" type="number" inputmode="decimal" min="0" step="0.01" value="${esc(f.despesas ?? '')}"></label>
  <label for="rv-vend">Valor vendido (R$, total recebido do comprador)<input id="rv-vend" type="number" inputmode="decimal" min="0" step="0.01" value="${esc(f.valor_vendido ?? '')}"></label>
  <button type="button" class="lnk" id="rv-calc">Usar o total pelo valor da @: <span id="rv-sug">${brl0(sug)}</span></button>
  <div class="total"><span>Lucro</span><b class="price" id="rv-lucro">${lucroHtml(contas({ fin: f }).lucro)}</b></div>
  <label for="rv-obs">Anotações <span class="opt">(só administradores veem)</span><textarea id="rv-obs" rows="2" placeholder="Ex.: pagamento em 2 vezes, retirada dia 10">${esc(f.obs)}</textarea></label>
  <button class="cta green" type="submit">${id ? 'Salvar lote' : 'Publicar lote'}</button>
  ${id ? '<button type="button" class="ghost red" data-a="excluirLoteRev">Excluir lote</button>' : ''}
  </form></div>`;
};

// ---------- administrador: compradores ----------
let buscaComp = '';
TELAS.admCompradores = () => {
  const q = norm(buscaComp), cs = E.adm.compradores.filter(c => !q || norm([c.nome, c.fone, c.cidade, c.documento].join(' ')).includes(q));
  return `${topo('Compradores')}<div class="body">
  <p class="note">Só os compradores cadastrados aqui conseguem ver os lotes. Eles entram pelo link dos compradores, digitando o próprio telefone.</p>
  <div class="item"><h3>Link dos compradores</h3><div class="meta" style="word-break:break-all">${esc(linkComprador())}</div><div class="btns"><button class="ghost" data-a="copiarLink">Copiar link</button></div></div>
  <button class="cta green" data-a="novoComprador">+ Cadastrar comprador</button>
  ${E.adm.compradores.length > 5 ? `<label for="cb-busca">Buscar<input id="cb-busca" type="search" placeholder="Nome, telefone, cidade..." value="${esc(buscaComp)}"></label>` : ''}
  ${cs.map(c => { const n = E.adm.lotes.filter(l => l.comprador_id === c.id && VENDIDOS.includes(l.status)).length;
    return `<div class="item"><div class="row"><h3>${esc(c.nome)}</h3>${c.ativo ? '<span class="pill p-fechado">Liberado</span>' : '<span class="pill p-cancelado">Bloqueado</span>'}</div>
    <div class="meta">${esc(foneBonito(c.fone))}${c.cidade ? ' · ' + esc(c.cidade) : ''}${c.documento ? ' · ' + esc(c.documento) : ''} · ${n} lote(s) comprado(s)</div>${c.obs ? `<div class="meta">${esc(c.obs)}</div>` : ''}
    <div class="btns"><button class="ghost" data-ec="${c.id}">Editar</button><a class="ghost" href="${waLink(c.fone, `Olá ${(c.nome || '').split(' ')[0]}, aqui é da Rede do Boi. Veja os lotes de gado à venda neste link: ${linkComprador()} (entre com este número de telefone).`)}" target="_blank" rel="noopener">Enviar link pelo WhatsApp</a></div></div>`; }).join('') || '<div class="empty">Nenhum comprador cadastrado ainda.</div>'}
  </div>`;
};
TELAS.admComprador = id => {
  const d = rascunho;
  return `${topo(id ? 'Editar comprador' : 'Novo comprador')}<div class="body"><form id="f-comp">
  <label for="cb-nome">Nome do comprador ou empresa<input id="cb-nome" required maxlength="80" value="${esc(d.nome)}" placeholder="Ex.: Frigorífico São José"></label>
  <label for="cb-fone">Telefone / WhatsApp com DDD<input id="cb-fone" type="tel" inputmode="tel" required value="${esc(d.fone ? foneBonito(d.fone) : '')}" placeholder="(69) 99999-9999"></label>
  <p class="meta" style="margin:0">É com este telefone que o comprador entra no link para ver os lotes.</p>
  <div class="two"><label for="cb-cid">Cidade <span class="opt">(opcional)</span><input id="cb-cid" value="${esc(d.cidade)}"></label>
  <label for="cb-doc">CPF ou CNPJ <span class="opt">(opcional)</span><input id="cb-doc" value="${esc(d.documento)}"></label></div>
  <label for="cb-obs">Anotações <span class="opt">(opcional)</span><textarea id="cb-obs" rows="2" placeholder="Ex.: compra boi gordo, paga à vista">${esc(d.obs)}</textarea></label>
  <label class="sw" for="cb-at" style="flex-direction:row"><input id="cb-at" type="checkbox" ${d.ativo ? 'checked' : ''}> Liberado para ver os lotes</label>
  <button class="cta green" type="submit">${id ? 'Salvar comprador' : 'Cadastrar comprador'}</button>
  ${id ? '<button type="button" class="ghost red" data-a="excluirComprador">Excluir comprador</button>' : ''}</form></div>`;
};

// ---------- relatório da revenda ----------
let filtroRelRev = { de: '', ate: '', st: 'todos', ver: 'lote' };
const dataLote = l => String(l.vendido_em || l.criado_em).slice(0, 10);
function linhasRevenda() {
  const f = filtroRelRev;
  return E.adm.lotes.filter(l => { const d = dataLote(l);
    return (!f.de || d >= f.de) && (!f.ate || d <= f.ate) && (f.st === 'todos' || (f.st === 'vendidos' ? VENDIDOS.includes(l.status) : l.status === f.st)); })
    .sort((a, b) => dataLote(b).localeCompare(dataLote(a)));
}
function somarRev(ls) {
  const t = { lotes: ls.length, cab: 0, vendidos: 0, cabVend: 0, pago: 0, desp: 0, vend: 0, lucro: 0 };
  for (const l of ls) { const c = contas(l); if (c.vend != null) t.temVend = true; t.cab += Number(l.qtd) || 0; t.pago += c.pago || 0; t.desp += c.desp || 0; t.vend += c.vend || 0; t.lucro += c.lucro || 0;
    if (VENDIDOS.includes(l.status)) { t.vendidos++; t.cabVend += Number(l.qtd) || 0; } }
  return t;
}
const nomeComp = l => (umSo(l.comprador) || compradorDe(l.comprador_id) || {}).nome || '';
TELAS.relRevenda = () => {
  const ls = linhasRevenda(), T = somarRev(ls), f = filtroRelRev;
  const linha = l => { const c = contas(l); return `<tr data-rl="${l.id}"><td>${fd(dataLote(l) + 'T12:00')}</td><td>${lancTitulo(l)}, ${pesoTxt(l)}</td><td>${esc(nomeComp(l)) || '–'}</td><td>${LST[l.status]}</td><td class="r">${c.pago == null ? '–' : brl0(c.pago)}</td><td class="r">${c.desp == null ? '–' : brl0(c.desp)}</td><td class="r">${c.vend == null ? '–' : brl0(c.vend)}</td><td class="r">${lucroHtml(c.lucro)}</td></tr>`; };
  const cab = '<tr><th>Data</th><th>Lote</th><th>Comprador</th><th>Status</th><th class="r">Valor pago</th><th class="r">Despesas</th><th class="r">Valor vendido</th><th class="r">Lucro</th></tr>';
  const tot = (x, rot) => `<tr class="tot"><td colspan="4">${rot}</td><td class="r">${brl0(x.pago)}</td><td class="r">${brl0(x.desp)}</td><td class="r">${brl0(x.vend)}</td><td class="r">${lucroHtml(x.lucro)}</td></tr>`;
  let corpo;
  if (f.ver === 'comp') {
    const g = new Map(); ls.forEach(l => { const k = l.comprador_id || ''; if (!g.has(k)) g.set(k, []); g.get(k).push(l); });
    const gs = [...g].map(([k, x]) => ({ k, nome: k ? nomeComp(x[0]) || 'Comprador' : 'Sem comprador', ls: x, t: somarRev(x) })).sort((a, b) => (!a.k) - (!b.k) || b.t.vend - a.t.vend);
    corpo = `<h2 class="sec">Resumo por comprador</h2><div class="tbl"><table><thead><tr><th>Comprador</th><th class="r">Lotes</th><th class="r">Cabeças</th><th class="r">Valor pago</th><th class="r">Despesas</th><th class="r">Valor vendido</th><th class="r">Lucro</th></tr></thead><tbody>
      ${gs.map(x => `<tr><td>${esc(x.nome)}</td><td class="r">${x.t.lotes}</td><td class="r">${num(x.t.cab)}</td><td class="r">${brl0(x.t.pago)}</td><td class="r">${brl0(x.t.desp)}</td><td class="r">${brl0(x.t.vend)}</td><td class="r">${lucroHtml(x.t.lucro)}</td></tr>`).join('')}
      <tr class="tot"><td>Total geral</td><td class="r">${T.lotes}</td><td class="r">${num(T.cab)}</td><td class="r">${brl0(T.pago)}</td><td class="r">${brl0(T.desp)}</td><td class="r">${brl0(T.vend)}</td><td class="r">${lucroHtml(T.lucro)}</td></tr></tbody></table></div>
      ${gs.map(x => `<div class="item grupo"><div class="row"><h3>${esc(x.nome)}</h3><span class="price">${brl0(x.t.vend)}</span></div><div class="tbl"><table><thead>${cab}</thead><tbody>${x.ls.map(linha).join('')}${tot(x.t, 'Total')}</tbody></table></div></div>`).join('')}`;
  } else corpo = `<div class="tbl"><table><thead>${cab}</thead><tbody>${ls.map(linha).join('') || '<tr><td colspan="8">Nenhum lote no período.</td></tr>'}${ls.length ? tot(T, 'Total geral') : ''}</tbody></table></div>`;
  return `${topo('Relatório da revenda')}<div class="body">
  <form id="f-relrev" class="filtros"><label for="rr-de">De<input id="rr-de" type="date" value="${f.de}"></label><label for="rr-ate">Até<input id="rr-ate" type="date" value="${f.ate}"></label>
  <label for="rr-st">Status<select id="rr-st"><option value="todos">Todos</option><option value="vendidos" ${f.st === 'vendidos' ? 'selected' : ''}>Vendidos (todos)</option>${Object.entries(LST).map(([k, v]) => `<option value="${k}" ${f.st === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label></form>
  <div class="stats"><div class="stat"><div class="v">${T.lotes}</div><div class="k">Lotes</div></div><div class="stat"><div class="v">${T.vendidos}</div><div class="k">Lotes vendidos</div></div>
  <div class="stat"><div class="v">${num(T.cabVend)}</div><div class="k">Cabeças vendidas</div></div><div class="stat"><div class="v">${brl0(T.vend)}</div><div class="k">Valor vendido</div></div></div>
  <dl class="kv fin"><dt>Valor pago pelo gado</dt><dd>${brl0(T.pago)}</dd><dt>Despesas</dt><dd>${brl0(T.desp)}</dd><dt>Valor vendido</dt><dd>${brl0(T.vend)}</dd></dl>
  <div class="total"><span>Lucro no período<br><span class="meta">Valor vendido − valor pago − despesas (lotes com valor vendido)</span></span><b class="price">${lucroHtml(T.lucro)}</b></div>
  <div class="chips" role="group" aria-label="Agrupar">${[['lote', 'Por lote'], ['comp', 'Por comprador']].map(([k, v]) => `<button class="chip" data-vr="${k}" aria-pressed="${f.ver === k}">${v}</button>`).join('')}</div>
  <div class="btns"><button class="ghost" data-a="planilhaRevenda">Baixar planilha (Excel)</button><button class="ghost" data-a="imprimir">Imprimir ou salvar PDF</button></div>
  ${corpo}</div>`;
};
function planilhaRevenda() {
  const ls = linhasRevenda(), n = v => v == null || v === '' ? '' : String(Math.round(Number(v) * 100) / 100).replace('.', ',');
  const cab = ['Data', 'Animal', 'Quantidade', 'Peso médio', 'Unidade', 'Preço pedido R$/@', 'Status', 'Comprador', 'Telefone do comprador', 'Valor pago R$', 'Despesas R$', 'Valor vendido R$', 'Lucro R$', 'Anotações'];
  const linhaDe = l => { const c = contas(l), cp = umSo(l.comprador) || compradorDe(l.comprador_id) || {};
    return [fd(dataLote(l) + 'T12:00'), CAT[l.cat], l.qtd, n(l.peso), l.un, n(l.valor), LST[l.status], cp.nome || '', cp.fone ? foneBonito(cp.fone) : '', n(c.pago), n(c.desp), n(c.vend), n(c.lucro), finDe(l).obs || '']; };
  const totalLinha = (rot, t) => { const r = new Array(cab.length).fill(''); r[0] = rot; r[2] = t.cab; r[9] = n(t.pago); r[10] = n(t.desp); r[11] = t.temVend ? n(t.vend) : ''; r[12] = t.temVend ? n(t.lucro) : ''; return r; };
  let linhas = [];
  if (filtroRelRev.ver === 'comp') {
    const g = new Map(); ls.forEach(l => { const k = l.comprador_id || ''; if (!g.has(k)) g.set(k, []); g.get(k).push(l); });
    for (const [k, x] of g) { x.forEach(l => linhas.push(linhaDe(l))); linhas.push(totalLinha('TOTAL COMPRADOR: ' + (k ? nomeComp(x[0]) : 'Sem comprador'), somarRev(x))); linhas.push(new Array(cab.length).fill('')); }
  } else linhas = ls.map(linhaDe);
  linhas.push(totalLinha('TOTAL GERAL', somarRev(ls)));
  const csv = '﻿' + [cab, ...linhas].map(r => r.map(c => { c = String(c ?? ''); return /[;"\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c; }).join(';')).join('\r\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `rede-do-boi-revenda${filtroRelRev.ver === 'comp' ? '-por-comprador' : ''}-${new Date().toISOString().slice(0, 10)}.csv`; document.body.appendChild(a); a.click(); a.remove();
}

// ---------- ações da revenda ----------
function abrirLoteRev(id) {
  const l = E.adm.lotes.find(x => x.id === id);
  if (l && (l.lote_mensagens || []).some(m => m.adm_novo) && navigator.onLine) { l.lote_mensagens.forEach(m => m.adm_novo = false); api.loteLidoAdmin(id).catch(() => {}); }
  ir('admRevLote', id);
}
function abrirLoteComp(id) {
  const l = E.lotesComp.find(x => x.id === id);
  if (l && (l.lote_mensagens || []).some(m => m.comp_novo) && navigator.onLine && !E.comprador.previa) { l.lote_mensagens.forEach(m => m.comp_novo = false); api.loteLido(id).catch(() => {}); }
  ir('compLote', id);
}
function novoLoteRev(base = {}) {
  rascunho = { id: novoId(), cat: null, qtd: '', peso: '', un: '@', valor: '', descr: '', midias: [], status: 'disponivel', visivel: true, comprador_id: '', origem_lanc: null, vendido_em: null,
    fin: { valor_pago: '', despesas: '', valor_vendido: '', obs: '' }, novo: true, ...base };
  ir('admRevForm', null);
}
function guardarRev() {
  const d = rascunho, v = id => F(id) ? F(id).value : undefined; if (!d || !F('rv-qtd')) return;
  Object.assign(d, { qtd: v('rv-qtd'), peso: v('rv-peso'), un: v('rv-un'), valor: v('rv-valor'), descr: v('rv-desc').trim(), visivel: F('rv-vis').checked, status: v('rv-st'), comprador_id: v('rv-comp') });
  Object.assign(d.fin, { valor_pago: v('rv-pago'), despesas: v('rv-desp'), valor_vendido: v('rv-vend'), obs: v('rv-obs').trim() });
}
async function copiarLink() {
  const link = linkComprador();
  try { await navigator.clipboard.writeText(link); aviso('Link copiado. Envie para os compradores cadastrados.'); }
  catch (e) { caixa('Link dos compradores', link, 'OK', null, true); }
}
async function salvarLoteRev() {
  guardarRev(); const d = rascunho;
  const qtd = parseInt(d.qtd, 10), peso = nv(d.peso), valor = nv(d.valor);
  if (!d.cat) return aviso('Escolha o tipo de animal.');
  if (!(qtd > 0 && peso > 0 && valor != null && valor >= 0)) return aviso('Preencha quantidade, peso médio e valor da @.');
  if (VENDIDOS.includes(d.status) && !d.comprador_id && !E.adm.compradores.length) return aviso('Cadastre o comprador antes de marcar o lote como vendido.');
  if (!exigeInternet()) return;
  const bt = F('f-rev').querySelector('button[type=submit]'); bt.disabled = true; bt.textContent = 'Salvando...';
  const ok = await tentar(async () => {
    const midias = [];
    for (const m of d.midias) {
      if (!m.path && !m.demo) {
        const blob = await arquivos.get(m.id); if (!blob) continue;
        const ext = m.kind === 'video' ? (m.mime && m.mime.includes('quicktime') ? 'mov' : 'mp4') : 'jpg';
        m.path = await api.enviarArquivo(`lotes/${d.id}/${m.id}.${ext}`, blob, m.mime || (m.kind === 'video' ? 'video/mp4' : 'image/jpeg'));
      }
      midias.push(m.demo ? { id: m.id, kind: m.kind, demo: m.demo } : { id: m.id, kind: m.kind, path: m.path });
    }
    const vendido = VENDIDOS.includes(d.status);
    await api.salvarLote({ ...d, qtd, peso, valor, midias, vendido_em: vendido ? (d.vendido_em || new Date().toISOString()) : null },
      { valor_pago: nv(d.fin.valor_pago), despesas: nv(d.fin.despesas), valor_vendido: nv(d.fin.valor_vendido), obs: d.fin.obs });
    for (const m of d.midias) if (m.path) arquivos.del(m.id).catch(() => {});
  }, d.novo ? (d.visivel ? 'Lote publicado. Os compradores já podem ver.' : 'Lote salvo (escondido dos compradores).') : 'Lote salvo.');
  if (!ok) { bt.disabled = false; bt.textContent = d.novo ? 'Publicar lote' : 'Salvar lote'; return; }
  const id = d.id, novo = d.novo; rascunho = null; limparDigitado(); await atualizar();
  if (novo) { pilha[pilha.length - 1] = ['admRevLote', id]; pintar(true); } else voltar();
}

// =====================================================================
// AÇÕES
// =====================================================================
const F = id => document.getElementById(id);
function exigeInternet() { if (navigator.onLine) return true; aviso('Precisa de internet para isso. Tente de novo quando conectar.'); return false; }
async function tentar(fn, msgOk) {
  try { await fn(); if (msgOk) aviso(msgOk); return true; }
  catch (e) { aviso(e instanceof SemRede ? 'Sem conexão com o servidor. Tente de novo.' : 'Não deu certo: ' + (e.message || e)); console.error(e); return false; }
}
function ligar(tela, arg) {
  app.querySelectorAll('[data-a]').forEach(b => b.onclick = e => { e.preventDefault(); acao(b.dataset.a, arg); });
  app.querySelectorAll('[data-abrir]').forEach(b => b.onclick = () => abrirLanc(b.dataset.abrir));
  app.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { E.filtroAdm = b.dataset.f; pintar(); });
  app.querySelectorAll('[data-ver]').forEach(b => b.onclick = () => {
    const l = [...(E.visao === 'adm' ? E.adm.lancs : E.visao === 'prod' ? meusLancs() : []), ...E.adm.lotes, ...E.lotesComp].find(x => x.id === arg); if (l) abrirVisor(l.midias, +b.dataset.ver);
  });
  app.querySelectorAll('[data-camp]').forEach(b => b.onclick = () => ir('campanha', b.dataset.camp));
  app.querySelectorAll('[data-rl]').forEach(b => b.onclick = () => abrirLoteRev(b.dataset.rl));
  app.querySelectorAll('[data-cl]').forEach(b => b.onclick = () => abrirLoteComp(b.dataset.cl));
  app.querySelectorAll('[data-ec]').forEach(b => b.onclick = () => { const c = E.adm.compradores.find(x => x.id === b.dataset.ec); rascunho = { ...c }; ir('admComprador', c.id); });
  app.querySelectorAll('[data-banner]').forEach(b => b.onclick = () => abrirBanner(b.dataset.banner));
  app.querySelectorAll('[data-parc]').forEach(b => b.onclick = e => { e.stopPropagation(); ir('parceiro', b.dataset.parc); });
  app.querySelectorAll('[data-ev]').forEach(b => b.onclick = () => { const v = E.vantagens.find(x => x.id === b.dataset.ev); rascunho = { ...v, ate: v.ate || '' }; ir('admVantagem', v.id); });
  app.querySelectorAll('[data-ep]').forEach(b => b.onclick = () => { const x = E.parceiros.find(y => y.id === b.dataset.ep); rascunho = { ...x }; ir('admParceiro', x.id); });
  const T = LIGAR[tela]; if (T) T(arg);
}
function abrirLanc(id) {
  if (E.visao === 'adm') {
    const l = E.adm.lancs.find(x => x.id === id);
    if (l && l.adm_novo && navigator.onLine) { l.adm_novo = false; api.marcarLidoAdmin(id).catch(() => {}); }
    return ir('admLote', id);
  }
  const l = meusLancs().find(x => x.id === id);
  if (l && l.prod_novo) { const s = E.lancs.find(x => x.id === id); if (s) s.prod_novo = false; enfileirar('lido', { id }); salvarCache(); }
  ir('lote', id);
}
function abrirBanner(id) {
  const b = E.adm.banners.find(x => x.id === id);
  if (b && (b.interesses || []).some(i => i.novo) && navigator.onLine) { b.interesses.forEach(i => i.novo = false); api.marcarInteressesLidos(id).catch(() => {}); }
  rascunho = { ...b }; ir('admBanner', id);
}

const LIGAR = {
  naoComprador() {},
  compLotes() { app.querySelectorAll('[data-aba]').forEach(b => b.onclick = () => { abaComp = b.dataset.aba; pintar(true); }); },
  compLote(id) {
    F('f-cperg').onsubmit = async e => {
      e.preventDefault(); const t = F('cp-txt').value.trim(); if (!t) return;
      if (E.comprador.previa) return aviso('Prévia do administrador: para perguntar, entre com o telefone de um comprador.');
      if (!exigeInternet()) return;
      if (await tentar(() => api.msgLote({ id: novoId(), lote_id: id, comprador_id: E.comprador.id, papel: 'comp', texto: t }), 'Pergunta enviada. A Rede do Boi responde por aqui.')) { limparDigitado(); F('cp-txt').value = ''; await atualizar(); }
    };
  },
  admRevenda() { app.querySelectorAll('[data-fr]').forEach(b => b.onclick = () => { filtroRev = b.dataset.fr; pintar(); }); },
  admRevLote(id) {
    const l = E.adm.lotes.find(x => x.id === id); if (!l) return;
    F('f-rst').onsubmit = async e => {
      e.preventDefault(); if (!exigeInternet()) return;
      const st = F('rs-st').value, cid = F('rs-comp').value || null, f = finDe(l), vend = nv(F('rs-vend').value);
      if ((st === 'reservado' || VENDIDOS.includes(st)) && !cid) return aviso('Escolha o comprador deste lote.');
      const vendido = VENDIDOS.includes(st);
      if (await tentar(() => api.salvarLote({ ...l, status: st, comprador_id: cid, vendido_em: vendido ? (l.vendido_em || new Date().toISOString()) : null },
        { valor_pago: f.valor_pago ?? null, despesas: f.despesas ?? null, valor_vendido: vend, obs: f.obs || '' }), 'Situação salva.')) { limparDigitado(); await atualizar(); }
    };
    const fr = F('f-rresp'); if (fr) fr.onsubmit = async e => {
      e.preventDefault(); if (!exigeInternet()) return;
      const t = F('rr-txt').value.trim(), cid = F('rr-comp').value; if (!t) return aviso('Escreva a mensagem.');
      if (await tentar(() => api.msgLote({ id: novoId(), lote_id: id, comprador_id: cid, papel: 'adm', texto: t }), 'Enviado. O comprador vê a resposta no app.')) { limparDigitado(); F('rr-txt').value = ''; await atualizar(); }
    };
  },
  admRevForm() {
    const conta = () => { guardarRev(); const d = rascunho, t = total({ qtd: d.qtd, peso: d.peso, un: d.un, valor: d.valor });
      F('rv-total').textContent = brl0(t); F('rv-sug').textContent = brl0(t);
      F('rv-conv').textContent = d.peso ? pesoTxt({ peso: d.peso, un: d.un || '@' }) + ' por cabeça' : '1 @ = 30 kg (peso vivo)';
      F('rv-lucro').innerHTML = lucroHtml(contas({ fin: d.fin }).lucro); };
    ['rv-qtd', 'rv-peso', 'rv-un', 'rv-valor', 'rv-pago', 'rv-desp', 'rv-vend'].forEach(id => F(id).oninput = conta);
    F('rv-un').onchange = conta;
    F('rv-calc').onclick = () => { guardarRev(); const d = rascunho; F('rv-vend').value = Math.round(total({ qtd: d.qtd, peso: d.peso, un: d.un, valor: d.valor }) * 100) / 100; F('rv-vend').dataset.sujo = 1; conta(); };
    app.querySelectorAll('[data-rcat]').forEach(b => b.onclick = () => { guardarRev(); rascunho.cat = b.dataset.rcat; app.dataset.tela = ''; pintar(); });
    app.querySelectorAll('[data-rrm]').forEach(b => b.onclick = () => { guardarRev(); rascunho.midias.splice(+b.dataset.rrm, 1); app.dataset.tela = ''; pintar(); });
    ['rv-cam', 'rv-vid', 'rv-file'].forEach(id => F(id).onchange = async ev => {
      guardarRev(); const files = [...ev.target.files]; ev.target.value = '';
      for (const file of files) { const m = await guardarMidia(file); if (m) rascunho.midias.push(m); }
      app.dataset.tela = ''; pintar();
    });
    F('f-rev').onsubmit = e => { e.preventDefault(); salvarLoteRev(); };
  },
  admCompradores() {
    const bs = F('cb-busca'); if (bs) bs.oninput = () => { buscaComp = bs.value; app.dataset.tela = ''; pintar(); const n = F('cb-busca'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); };
  },
  admComprador(id) {
    F('f-comp').onsubmit = async e => {
      e.preventDefault(); const v = i => F(i).value.trim();
      const c = { id: id || null, nome: v('cb-nome'), fone: foneNormal(v('cb-fone')), cidade: v('cb-cid'), documento: v('cb-doc'), obs: v('cb-obs'), ativo: F('cb-at').checked };
      if (!c.nome) return aviso('Escreva o nome do comprador.');
      if (!foneValido(c.fone)) return aviso('Digite o telefone com DDD. Ex.: (69) 99999-9999');
      if (E.adm.compradores.some(x => x.fone === c.fone && x.id !== id)) return aviso('Já existe um comprador com este telefone.');
      if (!exigeInternet()) return;
      if (await tentar(() => api.salvarComprador(c), id ? 'Comprador salvo.' : 'Comprador cadastrado. Envie o link para ele.')) { rascunho = null; limparDigitado(); await atualizar(); voltar(); }
    };
  },
  relRevenda() {
    F('f-relrev').onchange = () => { filtroRelRev = { ...filtroRelRev, de: F('rr-de').value, ate: F('rr-ate').value, st: F('rr-st').value }; app.dataset.tela = ''; pintar(); };
    app.querySelectorAll('[data-vr]').forEach(b => b.onclick = () => { filtroRelRev.ver = b.dataset.vr; pintar(true); });
  },
  login() {
    F('f-login').onsubmit = async e => {
      e.preventDefault(); const fone = foneNormal(F('l-fone').value);
      if (!foneValido(fone)) return aviso('Digite o telefone com DDD. Ex.: (97) 99999-9999');
      if (!exigeInternet()) return;
      const bt = e.submitter || F('f-login').querySelector('button'); bt.disabled = true; bt.textContent = 'Entrando...';
      try {
        const r = await api.entrar(fone);
        if (r.precisaSenha) { bt.disabled = false; bt.textContent = 'Entrar'; return ir('senha', fone); }
        await aposEntrar();
      } catch (er) { aviso('Não foi possível entrar: ' + (er.message || er)); bt.disabled = false; bt.textContent = 'Entrar'; }
    };
  },
  senha(fone) {
    F('f-senha').onsubmit = async e => {
      e.preventDefault(); if (!exigeInternet()) return;
      const r = await api.entrarComSenha(fone, F('s-senha').value).catch(er => ({ erro: er }));
      if (r.erro) return aviso('Não foi possível entrar: ' + r.erro.message);
      if (!r.ok) return aviso('Senha incorreta.');
      E.visao = MODO_COMPRADOR ? 'comp' : 'adm'; await aposEntrar();
    };
  },
  criarSenha() {
    F('f-csenha').onsubmit = async e => {
      e.preventDefault(); const a = F('cs-1').value, b = F('cs-2').value;
      if (a.length < 6) return aviso('A senha precisa ter pelo menos 6 caracteres.');
      if (a !== b) return aviso('As duas senhas estão diferentes.');
      if (!exigeInternet()) return;
      if (await tentar(() => api.definirSenha(a), 'Senha criada. Bem-vindo ao painel!')) { E.perfil.senha_definida = true; E.visao = 'adm'; await atualizar(); inicio(); }
    };
  },
  cadastro(editar) {
    ligarVicinal();
    F('f-cad').onsubmit = async e => {
      e.preventDefault(); const v = id => F(id).value.trim();
      const d = { nome: v('c-nome'), email: v('c-email'), prop: v('c-prop'), local: v('c-local'), mun: v('c-mun'), vic: v('c-vic'), km: v('c-km') };
      if (!d.nome || !d.prop || !d.mun) return aviso('Preencha nome, propriedade e município.');
      if (!exigeInternet()) return;
      const ok = await tentar(async () => {
        E.perfil = await api.salvarPerfil(d);
        if (d.vic && !E.vicinais.some(x => norm(x) === norm(d.vic))) await api.sugerirVicinal(d.vic, d.nome).catch(() => {});
      });
      if (!ok) return;
      await salvarCache();
      if (editar) { aviso('Dados salvos.'); voltar(); } else { aviso('Cadastro criado! Bem-vindo, ' + d.nome.split(' ')[0] + '.'); inicio(); atualizar(); }
    };
  },
  inicio() { iniciarCarrossel(); },
  lancar() {
    app.querySelectorAll('[data-tipo]').forEach(b => b.onclick = () => { rascunho.tipo = b.dataset.tipo; pintar(true); });
    app.querySelectorAll('[data-cat]').forEach(b => b.onclick = () => { guardarForm(); rascunho.cat = b.dataset.cat; pintar(true); setTimeout(() => F('d-qtd') && F('d-qtd').scrollIntoView({ block: 'center', behavior: 'smooth' }), 50); });
    app.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { guardarForm(); rascunho.midias.splice(+b.dataset.rm, 1); pintar(true); });
    const f = F('f-lanc'); if (!f) return;
    ['d-qtd', 'd-peso', 'd-valor', 'd-un'].forEach(id => F(id).oninput = () => {
      guardarForm(); F('d-total').textContent = brl0(total(rascunho));
      F('d-conv').textContent = rascunho.peso ? pesoTxt({ peso: rascunho.peso, un: rascunho.un || '@' }) + ' por cabeça' : '1 @ = 30 kg (peso vivo)';
    });
    ['d-cam', 'd-vid', 'd-file'].forEach(id => F(id).onchange = async ev => {
      guardarForm(); const files = [...ev.target.files]; ev.target.value = '';
      for (const file of files) { const m = await guardarMidia(file); if (m) rascunho.midias.push(m); }
      app.dataset.tela = ''; pintar();
    });
    f.onsubmit = e => { e.preventDefault(); guardarForm(); enviarLanc(); };
  },
  lote(id) {
    const f = F('f-resp'); if (!f) return;
    f.onsubmit = async e => {
      e.preventDefault(); const t = F('r-txt').value.trim(); if (!t) return;
      limparDigitado();
      await enfileirar('msg', { id: novoId(), lanc_id: id, papel: 'prod', texto: t, criado_em: new Date().toISOString() });
      app.dataset.tela = ''; pintar(); aviso(navigator.onLine ? 'Resposta enviada.' : 'Resposta guardada, vai quando conectar.');
    };
  },
  admLote(id) {
    const l = E.adm.lancs.find(x => x.id === id); if (!l) return;
    F('f-st').onsubmit = async e => {
      e.preventDefault(); if (!exigeInternet()) return;
      const st = F('s-st').value, val = F('s-val').value;
      if (st === 'fechado' && !val && !confirm('Fechar o negócio sem informar o valor fechado por @?')) return;
      if (await tentar(() => api.salvarSituacao(id, st, val ? Number(val) : null), 'Situação salva.')) { limparDigitado(); await atualizar(); }
    };
    const fo = F('f-of'); if (fo) fo.onsubmit = async e => {
      e.preventDefault(); if (!exigeInternet()) return;
      const of = F('o-val').value, t = F('o-txt').value.trim();
      if (!of && !t) return aviso('Escreva uma mensagem ou informe a oferta.');
      if (await tentar(() => api.enviarMensagem({ id: novoId(), lanc_id: id, papel: 'adm', texto: t || 'Segue minha oferta.', oferta: of ? Number(of) : null }), 'Enviado. O produtor recebe um aviso.')) { limparDigitado(); await atualizar(); }
    };
  },
  admBanners() {
    app.querySelectorAll('[data-pausar]').forEach(b => b.onclick = async () => {
      if (!exigeInternet()) return; const x = E.adm.banners.find(y => y.id === b.dataset.pausar);
      if (await tentar(() => api.salvarBanner({ ...x, ativo: !x.ativo }), x.ativo ? 'Banner pausado.' : 'Banner ativado.')) await atualizar();
    });
  },
  admBanner(id) {
    const guardarB = () => { const g = i => { const e = F(i); return e ? e.value : undefined; };
      rascunho.titulo = g('b-tit'); rascunho.sub = g('b-sub'); if (F('b-url')) rascunho.url = g('b-url'); if (F('b-desc')) rascunho.descr = g('b-desc'); rascunho.ate = g('b-ate'); rascunho.ativo = F('b-at').checked; };
    ['b-tit', 'b-sub'].forEach(i => F(i).oninput = () => { guardarB(); F('pv').innerHTML = bannerDentro({ ...rascunho, titulo: rascunho.titulo || 'Título do banner' }); });
    app.querySelectorAll('[data-cor]').forEach(b => b.onclick = () => { guardarB(); rascunho.cor = b.dataset.cor; rascunho.img = null; rascunho._previa = null; rascunho._blob = null; pintar(true); });
    app.querySelectorAll('[data-tp]').forEach(b => b.onclick = () => { guardarB(); rascunho.tipo = b.dataset.tp; pintar(true); });
    F('b-img').onchange = async ev => { guardarB(); const f = ev.target.files[0]; if (!f) return;
      const blob = await reduzirFoto(f, 1600, .82); if (!blob) return aviso('Não consegui abrir essa imagem.');
      rascunho._blob = blob; rascunho._previa = URL.createObjectURL(blob); pintar(true); };
    F('f-bn').onsubmit = async e => {
      e.preventDefault(); guardarB(); if (!exigeInternet()) return;
      if (!rascunho.titulo) return aviso('Escreva o título.');
      const ok = await tentar(async () => {
        if (rascunho._blob) rascunho.img = await api.enviarImagemBanner(rascunho._blob);
        const { _blob, _previa, interesses, ...b } = rascunho; await api.salvarBanner(b);
      }, rascunho.ativo ? 'Banner publicado. Já aparece na tela inicial.' : 'Banner salvo (pausado).');
      if (ok) { rascunho = null; await atualizar(); voltar(); }
    };
  },
  admVic() {
    F('f-vic').onsubmit = async e => { e.preventDefault(); const n = F('v-nome').value.trim(); if (!n || !exigeInternet()) return;
      const sug = E.adm.sugestoes.filter(s => norm(s.nome) === norm(n));
      if (await tentar(async () => { await api.adicionarVicinal(n); for (const s of sug) await api.descartarSugestao(s.id); }, 'Vicinal adicionada.')) { limparDigitado(); await atualizar(); } };
    app.querySelectorAll('[data-ok]').forEach(b => b.onclick = async () => { if (!exigeInternet()) return; const s = E.adm.sugestoes.find(x => x.id === b.dataset.ok);
      if (await tentar(async () => { await api.adicionarVicinal(s.nome); await api.descartarSugestao(s.id); }, 'Vicinal aprovada e adicionada à lista.')) await atualizar(); });
    app.querySelectorAll('[data-no]').forEach(b => b.onclick = async () => { if (!exigeInternet()) return; if (await tentar(() => api.descartarSugestao(b.dataset.no))) await atualizar(); });
    app.querySelectorAll('[data-del]').forEach(b => b.onclick = () => caixa(`Remover a vicinal “${b.dataset.del}”?`, 'Ela sai da lista do cadastro. Quem já escolheu continua com o nome no cadastro.', 'Remover', async () => {
      if (exigeInternet() && await tentar(() => api.removerVicinal(b.dataset.del), 'Vicinal removida.')) await atualizar(); }));
  },
  admProdutores() {
    const bs = F('p-busca'); bs.oninput = () => { buscaProd = bs.value; app.dataset.tela = ''; pintar(); const n = F('p-busca'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); };
    app.querySelectorAll('[data-admin]').forEach(b => b.onclick = () => {
      const p = E.adm.perfis.find(x => x.id === b.dataset.admin), dar = b.dataset.v === '1';
      caixa(dar ? `Tornar ${p.nome} administrador?` : `Tirar o acesso de administrador de ${p.nome}?`,
        dar ? 'Ele vai ver todos os lançamentos, fazer ofertas e mudar status. No próximo acesso o app pede para ele criar uma senha.' : 'Ele volta a ver só os próprios lançamentos.',
        dar ? 'Tornar administrador' : 'Tirar acesso', async () => { if (exigeInternet() && await tentar(() => api.definirAdmin(p.id, dar), 'Feito.')) await atualizar(); });
    });
  },
  admVantagens() {
    app.querySelectorAll('[data-pv]').forEach(b => b.onclick = async () => {
      if (!exigeInternet()) return; const v = E.vantagens.find(x => x.id === b.dataset.pv);
      if (await tentar(() => api.salvarVantagem({ ...v, ativo: !v.ativo }), v.ativo ? 'Vantagem pausada.' : 'Vantagem ativada.')) await atualizar();
    });
  },
  admParceiros() {
    app.querySelectorAll('[data-pp]').forEach(b => b.onclick = async () => {
      if (!exigeInternet()) return; const p = E.parceiros.find(x => x.id === b.dataset.pp);
      if (await tentar(() => api.salvarParceiro({ ...p, ativo: !p.ativo }), p.ativo ? 'Parceiro pausado.' : 'Parceiro ativado.')) await atualizar();
    });
  },
  admVantagem(id) {
    const guardar = () => { rascunho.titulo = F('v-tit').value.trim(); rascunho.desconto = F('v-desc').value.trim(); rascunho.parceiro_id = F('v-parc').value;
      rascunho.descr = F('v-regras').value.trim(); rascunho.ate = F('v-ate').value; rascunho.ativo = F('v-at').checked; };
    F('v-img').onchange = async ev => { guardar(); const f = ev.target.files[0]; if (!f) return;
      const blob = await reduzirFoto(f, 1200, .8); if (!blob) return aviso('Não consegui abrir essa imagem.');
      rascunho._blob = blob; rascunho._previa = URL.createObjectURL(blob); app.dataset.tela = ''; pintar(); };
    F('f-vant').onsubmit = async e => {
      e.preventDefault(); guardar(); if (!rascunho.titulo) return aviso('Escreva o título da vantagem.'); if (!exigeInternet()) return;
      const ok = await tentar(async () => { if (rascunho._blob) rascunho.img = await api.enviarImagemBanner(rascunho._blob); const { _blob, _previa, ...v } = rascunho; await api.salvarVantagem(v); },
        rascunho.ativo ? 'Vantagem publicada no Clube.' : 'Vantagem salva (pausada).');
      if (ok) { rascunho = null; await atualizar(); voltar(); }
    };
  },
  admParceiro(id) {
    const guardar = () => { rascunho.nome = F('pa-nome').value.trim(); rascunho.categoria = F('pa-cat').value.trim(); rascunho.oferece = F('pa-of').value.trim();
      rascunho.descr = F('pa-desc').value.trim(); rascunho.fone = F('pa-fone').value.trim() ? foneNormal(F('pa-fone').value) : ''; rascunho.endereco = F('pa-end').value.trim();
      rascunho.mun = F('pa-mun').value.trim(); rascunho.ativo = F('pa-at').checked; };
    F('pa-img').onchange = async ev => { guardar(); const f = ev.target.files[0]; if (!f) return;
      const blob = await reduzirFoto(f, 800, .82); if (!blob) return aviso('Não consegui abrir essa imagem.');
      rascunho._blob = blob; rascunho._previa = URL.createObjectURL(blob); app.dataset.tela = ''; pintar(); };
    F('f-parc').onsubmit = async e => {
      e.preventDefault(); guardar(); if (!rascunho.nome) return aviso('Escreva o nome do parceiro.');
      if (rascunho.fone && !foneValido(rascunho.fone)) return aviso('WhatsApp do parceiro: digite com DDD. Ex.: (97) 99999-9999');
      if (!exigeInternet()) return;
      const ok = await tentar(async () => { if (rascunho._blob) rascunho.img = await api.enviarImagemBanner(rascunho._blob); const { _blob, _previa, ...p } = rascunho; await api.salvarParceiro(p); },
        rascunho.ativo ? 'Parceiro publicado.' : 'Parceiro salvo (pausado).');
      if (ok) { rascunho = null; await atualizar(); voltar(); }
    };
  },
  relatorio() {
    const f = F('f-rel'); f.onchange = () => { filtroRel = { ...filtroRel, de: F('r-de').value, ate: F('r-ate').value, st: F('r-st').value, tipo: F('r-tipo').value }; app.dataset.tela = ''; pintar(); };
    app.querySelectorAll('[data-ver]').forEach(b => b.onclick = () => { filtroRel.ver = b.dataset.ver; pintar(true); });
    app.querySelectorAll('[data-grupo]').forEach(b => b.onclick = () => { const el = document.getElementById(b.dataset.grupo); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  },
};

function guardarForm() {
  const g = id => { const e = F(id); return e ? e.value : undefined; };
  if (g('d-qtd') !== undefined) { rascunho.qtd = g('d-qtd'); rascunho.peso = g('d-peso'); rascunho.un = g('d-un'); rascunho.valor = g('d-valor'); }
}

async function acao(a, arg) {
  if (a === 'voltar') return voltar();
  if (a === 'meusDados') return ir('cadastro', true);
  if (a === 'avisos') return ir('avisos');
  if (a === 'permitirAvisos') return pedirAvisos();
  if (a === 'lancar') { rascunho = { id: novoId(), tipo: null, cat: null, midias: [], un: '@' }; return ir('lancar'); }
  if (['meus', 'vantagens', 'ofertas', 'parceiros', 'relatorio', 'admVic', 'admBanners', 'admProdutores', 'admVantagens', 'admParceiros'].includes(a)) return ir(a);
  if (a === 'novoParceiro') { rascunho = { nome: '', categoria: '', oferece: '', descr: '', fone: '', endereco: '', mun: '', img: null, ativo: true }; return ir('admParceiro', null); }
  if (a === 'novaVantagem') { rascunho = { titulo: '', desconto: '', descr: '', parceiro_id: arg && E.parceiros.some(p => p.id === arg) ? arg : '', img: null, ate: '', ativo: true }; return ir('admVantagem', null); }
  if (a === 'trocarVisao') { E.visao = E.visao === 'adm' ? 'prod' : 'adm'; return inicio(); }
  if (a === 'sair') return caixa('Sair desta conta?', E.fila.length ? 'Ainda há envios guardados neste aparelho. Eles serão enviados quando você entrar de novo com este telefone.' : 'Para entrar de novo é só digitar o telefone.', 'Sair', async () => {
    await api.sair(); Object.assign(E, { usuario: null, perfil: null, lancs: [], adm: { lancs: [], banners: [], sugestoes: [], perfis: [], compradores: [], lotes: [] }, comprador: null, lotesComp: [], visao: MODO_COMPRADOR ? 'comp' : 'prod', carregado: false }); inicio(); });
  if (a === 'editar') {
    const l = meusLancs().find(x => x.id === arg);
    rascunho = { ...JSON.parse(JSON.stringify(l)), editando: true, pendenteNovo: !!l.pendente }; return ir('lancar');
  }
  if (a === 'excluir') return caixa('Excluir este lançamento?', 'Ele some da sua lista e o comprador é avisado.', 'Excluir', async () => {
    const id = rascunho.id;
    const it = E.fila.find(i => i.op === 'lanc_novo' && i.dados.id === id);
    if (it) { await fila.del(it.seq); for (const m of it.dados.midias) arquivos.del(m.id).catch(() => {}); await lerFila(); }
    else await enfileirar('lanc_exc', { id });
    rascunho = null; pilha = [[telaInicial()], ['meus']]; pintar(true); aviso('Lançamento excluído.');
  });
  if (a === 'novoBanner') { rascunho = { titulo: '', sub: '', cor: 'verde', img: null, tipo: 'campanha', url: '', descr: '', ate: '', ativo: true }; return ir('admBanner', null); }
  if (a === 'excluirBanner') return caixa('Excluir este banner?', 'Ele sai da tela inicial dos produtores.', 'Excluir', async () => {
    if (exigeInternet() && await tentar(() => api.excluirBanner(rascunho.id), 'Banner excluído.')) { rascunho = null; await atualizar(); voltar(); } });
  if (a === 'interesse') {
    await enfileirar('interesse', { banner_id: arg }); app.dataset.tela = ''; pintar();
    return caixa('Interesse enviado!', 'A equipe da Rede do Boi vai entrar em contato com você.', 'OK', null, true);
  }
  if (a === 'tirarFoto') { rascunho.img = null; rascunho._blob = null; rascunho._previa = null; app.dataset.tela = ''; return pintar(); }
  if (a === 'excluirVantagem') return caixa('Excluir esta vantagem?', 'Ela sai do Clube de Vantagens dos produtores.', 'Excluir', async () => {
    if (exigeInternet() && await tentar(() => api.excluirVantagem(rascunho.id), 'Vantagem excluída.')) { rascunho = null; await atualizar(); voltar(); } });
  if (a === 'excluirParceiro') return caixa('Excluir este parceiro?', 'Ele sai da lista de parceiros. As vantagens dele continuam, mas ficam sem parceiro.', 'Excluir', async () => {
    if (exigeInternet() && await tentar(() => api.excluirParceiro(rascunho.id), 'Parceiro excluído.')) { rascunho = null; await atualizar(); voltar(); } });
  if (['admRevenda', 'admCompradores', 'relRevenda'].includes(a)) return ir(a);
  if (a === 'novoLoteRev') return novoLoteRev();
  if (a === 'editarLoteRev') {
    const l = E.adm.lotes.find(x => x.id === arg); if (!l) return; const f = finDe(l);
    rascunho = { ...JSON.parse(JSON.stringify(l)), comprador_id: l.comprador_id || '', fin: { valor_pago: f.valor_pago ?? '', despesas: f.despesas ?? '', valor_vendido: f.valor_vendido ?? '', obs: f.obs || '' }, novo: false };
    delete rascunho.lote_mensagens; delete rascunho.comprador; return ir('admRevForm', l.id);
  }
  if (a === 'excluirLoteRev') return caixa('Excluir este lote?', 'Ele some para os compradores e sai do relatório, junto com as perguntas e os valores. Se ele só não vai ser vendido, prefira mudar o status para Cancelado.', 'Excluir', async () => {
    if (exigeInternet() && await tentar(() => api.excluirLote(rascunho.id), 'Lote excluído.')) { rascunho = null; await atualizar(); pilha = [[telaInicial()], ['admRevenda']]; pintar(true); } });
  if (a === 'separarRevenda') {
    const l = E.adm.lancs.find(x => x.id === arg); if (!l) return;
    return novoLoteRev({ cat: l.cat, qtd: l.qtd, peso: l.peso, un: l.un || '@', valor: '', midias: JSON.parse(JSON.stringify(l.midias || [])), origem_lanc: l.id,
      fin: { valor_pago: l.status === 'fechado' ? Math.round(valorFechado(l) * 100) / 100 : '', despesas: '', valor_vendido: '', obs: '' } });
  }
  if (a === 'novoComprador') { rascunho = { nome: '', fone: '', cidade: '', documento: '', obs: '', ativo: true }; return ir('admComprador', null); }
  if (a === 'excluirComprador') return caixa('Excluir este comprador?', 'Ele perde o acesso aos lotes e as perguntas dele são apagadas. Os lotes comprados ficam sem comprador no relatório. Para só bloquear o acesso, desmarque "Liberado".', 'Excluir', async () => {
    if (exigeInternet() && await tentar(() => api.excluirComprador(rascunho.id), 'Comprador excluído.')) { rascunho = null; await atualizar(); voltar(); } });
  if (a === 'copiarLink') return copiarLink();
  if (a === 'planilhaRevenda') return planilhaRevenda();
  if (a === 'tentarDeNovo') { E.carregado = false; pintar(); await atualizar(); return inicio(); }
  if (a === 'queroLote') {
    const l = E.lotesComp.find(x => x.id === arg); if (!l) return;
    if (E.comprador.previa) return aviso('Prévia do administrador: para comprar, entre com o telefone de um comprador.');
    return caixa('Confirmar a compra deste lote?', `${lancTitulo(l)}, peso médio ${pesoTxt(l)}, ${brl(l.valor)}/@. Total estimado ${brl0(total(l))}. O lote fica reservado para você e a Rede do Boi entra em contato para combinar o pagamento e a retirada.`, 'Confirmar compra', async () => {
      if (!exigeInternet()) return;
      const ok = await tentar(() => api.msgLote({ id: novoId(), lote_id: l.id, comprador_id: E.comprador.id, papel: 'comp', texto: 'Quero comprar este lote.', quer_comprar: true }));
      if (!ok) return; await atualizar();
      const x = E.lotesComp.find(y => y.id === l.id);
      if (x && meuLote(x)) caixa('Compra confirmada!', 'O lote está reservado para você. A Rede do Boi vai entrar em contato em breve para combinar o pagamento e a retirada.', 'OK', null, true);
      else caixa('Outro comprador confirmou antes', 'Seu pedido ficou registrado. Se o negócio dele não fechar, a Rede do Boi entra em contato com você.', 'OK', null, true);
    });
  }
  if (a === 'baixarPlanilha') return baixarPlanilha();
  if (a === 'imprimir') return window.print();
}

async function enviarLanc() {
  const d = rascunho;
  const qtd = parseInt(d.qtd, 10), peso = Number(String(d.peso).replace(',', '.')), valor = Number(String(d.valor).replace(',', '.'));
  if (!(qtd > 0 && peso > 0 && valor > 0)) return aviso('Preencha quantidade, peso médio e valor por @.');
  const dados = { tipo: d.tipo, cat: d.cat, qtd, peso, un: d.un || '@', valor, midias: d.midias.map(({ id, kind, path, mime, demo }) => ({ id, kind, path, mime, demo })) };
  if (d.editando) {
    const it = E.fila.find(i => i.op === 'lanc_novo' && i.dados.id === d.id);
    if (it) { Object.assign(it.dados, dados); await fila.put(it); await lerFila(); sincronizar(); }
    else await enfileirar('lanc_alt', { id: d.id, campos: dados });
    rascunho = null; voltar(); aviso(navigator.onLine ? 'Alterações enviadas.' : 'Alterações guardadas no aparelho. Vão sozinhas quando conectar.');
    return;
  }
  const novo = { id: d.id, criado_em: new Date().toISOString(), ...dados };
  rascunho = null; pilha = [[telaInicial()], ['meus']];
  await fila.add({ op: 'lanc_novo', uid: E.usuario.id, dados: novo, tentativas: 0, em: Date.now() });
  await lerFila(); pintar(true);
  if (!navigator.onLine) caixa('Lançamento guardado no aparelho', 'Você está sem internet. Assim que conectar, ele será enviado sozinho, sem precisar repetir nada.', 'Entendi', null, true);
  else { aviso('Enviando...'); sincronizar(); }
}

// ---------- fotos: reduz o tamanho para enviar rápido pelo sinal da roça ----------
async function reduzirFoto(file, max = 1600, q = .78) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null);
    let img = bmp;
    if (!img) img = await new Promise(r => { const i = new Image(); i.onload = () => r(i); i.onerror = () => r(null); i.src = URL.createObjectURL(file); });
    if (!img) return null;
    const w = img.width, h = img.height, s = Math.min(1, max / Math.max(w, h));
    const c = document.createElement('canvas'); c.width = Math.round(w * s); c.height = Math.round(h * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return await new Promise(r => c.toBlob(r, 'image/jpeg', q));
  } catch (e) { console.error(e); return null; }
}
async function guardarMidia(file) {
  const id = novoId();
  if (file.type.startsWith('video')) {
    if (file.size > VIDEO_MAX_MB * 1024 * 1024) { aviso(`Vídeo muito grande (${Math.round(file.size / 1048576)} MB). Grave um vídeo mais curto, de até 1 minuto.`); return null; }
    await arquivos.set(id, file); URLS.set(id, URL.createObjectURL(file));
    return { id, kind: 'video', mime: file.type || 'video/mp4' };
  }
  const blob = await reduzirFoto(file);
  if (!blob) { aviso('Não consegui abrir essa foto.'); return null; }
  await arquivos.set(id, blob); URLS.set(id, URL.createObjectURL(blob));
  return { id, kind: 'img', mime: 'image/jpeg' };
}

// ---------- caixas de mensagem ----------
function caixa(titulo, texto, ok, fn, unico) {
  const m = document.getElementById('modal');
  m.innerHTML = `<div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="m-t"><div class="box"><div class="big" id="m-t">${esc(titulo)}</div>${texto ? `<div class="meta">${esc(texto)}</div>` : ''}<div class="btns" style="justify-content:center">${unico ? '' : '<button class="ghost" id="m-no">Cancelar</button>'}<button class="cta ${fn ? '' : 'green'}" style="width:auto;padding:11px 22px" id="m-ok">${esc(ok)}</button></div></div></div>`;
  F('m-ok').focus();
  F('m-ok').onclick = () => { m.innerHTML = ''; fn && fn(); };
  const n = F('m-no'); if (n) n.onclick = () => m.innerHTML = '';
}
let tt;
function aviso(msg) { const t = F('toast'); t.textContent = msg; t.hidden = false; clearTimeout(tt); tt = setTimeout(() => t.hidden = true, 3200); }

// ---------- partida ----------
async function aposEntrar() {
  E.usuario = api.usuario();
  await lerCache(); await lerFila();
  if (navigator.onLine) await atualizar();
  if (MODO_COMPRADOR) E.visao = 'comp';
  else if (ehAdmin() && !pilha.some(p => p[0].startsWith('adm'))) E.visao = E.visao || 'adm';
  else if (!ehAdmin()) E.visao = 'prod';
  inicio();
  sincronizar();
}
function conexao(on) {
  E.online = on; barraRede();
  if (on) { sincronizar(); atualizar(); }
}
addEventListener('online', () => conexao(true));
addEventListener('offline', () => conexao(false));
document.addEventListener('visibilitychange', () => { if (!document.hidden && E.usuario) { sincronizar(); atualizar(); } });
setInterval(() => { if (E.usuario && navigator.onLine && !document.hidden) { sincronizar(); atualizar(); } }, 60000);

async function partida() {
  pedirPersistencia();
  try { await api.iniciar(); } catch (e) { console.error(e); }
  E.usuario = api.usuario();
  if (E.usuario) {
    await lerCache(); await lerFila();
    if (ehAdmin() && !MODO_COMPRADOR) E.visao = (await kv.get('visao').catch(() => null)) || 'adm';
    inicio();
    if (navigator.onLine) { await atualizar(); if (!pilha.length || pilha.length === 1) inicio(); }
    sincronizar();
  } else inicio();
  api.aoMudar(() => atualizar());
}
partida();
// lembra se o administrador estava no painel ou na área do produtor
addEventListener('pagehide', () => { if (!MODO_COMPRADOR) kv.set('visao', E.visao).catch(() => {}); });

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(e => console.warn('sw', e));
}
// expõe para testes
window.__rdb = { E, api, sincronizar, atualizar, MODO };

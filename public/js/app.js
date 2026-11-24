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
  usuario: null, perfil: null, vicinais: [], lancs: [], banners: [], interesses: [],
  adm: { lancs: [], banners: [], sugestoes: [], perfis: [] },
  fila: [], online: navigator.onLine, visao: 'prod', filtroAdm: 'todos', carregado: false,
};
let pilha = [], rascunho = null;
const app = document.getElementById('app');
const ehAdmin = () => !!(E.perfil && E.perfil.admin && E.perfil.senha_definida);

async function salvarCache() {
  if (!E.usuario) return;
  const { perfil, vicinais, lancs, banners, interesses, adm } = E;
  try { await kv.set('cache:' + E.usuario.id, { perfil, vicinais, lancs, banners, interesses, adm, em: Date.now() }); } catch (e) {}
}
async function lerCache() {
  const c = await kv.get('cache:' + E.usuario.id).catch(() => null);
  if (c) Object.assign(E, { perfil: c.perfil, vicinais: c.vicinais || [], lancs: c.lancs || [], banners: c.banners || [], interesses: c.interesses || [], adm: c.adm || E.adm });
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
      const perfil = await api.perfil();
      E.perfil = perfil;
      if (!perfil) { salvarCache(); return; }
      const [vic, lancs, bans, ints] = await Promise.all([api.vicinais(), api.meusLancamentos(), api.banners(), api.meusInteresses()]);
      Object.assign(E, { vicinais: vic, lancs, banners: bans, interesses: ints });
      if (ehAdmin()) {
        const [al, ab, sg, pf] = await Promise.all([api.todosLancamentos(), api.bannersAdmin(), api.sugestoes(), api.perfis()]);
        E.adm = { lancs: al, banners: ab, sugestoes: sg, perfis: pf };
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

// ---------- avisos (notificações) ----------
function avisosProd() { return meusLancs().filter(l => l.prod_novo); }
function avisosAdm() { return E.adm.lancs.filter(l => l.adm_novo); }
function interessesNovos() { return E.adm.banners.reduce((s, b) => s + (b.interesses || []).filter(i => i.novo).length, 0); }
function contarAvisos() { return E.visao === 'adm' ? avisosAdm().length + interessesNovos() : avisosProd().length; }
function avisosIds() {
  const ids = new Set(avisosProd().map(l => 'p' + l.id + l.mensagens.length));
  if (ehAdmin()) avisosAdm().forEach(l => ids.add('a' + l.id + (l.mensagens || []).length));
  return ids;
}
async function notificarNovos(antes) {
  if (!E.carregado || !antes.size && !avisosIds().size) return;
  const novos = [...avisosIds()].filter(i => !antes.has(i));
  if (!novos.length || !document.hidden) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const reg = await navigator.serviceWorker?.getRegistration();
  const titulo = novos.some(i => i[0] === 'a') ? 'Novo lançamento ou resposta no Rede do Boi' : 'Nova mensagem do comprador';
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
const FORMULARIOS = new Set(['lancar', 'cadastro', 'admBanner', 'login', 'senha', 'criarSenha']);
function barraRedeHtml() {
  const q = E.fila.filter(i => E.usuario && i.uid === E.usuario.id).length;
  if (!E.online) return `<div class="net" id="net">Sem internet. ${E.visao === 'adm' ? 'Mostrando os dados da última conexão.' : q ? `${q} envio(s) guardado(s) no aparelho, vão sozinhos quando conectar.` : 'Você pode lançar normalmente.'}</div>`;
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

TELAS.login = () => `<div class="login"><img src="${ICON}" alt="Logo Rede do Boi"><p class="slogan">Negócios e vantagens<br>para o pecuarista.</p>
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
  if (E.visao === 'adm') {
    const ls = avisosAdm(), bs = E.adm.banners.filter(b => (b.interesses || []).some(i => i.novo));
    return `${topo('Avisos')}<div class="body">${botaoPermitirAvisos()}
    ${bs.map(b => `<button class="item" data-banner="${b.id}"><h3>${(b.interesses || []).filter(i => i.novo).length} novo(s) interessado(s) na campanha</h3><div class="meta">${esc(b.titulo)}</div></button>`).join('')}
    ${ls.map(l => { const ult = (l.mensagens || [])[(l.mensagens || []).length - 1]; const novo = (l.mensagens || []).filter(m => m.papel !== 'sys').length === 0 && !l.excluido_em;
      return `<button class="item" data-abrir="${l.id}"><h3>${l.excluido_em ? 'Lançamento excluído pelo produtor' : novo ? `Novo ${l.tipo === 'venda' ? 'lançamento de venda' : 'pedido de compra'}` : (ult && ult.papel === 'prod' ? 'Resposta do produtor' : 'Lançamento alterado')}</h3><div class="meta">${esc((l.perfil || {}).nome)} · ${lancTitulo(l)} · ${fdt(ult ? ult.criado_em : l.criado_em)}</div>${ult && ult.papel === 'prod' ? `<div class="meta">“${esc(ult.texto)}”</div>` : ''}</button>`; }).join('')}
    ${!ls.length && !bs.length ? '<div class="empty">Nenhum aviso novo.</div>' : ''}</div>`;
  }
  const ls = avisosProd();
  return `${topo('Avisos')}<div class="body">${botaoPermitirAvisos()}${ls.length ? ls.map(l => { const ult = l.mensagens[l.mensagens.length - 1] || {};
    return `<button class="item" data-abrir="${l.id}"><h3>${ult.oferta ? 'Nova oferta: ' + brl(ult.oferta) + '/@' : 'Nova mensagem do comprador'}</h3><div class="meta">${lancTitulo(l)} · ${esc(ult.texto)}</div></button>`; }).join('') : '<div class="empty">Nenhum aviso novo.</div>'}</div>`;
};
function botaoPermitirAvisos() {
  if (!('Notification' in window) || Notification.permission === 'granted') return '';
  return `<button class="ghost" data-a="permitirAvisos" style="width:100%">🔔 Receber avisos no celular</button>`;
}

TELAS.vantagens = () => `${topo('Clube de Vantagens')}<div class="body"><div class="empty">Em breve: descontos exclusivos para os produtores da Rede do Boi em lojas e serviços parceiros da região.</div>${WA ? `<a class="wa" href="${waLink(WA, 'Olá, quero saber do Clube de Vantagens da Rede do Boi')}" target="_blank" rel="noopener">Quero saber mais</a>` : ''}</div>`;
TELAS.ofertas = () => `${topo('Ofertas Especiais')}<div class="body">${bannersAtivos().length ? bannersAtivos().map(b => `<div>${bannerEl(b)}</div>`).join('') : '<div class="empty">Nenhuma oferta no momento. Volte em breve.</div>'}</div>`;
TELAS.parceiros = () => `${topo('Nossos Parceiros')}<div class="body"><div class="empty">Em breve: a lista de parceiros da região (agropecuárias, veterinários, transportadores).</div>${WA ? `<a class="wa" href="${waLink(WA, 'Olá, quero ser parceiro da Rede do Boi')}" target="_blank" rel="noopener">Quero ser parceiro</a>` : ''}</div>`;

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
  <button class="ghost" data-a="admBanners">Banners da tela inicial${novosInt ? ' <span class="dot"></span>' : ''}</button>
  <button class="ghost" data-a="admVic">Vicinais${sug ? ` · ${sug} nova(s) para conferir` : ''}</button>
  <button class="ghost" data-a="admProdutores">Produtores e administradores</button>
  ${iconeVoltarAdm()}
  <button class="ghost red" data-a="sair">Sair</button></div></div>`;
};

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
  <h2 class="sec">Histórico</h2>${conversa(l, 'adm')}
  ${l.excluido_em ? '<p class="note">O produtor excluiu este lançamento. Ele continua no relatório.</p>' : `<h2 class="sec">Fazer oferta ou mandar mensagem</h2>
  <form id="f-of"><label for="o-val">Oferta por @ (R$) <span class="opt">(opcional)</span><input id="o-val" type="number" inputmode="decimal" step="0.01" placeholder="Ex.: ${Math.max(0, (Number(l.valor) || 0) - 5)}"></label>
   <label for="o-txt">Mensagem<textarea id="o-txt" rows="3" placeholder="Escreva para o produtor"></textarea></label>
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

let filtroRel = { de: '', ate: '', st: 'todos', tipo: 'todos' };
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
  <div class="btns"><button class="ghost" data-a="baixarPlanilha">Baixar planilha (Excel)</button><button class="ghost" data-a="imprimir">Imprimir ou salvar PDF</button></div>
  <div class="tbl"><table><thead><tr><th>Data</th><th>Produtor</th><th>Vicinal</th><th>Tipo</th><th>Lote</th><th class="r">Pedido/@</th><th class="r">Última oferta</th><th class="r">Fechado/@</th><th class="r">Valor fechado</th><th>Status</th><th>Responsável</th><th class="r">Msgs</th></tr></thead><tbody>
  ${ls.map(l => `<tr data-abrir="${l.id}"><td>${fd(l.criado_em)}</td><td>${esc((l.perfil || {}).nome)}</td><td>${esc((l.perfil || {}).vic || '')}</td><td>${l.tipo === 'venda' ? 'Venda' : 'Compra'}</td><td>${lancTitulo(l)}, ${pesoTxt(l)}</td><td class="r">${brl(l.valor)}</td><td class="r">${ultimaOferta(l) ? brl(ultimaOferta(l)) : '–'}</td><td class="r">${l.valor_fechado ? brl(l.valor_fechado) : '–'}</td><td class="r">${l.status === 'fechado' ? brl0(valorFechado(l)) : '–'}</td><td>${ST[l.status]}${l.excluido_em ? ' (excluído)' : ''}</td><td>${esc(responsavel(l))}</td><td class="r">${(l.mensagens || []).filter(h => h.papel !== 'sys').length}</td></tr>`).join('') || '<tr><td colspan="12">Nenhum lançamento no período.</td></tr>'}
  </tbody></table></div></div>`;
};
function baixarPlanilha() {
  const ls = linhasRelatorio();
  const cab = ['Data', 'Produtor', 'Telefone', 'Propriedade', 'Município', 'Vicinal', 'Km', 'Tipo', 'Animal', 'Quantidade', 'Peso médio', 'Unidade', 'Peso em @', 'Pedido R$/@', 'Total pedido R$', 'Última oferta R$/@', 'Fechado R$/@', 'Valor fechado R$', 'Status', 'Responsável', 'Mensagens', 'Excluído pelo produtor'];
  const n = v => v == null || v === '' ? '' : String(Math.round(Number(v) * 100) / 100).replace('.', ',');
  const linhas = ls.map(l => { const u = l.perfil || {};
    return [fd(l.criado_em), u.nome, foneBonito(u.fone), u.prop, u.mun, u.vic, u.km, l.tipo === 'venda' ? 'Venda' : 'Compra', CAT[l.cat], l.qtd, n(l.peso), l.un, n(arroba(l)), n(l.valor), n(total(l)), n(ultimaOferta(l)), n(l.valor_fechado), l.status === 'fechado' ? n(valorFechado(l)) : '', ST[l.status], responsavel(l), (l.mensagens || []).filter(h => h.papel !== 'sys').length, l.excluido_em ? 'Sim' : '']; });
  const csv = '﻿' + [cab, ...linhas].map(r => r.map(c => { c = String(c ?? ''); return /[;"\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c; }).join(';')).join('\r\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `rede-do-boi-negociacoes-${new Date().toISOString().slice(0, 10)}.csv`; document.body.appendChild(a); a.click(); a.remove();
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
    const l = (E.visao === 'adm' ? E.adm.lancs : meusLancs()).find(x => x.id === arg); if (l) abrirVisor(l.midias, +b.dataset.ver);
  });
  app.querySelectorAll('[data-camp]').forEach(b => b.onclick = () => ir('campanha', b.dataset.camp));
  app.querySelectorAll('[data-banner]').forEach(b => b.onclick = () => abrirBanner(b.dataset.banner));
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
      E.visao = 'adm'; await aposEntrar();
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
  relatorio() {
    const f = F('f-rel'); f.onchange = () => { filtroRel = { de: F('r-de').value, ate: F('r-ate').value, st: F('r-st').value, tipo: F('r-tipo').value }; pintar(); };
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
  if (['meus', 'vantagens', 'ofertas', 'parceiros', 'relatorio', 'admVic', 'admBanners', 'admProdutores'].includes(a)) return ir(a);
  if (a === 'trocarVisao') { E.visao = E.visao === 'adm' ? 'prod' : 'adm'; return inicio(); }
  if (a === 'sair') return caixa('Sair desta conta?', E.fila.length ? 'Ainda há envios guardados neste aparelho. Eles serão enviados quando você entrar de novo com este telefone.' : 'Para entrar de novo é só digitar o telefone.', 'Sair', async () => {
    await api.sair(); Object.assign(E, { usuario: null, perfil: null, lancs: [], adm: { lancs: [], banners: [], sugestoes: [], perfis: [] }, visao: 'prod', carregado: false }); inicio(); });
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
  if (ehAdmin() && !pilha.some(p => p[0].startsWith('adm'))) E.visao = E.visao || 'adm';
  if (!ehAdmin()) E.visao = 'prod';
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
    if (ehAdmin()) E.visao = (await kv.get('visao').catch(() => null)) || 'adm';
    inicio();
    if (navigator.onLine) { await atualizar(); if (!pilha.length || pilha.length === 1) inicio(); }
    sincronizar();
  } else inicio();
  api.aoMudar(() => atualizar());
}
partida();
// lembra se o administrador estava no painel ou na área do produtor
addEventListener('pagehide', () => { kv.set('visao', E.visao).catch(() => {}); });

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(e => console.warn('sw', e));
}
// expõe para testes
window.__rdb = { E, api, sincronizar, atualizar, MODO };

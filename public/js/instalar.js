// Ajuda a pessoa a colocar o Rede do Boi na tela inicial do celular.
// Android/Chrome: botão "Instalar" de um toque (usa o aviso do próprio Chrome).
// iPhone: guia na tela mostrando Compartilhar > Adicionar à Tela de Início.
// Dentro do WhatsApp/Instagram/Facebook: orienta a abrir no Chrome ou no Safari, onde dá para instalar.
// Funciona separado do resto do app: não mexe no login nem no modo sem internet.
(function () {
  const ua = navigator.userAgent || '';
  const IOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const IPAD = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const ANDROID = /Android/.test(ua);
  const CELULAR = IOS || ANDROID;
  // navegadores de dentro de outros apps (não deixam instalar)
  const DENTRO = /FBAN|FBAV|FB_IAB|FBIOS|Instagram|WhatsApp|Line\/|Snapchat|TikTok|musical_ly|Bytedance|Twitter|LinkedInApp|GSA\/|; wv\)/.test(ua);
  const SAFARI_IOS = IOS && /Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\/|DuckDuckGo/.test(ua) && !DENTRO;
  const ANDROID_INFO = ANDROID && /Chrome\//.test(ua) && !DENTRO;

  const instalado = () => (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  const ls = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };

  let aviso = null; // evento do Chrome que abre a janela "Instalar app"
  addEventListener('beforeinstallprompt', e => { e.preventDefault(); aviso = e; mostrarFaixa(); atualizarBotoes(); });
  addEventListener('appinstalled', () => { aviso = null; ls.set('rdb-instalado', '1'); fechar(); esconderFaixa(); atualizarBotoes(); });

  const linkApp = () => location.origin + location.pathname;
  const linkChrome = () => `intent://${location.host}${location.pathname}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(linkApp())};end`;
  const linkSafari = () => 'x-safari-' + linkApp();

  const SVG_COMPART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 10H6a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1h-2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  const SVG_MAIS = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 8.5v7M8.5 12h7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  const SVG_PONTOS = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="19" r="2" fill="currentColor"/></svg>';
  const SVG_PONTOS_H = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="19" cy="12" r="2" fill="currentColor"/></svg>';
  const ic = s => `<span class="inst-ic">${s}</span>`;
  const passo = (n, html) => `<li><span class="inst-n">${n}</span><span>${html}</span></li>`;

  // ---------- faixa no rodapé ----------
  let faixa = null;
  function podeMostrar() { return !instalado() && CELULAR; }
  function mostrarFaixa() {
    if (!podeMostrar() || faixa || painel) return;
    const ate = Number(ls.get('rdb-inst-depois') || 0);
    if (!DENTRO && Date.now() < ate) return;
    faixa = document.createElement('div');
    faixa.className = 'inst-faixa';
    faixa.setAttribute('role', 'region');
    faixa.setAttribute('aria-label', 'Instalar o app');
    faixa.innerHTML = `<img src="icons/icon-192.png" alt=""><div class="inst-ft"><b>Coloque o app na tela do celular</b><span>Abre com um toque, como os outros apps.</span></div>
      <button type="button" class="inst-bt" data-instalar>Instalar</button><button type="button" class="inst-x" aria-label="Agora não">×</button>`;
    faixa.querySelector('.inst-x').onclick = () => { ls.set('rdb-inst-depois', String(Date.now() + 2 * 864e5)); esconderFaixa(); };
    document.body.appendChild(faixa);
  }
  function esconderFaixa() { if (faixa) { faixa.remove(); faixa = null; } }

  // ---------- painel com o passo a passo ----------
  let painel = null;
  function abrirPainel(html) {
    fechar(); esconderFaixa();
    painel = document.createElement('div');
    painel.className = 'inst-fundo';
    painel.setAttribute('role', 'dialog');
    painel.setAttribute('aria-modal', 'true');
    painel.setAttribute('aria-label', 'Como instalar o app');
    painel.innerHTML = html;
    painel.addEventListener('click', e => { if (e.target === painel || e.target.closest('[data-fechar]')) fechar(); });
    const copiar = painel.querySelector('[data-copiar]');
    if (copiar) copiar.onclick = () => copiarLink(copiar);
    document.body.appendChild(painel);
    const cx = painel.querySelector('.inst-caixa'); cx.tabIndex = -1; cx.style.outline = 'none'; cx.focus({ preventScroll: true });
  }
  function fechar() { if (painel) { painel.remove(); painel = null; } }
  addEventListener('keydown', e => { if (e.key === 'Escape') fechar(); });

  async function copiarLink(bt) {
    const t = linkApp();
    let ok = false;
    try { await navigator.clipboard.writeText(t); ok = true; } catch (e) {
      const i = document.createElement('textarea'); i.value = t; i.setAttribute('readonly', ''); i.style.position = 'fixed'; i.style.opacity = '0';
      document.body.appendChild(i); i.select(); try { ok = document.execCommand('copy'); } catch (x) {} i.remove();
    }
    bt.textContent = ok ? 'Link copiado ✓' : t;
  }

  const topoPainel = titulo => `<div class="inst-caixa"><button type="button" class="inst-x" data-fechar aria-label="Fechar">×</button>
    <img class="inst-logo" src="icons/icon-192.png" alt=""><h2>${titulo}</h2>`;
  const rodapePainel = (extra = '') => `${extra}<button type="button" class="inst-depois" data-fechar>Agora não, continuar aqui</button></div>`;

  function guiaIphone() {
    const seta = IPAD ? 'cima' : 'baixo';
    abrirPainel(`${topoPainel('Instale no iPhone em 3 passos')}
      <ol class="inst-passos">
        ${passo(1, `Toque no botão <b>Compartilhar</b> ${ic(SVG_COMPART)} ${IPAD ? 'no alto da tela' : 'na barra de baixo do Safari'}.<small>Se não aparecer, toque nos três pontinhos ${ic(SVG_PONTOS_H)} e depois em Compartilhar.</small>`)}
        ${passo(2, `Role a lista para cima e toque em <b>Adicionar à Tela de Início</b> ${ic(SVG_MAIS)}.`)}
        ${passo(3, 'Toque em <b>Adicionar</b>, no canto de cima. Pronto! O ícone do Rede do Boi aparece junto dos seus apps.')}
      </ol>
      ${rodapePainel()}<div class="inst-seta inst-seta-${seta}" aria-hidden="true"><span>Compartilhar</span><span class="inst-seta-c">${IPAD ? '↑' : '↓'}</span></div>`);
  }

  function guiaAbrirSafari() {
    abrirPainel(`${topoPainel('Abra no Safari para instalar')}
      <p class="inst-txt">Por aqui (dentro do WhatsApp, Instagram ou outro navegador) o iPhone não deixa instalar. É rápido:</p>
      <a class="inst-cta" href="${linkSafari()}">Abrir no Safari</a>
      <ol class="inst-passos">
        ${passo(1, `Se o botão não funcionar, toque nos três pontinhos ${ic(SVG_PONTOS_H)} ou no ícone ${ic(SVG_COMPART)} e escolha <b>Abrir no Safari</b>.`)}
        ${passo(2, `No Safari, toque em <b>Compartilhar</b> ${ic(SVG_COMPART)} e depois em <b>Adicionar à Tela de Início</b> ${ic(SVG_MAIS)}.`)}
      </ol>
      ${rodapePainel('<button type="button" class="inst-sec" data-copiar>Copiar o link</button>')}`);
  }

  function guiaAndroid() {
    const noChrome = ANDROID_INFO;
    abrirPainel(`${topoPainel(noChrome ? 'Instale no celular' : 'Abra no Chrome para instalar')}
      ${noChrome ? '' : '<p class="inst-txt">Por dentro do WhatsApp, Instagram ou Facebook não dá para instalar. Toque no botão abaixo:</p>'}
      ${noChrome ? '' : `<a class="inst-cta" href="${linkChrome()}">Abrir no Chrome</a>`}
      <ol class="inst-passos">
        ${noChrome
          ? passo(1, `Toque nos três pontinhos ${ic(SVG_PONTOS)} no canto de cima da tela.`) + passo(2, `Escolha <b>Instalar app</b> ou <b>Adicionar à tela inicial</b> ${ic(SVG_MAIS)}.`) + passo(3, 'Confirme em <b>Instalar</b>. O ícone do Rede do Boi aparece junto dos seus apps.')
          : passo(1, `Se o botão não funcionar, toque nos três pontinhos ${ic(SVG_PONTOS)} e escolha <b>Abrir no Chrome</b> (ou "Abrir no navegador").`) + passo(2, 'No Chrome, toque em <b>Instalar</b> quando aparecer o aviso.')}
      </ol>
      ${noChrome ? `<a class="inst-sec" href="${linkChrome()}">Não achou? Abrir no Chrome</a>` : ''}
      ${rodapePainel('<button type="button" class="inst-sec" data-copiar>Copiar o link</button>')}`);
  }

  function guiaComputador() {
    abrirPainel(`${topoPainel('Use no celular')}
      <p class="inst-txt">Para ter o Rede do Boi na tela do celular, abra este link no celular:</p>
      <p class="inst-link">${linkApp().replace(/^https?:\/\//, '')}</p>
      ${rodapePainel('<button type="button" class="inst-sec" data-copiar>Copiar o link</button>')}`);
  }

  async function instalar() {
    if (instalado()) return;
    if (aviso) {
      const ev = aviso; aviso = null; esconderFaixa();
      try { ev.prompt(); const r = await ev.userChoice; if (r && r.outcome === 'accepted') ls.set('rdb-instalado', '1'); } catch (e) { guiaAndroid(); }
      atualizarBotoes();
      return;
    }
    if (IOS) return (SAFARI_IOS ? guiaIphone : guiaAbrirSafari)();
    if (ANDROID) return guiaAndroid();
    guiaComputador();
  }

  // qualquer botão com data-instalar (faixa, tela de entrada) abre a instalação
  document.addEventListener('click', e => { const b = e.target.closest && e.target.closest('[data-instalar]'); if (b) { e.preventDefault(); instalar(); } });
  // esconde os botões de instalar quando já está instalado
  function atualizarBotoes() { document.documentElement.classList.toggle('rdb-instalado', instalado()); }
  atualizarBotoes();

  window.RDB_INSTALAR = { instalar, podeMostrar, fechar };

  // ao abrir: dentro do WhatsApp/Instagram já mostra como sair de lá; senão, a faixa de instalar
  function iniciar() {
    if (!podeMostrar()) return;
    if (DENTRO && !ls.get('rdb-inst-dentro')) { ls.set('rdb-inst-dentro', '1'); setTimeout(instalar, 900); return; }
    if (SAFARI_IOS && !ls.get('rdb-inst-guia')) { ls.set('rdb-inst-guia', '1'); setTimeout(guiaIphone, 1200); return; }
    // Android com Chrome: espera o aviso do Chrome; se não vier, mostra a faixa mesmo assim (abre o passo a passo)
    setTimeout(mostrarFaixa, ANDROID_INFO ? 3500 : 1500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar); else iniciar();
})();

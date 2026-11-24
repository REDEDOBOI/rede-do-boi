const { chromium, devices } = require('playwright');
const { execSync } = require('child_process');
const sql = q => execSync(`psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -Atc "${q}"`).toString().trim();
const URL = 'http://localhost:8081/';
(async () => {
  const b = await chromium.launch();
  const erros = [];
  const nova = async () => { const ctx = await b.newContext({ ...devices['Pixel 7'], deviceScaleFactor: 1 }); const p = await ctx.newPage();
    p.on('console', m => { if (m.type() === 'error') erros.push(m.text()); }); p.on('pageerror', e => erros.push('PAGEERROR ' + e.message)); return [ctx, p]; };
  const shot = (p, n) => p.screenshot({ path: `shots/sb-${n}.png` });
  // ---- produtor
  const [cP, p] = await nova();
  await p.goto(URL); await p.waitForSelector('#f-login');
  await p.fill('#l-fone', '(97) 98111-2233'); await p.click('#f-login button'); await p.waitForSelector('#f-cad', { timeout: 15000 });
  await p.fill('#c-nome', 'Antônio Ferreira'); await p.fill('#c-prop', 'Fazenda Esperança'); await p.selectOption('#c-mun', 'Apuí');
  await p.fill('#c-vic', 'Ramal do Tatu'); await p.fill('#c-km', '22'); await p.click('#f-cad button[type=submit]');
  await p.waitForSelector('.home-grid', { timeout: 15000 }); console.log('perfil:', sql("select nome, fone, admin from perfis"));
  await p.click('[data-a=lancar]'); await p.click('[data-tipo=venda]'); await p.click('[data-cat=boi_gordo]');
  await p.fill('#d-qtd', '30'); await p.fill('#d-peso', '18'); await p.fill('#d-valor', '315');
  await p.setInputFiles('#d-file', 'ICON.jpg'); await p.waitForSelector('#d-media img');
  await p.click('#f-lanc button[type=submit]'); await p.waitForSelector('.modal', { timeout: 15000 }); console.log('modal:', await p.textContent('.modal .big')); await p.click('#m-ok');
  console.log('lanc no banco:', sql("select tipo, cat, qtd, status, jsonb_array_length(midias), adm_novo from lancamentos"));
  console.log('storage:', sql("select bucket_id, name from storage.objects"));
  await cP.setOffline(true);
  await p.click('[data-a=voltar]'); await p.click('[data-a=lancar]'); await p.click('[data-tipo=compra]'); await p.click('[data-cat=bezerra]');
  await p.fill('#d-qtd', '10'); await p.fill('#d-peso', '200'); await p.selectOption('#d-un', 'kg'); await p.fill('#d-valor', '320');
  await p.setInputFiles('#d-cam', 'ICON.jpg'); await p.waitForSelector('#d-media img');
  await p.click('#f-lanc button[type=submit]'); await p.waitForSelector('.modal'); await p.click('#m-ok');
  await p.reload().catch(() => {}); await p.waitForTimeout(1500); await shot(p, '1-offline-reload');
  console.log('offline reload tela:', await p.evaluate(() => document.getElementById('app').dataset.tela), 'fila:', await p.evaluate(() => window.__rdb && window.__rdb.E.fila.length));
  await cP.setOffline(false); await p.waitForTimeout(4000);
  console.log('após voltar online:', sql("select tipo, cat, qtd, un, jsonb_array_length(midias) from lancamentos order by criado_em"));
  console.log('modal online:', await p.locator('.modal .big').count() ? await p.textContent('.modal .big') : '-');
  // ---- administrador
  const [cA, a] = await nova();
  await a.goto(URL); await a.waitForSelector('#f-login'); await a.fill('#l-fone', '97 90000-0009'); await a.click('#f-login button'); await a.waitForSelector('#f-cad', { timeout: 15000 });
  await a.fill('#c-nome', 'Carlos Comprador'); await a.fill('#c-prop', 'Rede do Boi'); await a.selectOption('#c-mun', 'Apuí'); await a.click('#f-cad button[type=submit]'); await a.waitForSelector('.home-grid', { timeout: 15000 });
  sql("update perfis set admin=true where fone='5597900000009'");
  await a.reload(); await a.waitForSelector('#f-csenha', { timeout: 15000 }); await shot(a, '2-criar-senha');
  await a.fill('#cs-1', 'senha-forte-1'); await a.fill('#cs-2', 'senha-forte-1'); await a.click('#f-csenha button[type=submit]');
  await a.waitForSelector('.chips', { timeout: 15000 }); await a.waitForTimeout(800); await shot(a, '3-painel');
  console.log('painel itens:', await a.locator('.item').count(), 'sino:', await a.textContent('.bell'));
  await a.locator('[data-abrir]').last().click(); await a.waitForTimeout(800); await shot(a, '4-admlote');
  console.log('admin vê fotos:', await a.locator('[data-ver] img').count(), await a.locator('[data-ver] img').first().getAttribute('src'));
  await a.fill('#o-val', '305'); await a.fill('#o-txt', 'Faço 305.'); await a.click('#f-of button'); await a.waitForTimeout(1500);
  await a.selectOption('#s-st', 'fechado'); await a.fill('#s-val', '308'); await a.click('#f-st button'); await a.waitForTimeout(1500); await shot(a, '5-fechado');
  console.log('toast:', await a.textContent('#toast')); console.log('hist:', sql("select papel||':'||coalesce(autor_nome,'')||':'||texto from mensagens order by criado_em"));
  // banner
  await a.goto(URL); await a.waitForSelector('.chips'); await a.click('[data-a=admBanners]'); await a.click('[data-a=novoBanner]');
  await a.fill('#b-tit', 'Touros PO'); await a.setInputFiles('#b-img', 'FOTO_TOURO.jpg'); await a.waitForTimeout(500); await a.fill('#b-desc', 'Condição especial.');
  await a.click('#f-bn button[type=submit]'); await a.waitForTimeout(2000); console.log('banner:', sql("select titulo, img is not null, ativo from banners"));
  await a.goto(URL); await a.waitForSelector('.chips'); await a.click('[data-a=admVic]'); await a.waitForTimeout(500);
  console.log('sugestões:', await a.locator('[data-ok]').count()); if (await a.locator('[data-ok]').count()) { await a.locator('[data-ok]').first().click(); await a.waitForTimeout(1500); }
  console.log('vic tatu:', sql("select count(*) from vicinais where nome='Ramal do Tatu'"));
  await a.goto(URL); await a.waitForSelector('.chips'); await a.click('[data-a=relatorio]'); await a.waitForTimeout(500); await shot(a, '6-relatorio');
  // admin sai e entra de novo: precisa da senha
  await a.goto(URL); await a.waitForSelector('.chips'); await a.click('[data-a=sair]'); await a.click('#m-ok');
  await a.fill('#l-fone', '97900000009'); await a.click('#f-login button'); await a.waitForSelector('#f-senha', { timeout: 15000 }); console.log('pede senha: ok');
  await a.fill('#s-senha', 'senha-forte-1'); await a.click('#f-senha button'); await a.waitForSelector('.chips', { timeout: 15000 }); console.log('admin entrou de novo');
  // ---- produtor vê oferta + banner
  await p.goto(URL); await p.waitForSelector('.home-grid', { timeout: 15000 }); await p.waitForTimeout(1500); await shot(p, '7-inicio-banner');
  console.log('sino produtor:', await p.textContent('.bell'), 'banners:', await p.locator('.carousel .bn').count());
  await p.click('[data-a=avisos]'); await p.waitForTimeout(300); await shot(p, '8-avisos');
  await p.locator('[data-abrir]').first().click(); await p.waitForTimeout(800); await shot(p, '9-lote-fechado');
  await p.goto(URL); await p.waitForSelector('.carousel .bn'); await p.locator('.carousel .bn').first().click(); await p.click('[data-a=interesse]'); await p.waitForTimeout(1500);
  console.log('interesses:', sql("select count(*) from interesses"));
  // segurança: produtor tenta ver tudo pela API
  const tent = await p.evaluate(async () => { const r = await fetch('http://127.0.0.1:54321/rest/v1/perfis?select=nome', { headers: { apikey: window.RDB_CONFIG.supabaseKey, Authorization: 'Bearer ' + JSON.parse(localStorage.getItem('rdb-auth')).access_token } }); return r.json(); });
  console.log('produtor lista perfis via API:', JSON.stringify(tent));
  console.log('ERROS:', erros);
  await b.close();
})();

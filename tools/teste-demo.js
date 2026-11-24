const { chromium, devices } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ ...devices['Pixel 7'], deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  const erros = [];
  p.on('console', m => { if (m.type() === 'error') erros.push(m.text()); });
  p.on('pageerror', e => erros.push('PAGEERROR ' + e.message));
  const shot = n => p.screenshot({ path: `shots/${n}.png` });
  await p.goto('http://localhost:8080/');
  await p.waitForSelector('#f-login'); await shot('01-login');
  // novo produtor
  await p.fill('#l-fone', '(97) 91234-5678'); await p.click('#f-login button');
  await p.waitForSelector('#f-cad'); await shot('02-cadastro');
  await p.fill('#c-nome', 'Antônio Ferreira'); await p.fill('#c-prop', 'Fazenda Esperança'); await p.selectOption('#c-mun', 'Apuí');
  await p.click('#c-vic'); await p.fill('#c-vic', 'nova'); await shot('03-vicinal'); await p.fill('#c-vic', 'Ramal do Tatu'); await p.fill('#c-km', '22');
  await p.click('#f-cad button[type=submit]');
  await p.waitForSelector('.home-grid'); await p.waitForTimeout(400); await shot('04-inicio');
  // lançar venda online com foto
  await p.click('[data-a=lancar]'); await p.click('[data-tipo=venda]'); await p.click('[data-cat=boi_gordo]');
  await p.fill('#d-qtd', '30'); await p.fill('#d-peso', '540'); await p.selectOption('#d-un', 'kg'); await p.fill('#d-valor', '315');
  await p.setInputFiles('#d-file', 'ICON.jpg'); await p.waitForSelector('#d-media img'); await shot('05-lancar');
  await p.click('#f-lanc button[type=submit]');
  await p.waitForSelector('.modal'); await shot('06-aceito');
  console.log('modal:', await p.textContent('.modal .big'));
  await p.click('#m-ok');
  // offline
  await ctx.setOffline(true); await p.waitForTimeout(300);
  await p.click('[data-a=lancar]'); await p.click('[data-tipo=compra]'); await p.click('[data-cat=novilha]');
  await p.fill('#d-qtd', '15'); await p.fill('#d-peso', '9'); await p.fill('#d-valor', '280');
  await p.setInputFiles('#d-cam', 'ICON.jpg'); await p.waitForSelector('#d-media img');
  await p.click('#f-lanc button[type=submit]'); await p.waitForSelector('.modal'); await shot('07-offline-salvo');
  console.log('offline modal:', await p.textContent('.modal .big')); await p.click('#m-ok');
  await shot('08-meus-offline');
  // recarrega a página offline (app abre sem internet?)
  await p.reload(); await p.waitForTimeout(1200); await shot('09-reload-offline');
  console.log('após reload offline, itens:', await p.locator('.item').count(), 'tela:', await p.evaluate(() => document.getElementById('app').dataset.tela));
  await ctx.setOffline(false); await p.waitForTimeout(2500); await shot('10-voltou-online');
  console.log('online modal:', await p.locator('.modal .big').count() ? await p.textContent('.modal .big') : 'nenhum');
  console.log('fila:', await p.evaluate(() => window.__rdb.E.fila.length));
  if (await p.locator('#m-ok').count()) await p.click('#m-ok');
  // abrir lançamento e responder
  await p.goto('http://localhost:8080/'); await p.waitForSelector('.home-grid'); await p.click('[data-a=meus]'); await p.waitForTimeout(300);
  await p.locator('[data-abrir]').first().click(); await p.waitForTimeout(300); await shot('11-lote');
  await p.fill('#r-txt', 'Posso entregar na semana que vem.'); await p.click('#f-resp button'); await p.waitForTimeout(800); await shot('12-respondeu');
  // sair e entrar como admin
  await p.goto('http://localhost:8080/'); await p.waitForSelector('.home-grid'); await p.click('[data-a=meusDados]'); await p.click('[data-a=sair]'); await p.click('#m-ok');
  await p.fill('#l-fone', '97900000009'); await p.click('#f-login button'); await p.waitForSelector('#f-senha');
  await p.fill('#s-senha', 'errada'); await p.click('#f-senha button'); await p.waitForTimeout(300); console.log('toast:', await p.textContent('#toast'));
  await p.fill('#s-senha', 'boi123'); await p.click('#f-senha button'); await p.waitForSelector('.chips'); await p.waitForTimeout(500); await shot('13-admin');
  console.log('admin itens:', await p.locator('.item').count(), 'avisos:', await p.textContent('.bell'));
  await p.locator('[data-abrir]').first().click(); await p.waitForTimeout(300); await shot('14-admin-lote');
  await p.fill('#o-val', '305'); await p.fill('#o-txt', 'Faço 305 a arroba, busco na fazenda.'); await p.click('#f-of button'); await p.waitForTimeout(600);
  await p.selectOption('#s-st', 'visita'); await p.click('#f-st button'); await p.waitForTimeout(600); await shot('15-admin-oferta');
  if (await p.locator('[data-ver]').count()) { await p.locator('[data-ver]').first().click(); await p.waitForTimeout(300); await shot('16-visor'); await p.click('.vx'); }
  await p.goto('http://localhost:8080/'); await p.waitForSelector('.chips'); await p.click('[data-a=relatorio]'); await p.waitForTimeout(300); await shot('17-relatorio');
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('[data-a=baixarPlanilha]')]); console.log('planilha:', dl.suggestedFilename());
  await p.goto('http://localhost:8080/'); await p.waitForSelector('.chips'); await p.click('[data-a=admVic]'); await p.waitForTimeout(300); await shot('18-vicinais');
  console.log('sugestões:', await p.locator('[data-ok]').count());
  await p.goto('http://localhost:8080/'); await p.waitForSelector('.chips'); await p.click('[data-a=admProdutores]'); await p.waitForTimeout(300); await shot('19-produtores');
  await p.goto('http://localhost:8080/'); await p.waitForSelector('.chips'); await p.click('[data-a=admBanners]'); await p.waitForTimeout(300); await shot('20-banners');
  console.log('ERROS:', erros);
  await b.close();
})();

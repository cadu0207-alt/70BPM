#!/usr/bin/env node
// Teste de fumaça do painel — roda num navegador de verdade (Playwright) contra o próprio repositório.
// Cobre os bugs que já aconteceram de verdade (página que não abre, tabela que estoura no celular,
// dado sensível no site público, pop-up do SiGOp, perda da página ao recarregar). Uso:
//   npm test                 (verificar-publico + validate-data + este teste)
//   node tests/smoke.js      (só este; local usa o Chrome instalado, no GitHub usa o Chromium do Playwright)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const RAIZ = path.resolve(__dirname, '..');
const TIPOS = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.js': 'text/javascript', '.jpg': 'image/jpeg', '.png': 'image/png', '.css': 'text/css' };
const falhas = [];
const ok = (msg) => console.log('  ✔ ' + msg);
const falha = (msg) => { falhas.push(msg); console.log('  ✖ ' + msg); };
const checa = (cond, msgOk, msgFalha) => (cond ? ok(msgOk) : falha(msgFalha));

const servidor = http.createServer((req, res) => {
  const arq = path.join(RAIZ, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
  const alvo = fs.existsSync(arq) && fs.statSync(arq).isFile() ? arq : path.join(RAIZ, 'index.html');
  if (!alvo.startsWith(RAIZ)) { res.writeHead(403); return res.end(); }
  res.writeHead(200, { 'Content-Type': TIPOS[path.extname(alvo)] || 'application/octet-stream' });
  fs.createReadStream(alvo).pipe(res);
});

const hoje = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
// Só a nossa origem passa; fontes/CDN/Supabase são bloqueados (teste hermético, sem depender de rede)
const ERRO_IGNORADO = /Failed to load resource|net::ERR|ERR_FAILED|ERR_BLOCKED|supabase/i;

async function novoContexto(browser, opcoes, comGate) {
  const ctx = await browser.newContext(opcoes);
  if (!comGate) await ctx.addInitScript((h) => { try { localStorage.setItem('sigopAcessoDia', h); } catch (e) {} }, hoje());
  await ctx.route('**/*', (rota) => (rota.request().url().startsWith('http://127.0.0.1') ? rota.continue() : rota.abort()));
  return ctx;
}

// Auditoria de leitura (roda dentro da página): contraste real do texto (com transparência) e fonte mínima.
function auditar() {
  const parse = (s) => { const m = s.match(/[\d.]+/g).map(Number); return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 }; };
  const mistura = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
  const lum = (c) => { const f = [c.r, c.g, c.b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2]; };
  const fundo = (el) => {
    const cadeia = [];
    for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c.a > 0) cadeia.push(c); if (c.a >= 1) break; }
    let base = { r: 7, g: 12, b: 20, a: 1 };
    for (let i = cadeia.length - 1; i >= 0; i--) base = mistura(cadeia[i], base);
    return base;
  };
  const falhas = {}, fontes = {};
  const raiz = document.getElementById('main');
  raiz.querySelectorAll('*').forEach((el) => {
    const txt = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim()).join(' ');
    if (!txt) return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || el.getClientRects().length === 0) return;
    const fs = parseFloat(cs.fontSize);
    if (fs < 11) fontes[fs] = (fontes[fs] || 0) + 1;
    let fg = parse(cs.color); const bg = fundo(el); fg = mistura(fg, bg);
    const l1 = lum(fg), l2 = lum(bg), cr = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const grande = fs >= 24 || (fs >= 18.66 && parseInt(cs.fontWeight) >= 700);
    if (cr < (grande ? 3 : 4.5)) {
      const k = cs.color + '|' + [bg.r, bg.g, bg.b].map(Math.round).join(',') + '|' + fs;
      if (!falhas[k]) falhas[k] = { cr: +cr.toFixed(2), fs, cor: cs.color, bg: [bg.r, bg.g, bg.b].map(Math.round).join(','), ex: txt.slice(0, 28), n: 0 };
      falhas[k].n++;
    }
  });
  return { falhas: Object.values(falhas), fontes, estouroMain: raiz.scrollWidth > raiz.clientWidth + 1, estouroPagina: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 };
}

(async () => {
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + servidor.address().port + '/index.html';
  const browser = await chromium.launch(process.env.CI ? {} : { channel: 'chrome' });

  // ---------- 1) Todas as páginas, desktop ----------
  console.log('\n[1] Todas as páginas abrem sem erro (desktop 1280x800)');
  let ctx = await novoContexto(browser, { viewport: { width: 1280, height: 800 } });
  let page = await ctx.newPage();
  const erros = [];
  page.on('pageerror', (e) => erros.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !ERRO_IGNORADO.test(m.text())) erros.push('console: ' + m.text()); });
  await page.goto(base);
  await page.waitForFunction(() => typeof goToPage === 'function' && typeof pages === 'object');
  const chaves = await page.evaluate(() => Object.keys(pages));
  checa(chaves.length >= 20, `${chaves.length} páginas registradas`, `só ${chaves.length} páginas registradas (esperava ≥ 20)`);
  for (const k of chaves) {
    await page.evaluate((key) => goToPage(key), k);
    await page.waitForTimeout(k === 'violencia_domestica' || k === 'auditoria' ? 700 : 150);
    const vazio = await page.evaluate(() => document.getElementById('main').innerText.trim().length < 20);
    if (vazio) falha(`página "${k}" ficou em branco`);
  }
  checa(erros.length === 0, 'nenhum erro de JavaScript/console', 'erros: ' + erros.slice(0, 4).join(' | '));
  await ctx.close();

  // ---------- 2) Celular: sem estouro lateral, menu em gaveta ----------
  console.log('\n[2] Celular (375x812): sem rolagem lateral e menu em gaveta');
  ctx = await novoContexto(browser, { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  page = await ctx.newPage();
  await page.goto(base);
  await page.waitForFunction(() => typeof goToPage === 'function');
  const meta = await page.evaluate(() => !!document.querySelector('meta[name=viewport]'));
  checa(meta, 'meta viewport presente', 'falta <meta name="viewport">');
  const larg = await page.evaluate(() => window.innerWidth);
  checa(larg === 375, 'largura real do celular respeitada (375)', `innerWidth=${larg} (esperava 375 — página desenhada em tela maior)`);
  const estouros = [];
  for (const k of chaves) {
    await page.evaluate((key) => goToPage(key), k);
    await page.waitForTimeout(k === 'violencia_domestica' || k === 'auditoria' ? 700 : 120);
    const o = await page.evaluate(() => { const m = document.getElementById('main'); return Math.max(document.documentElement.scrollWidth - innerWidth, m.scrollWidth - m.clientWidth); });
    if (o > 2) estouros.push(`${k} (+${o}px)`);
  }
  checa(estouros.length === 0, 'nenhuma página estoura na lateral', 'estouram: ' + estouros.join(', '));
  const gaveta = await page.evaluate(async () => {
    const sb = document.getElementById('sidebar'), btn = document.getElementById('menuToggle');
    const escondida = sb.getBoundingClientRect().right <= 0;
    btn.click(); await new Promise((r) => setTimeout(r, 350));
    const aberta = document.body.classList.contains('nav-open') && sb.getBoundingClientRect().left >= 0;
    document.querySelector('.nav-btn[data-page="ppag"]').click(); await new Promise((r) => setTimeout(r, 350));
    return { escondida, aberta, fechouAoNavegar: !document.body.classList.contains('nav-open'), pagina: currentPageKey };
  });
  checa(gaveta.escondida && gaveta.aberta && gaveta.fechouAoNavegar && gaveta.pagina === 'ppag', 'menu: escondido, abre pelo ☰ e fecha ao navegar', 'menu em gaveta com defeito: ' + JSON.stringify(gaveta));
  await ctx.close();

  // ---------- 3) Privacidade: visitante anônimo não vê dado restrito ----------
  console.log('\n[3] Visitante anônimo: nada de REDS/endereço, só totais e aviso');
  ctx = await novoContexto(browser, { viewport: { width: 1280, height: 800 } });
  page = await ctx.newPage();
  await page.goto(base);
  await page.waitForFunction(() => typeof goToPage === 'function');
  const privac = await page.evaluate(async () => {
    const r = {};
    for (const [k, p] of [['analise_preditiva', 'apMuniPanel'], ['violencia_domestica', 'vdMuniPanel'], ['crimes_violentos', 'cvMuniPanel'], ['reincidencia', 'reMuniPanel']]) {
      goToPage(k); await new Promise((x) => setTimeout(x, 700));
      const el = document.getElementById(p);
      r[k] = { aviso: /detalhe restrito/i.test(el.innerText), reds: (document.getElementById('main').innerText.match(/20\d\d-\d{9}-\d{3}/g) || []).length, tabela: !!el.querySelector('table') };
    }
    r.restritoLiberado = ppvdDadosRestritosLiberados();
    r.textosQuebrados = (JSON.stringify(DATA).match(/[\u00c3\u00c2\u00e3\u00e2][\u0080-\u00bf]/g) || []).length; // acento quebrado (UTF-8 lido como latin-1)
    r.redsNaMemoria = (JSON.stringify(DATA).match(/20\d\d-\d{9}-\d{3}/g) || []).length; // o dado chegou ao navegador do visitante?
    return r;
  });
  const ruins = Object.entries(privac).filter(([k, v]) => v && typeof v === 'object' && (!v.aviso || v.reds > 0 || v.tabela)).map(([k]) => k);
  checa(ruins.length === 0 && privac.restritoLiberado === false, 'as 4 páginas mostram o aviso e nenhum REDS', 'vazamento/ausência do aviso em: ' + ruins.join(', '));
  checa(privac.textosQuebrados === 0, 'nenhum texto com acento quebrado nos dados públicos', `${privac.textosQuebrados} texto(s) com acento quebrado nos dados`);
  checa(privac.redsNaMemoria === 0, 'nenhum nº de REDS chega ao navegador do visitante (data.json público limpo)', `${privac.redsNaMemoria} nº(s) de REDS chegaram ao navegador de um visitante anônimo`);
  await ctx.close();

  // ---------- 4) Pop-up diário do SiGOp ----------
  console.log('\n[4] Pop-up de acesso diário ao SiGOp');
  ctx = await novoContexto(browser, { viewport: { width: 1280, height: 800 } }, true);
  page = await ctx.newPage();
  await page.goto(base);
  await page.waitForSelector('#sigopGate', { timeout: 5000 }).then(() => ok('aparece no 1º acesso do dia'), () => falha('pop-up não apareceu no 1º acesso'));
  await page.evaluate(() => document.getElementById('sigopGateLink').addEventListener('click', (e) => e.preventDefault()));
  await page.click('#sigopGateLink');
  const apos = await page.evaluate(() => ({ some: !document.getElementById('sigopGate'), gravou: localStorage.getItem('sigopAcessoDia') }));
  checa(apos.some && apos.gravou === hoje(), 'clique fecha o pop-up e grava o dia', 'clique não liberou: ' + JSON.stringify(apos));
  await page.reload();
  await page.waitForFunction(() => typeof goToPage === 'function');
  checa(!(await page.$('#sigopGate')), 'não reaparece no mesmo dia', 'pop-up reapareceu no mesmo dia');
  await ctx.close();

  // ---------- 5) Recarregar volta pra mesma página ----------
  console.log('\n[5] Recarregar a aba não perde a página');
  ctx = await novoContexto(browser, { viewport: { width: 1280, height: 800 } });
  page = await ctx.newPage();
  await page.goto(base);
  await page.waitForFunction(() => typeof goToPage === 'function');
  await page.evaluate(() => goToPage('rolezinho'));
  await page.reload();
  await page.waitForFunction(() => typeof goToPage === 'function');
  await page.waitForTimeout(300);
  const aposReload = await page.evaluate(() => currentPageKey);
  checa(aposReload === 'rolezinho', 'volta para "rolezinho" depois do reload', `voltou para "${aposReload}" (esperava rolezinho)`);
  await ctx.close();

  // ---------- 6) Home: quadro de cumprimento ----------
  console.log('\n[6] Home: quadro de cumprimento por cidade');
  ctx = await novoContexto(browser, { viewport: { width: 1280, height: 800 } });
  page = await ctx.newPage();
  await page.goto(base);
  await page.waitForFunction(() => typeof goToPage === 'function');
  await page.evaluate(() => goToPage('home'));
  await page.waitForTimeout(300);
  const home = await page.evaluate(() => {
    const h3 = Array.from(document.querySelectorAll('#main h3')).find((h) => h.textContent.includes('Quadro de Cumprimento'));
    return { linhas: h3 ? h3.closest('.chart-box').querySelectorAll('tbody tr').length : -1, kpis: document.querySelectorAll('#main .kpi-card').length, status: (document.getElementById('statusDadosTxt') || {}).textContent,
      kpisHome: document.querySelectorAll('#main .kpi-grid-home .kpi-card').length, mainTag: (document.getElementById('main') || {}).tagName, navTag: (document.getElementById('sidebar') || {}).tagName,
      h1: document.querySelectorAll('#main [role=heading][aria-level="1"]').length, filtroRotulo: (document.getElementById('munFiltroGlobal') || {}).ariaLabel };
  });
  checa(home.linhas === 13 && home.kpis >= 4, `quadro com 13 municípios e ${home.kpis} KPIs`, 'Home incompleta: ' + JSON.stringify(home));
  checa(!!home.status && !/Verificando/.test(home.status), `indicador de atualização calculado ("${home.status}")`, 'indicador de atualização não foi calculado');
  checa(home.kpisHome === 9, 'Home com os 9 cartões de KPI num grid só', `Home com ${home.kpisHome} cartões no grid (esperava 9)`);
  checa(home.mainTag === 'MAIN' && home.navTag === 'NAV', 'páginas com <main> e <nav> (leitor de tela)', `marcos de página: main=${home.mainTag} nav=${home.navTag}`);
  checa(home.h1 === 1, 'a página tem exatamente 1 título nível 1', `títulos nível 1 na página: ${home.h1}`);
  checa(!!home.filtroRotulo, 'filtro de município com rótulo', 'filtro de município sem rótulo (aria-label)');
  await ctx.close();

  // ---------- 7) Legibilidade: contraste >= 4,5:1 e fonte >= 11px em todas as páginas ----------
  console.log('\n[7] Legibilidade: contraste e tamanho de fonte (desktop, todas as páginas)');
  ctx = await novoContexto(browser, { viewport: { width: 1280, height: 800 } });
  page = await ctx.newPage();
  await page.goto(base);
  await page.waitForFunction(() => typeof goToPage === 'function' && typeof pages === 'object');
  const problemasLeitura = [];
  for (const k of await page.evaluate(() => Object.keys(pages))) {
    await page.evaluate((key) => goToPage(key), k);
    await page.waitForTimeout(200);
    const r = await page.evaluate(auditar);
    r.falhas.forEach((f) => problemasLeitura.push(`${k}: contraste ${f.cr}:1 (${f.fs}px) "${f.ex}"`));
    Object.entries(r.fontes).forEach(([fs, n]) => problemasLeitura.push(`${k}: ${n} texto(s) com ${fs}px (mínimo 11px)`));
  }
  checa(problemasLeitura.length === 0, 'nenhum texto com contraste baixo ou fonte menor que 11px', 'legibilidade: ' + problemasLeitura.slice(0, 4).join(' | '));
  await ctx.close();

  await browser.close();
  servidor.close();
  console.log('\n' + (falhas.length ? `✖ ${falhas.length} FALHA(S)` : '✔ TUDO CERTO'));
  process.exit(falhas.length ? 1 : 0);
})().catch((e) => { console.error('ERRO NO TESTE:', e); process.exit(2); });

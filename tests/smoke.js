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
    const h3 = Array.from(document.querySelectorAll('#main h3')).find((h) => /quadro de cumprimento/i.test(h.textContent));
    return { linhas: h3 ? h3.closest('.chart-box').querySelector('table tbody').querySelectorAll('tr').length : -1, kpis: document.querySelectorAll('#main .kpi-card').length, status: (document.getElementById('statusDadosTxt') || {}).textContent,
      kpisHome: document.querySelectorAll('#main .kpi-grid-home .kpi-card').length, mainTag: (document.getElementById('main') || {}).tagName, navTag: (document.getElementById('sidebar') || {}).tagName,
      h1: document.querySelectorAll('#main [role=heading][aria-level="1"]').length, filtroRotulo: (document.getElementById('munFiltroGlobal') || {}).ariaLabel };
  });
  checa(home.linhas === 14 && home.kpis >= 4, `quadro com 13 municípios + linha do batalhão e ${home.kpis} KPIs`, 'Home incompleta: ' + JSON.stringify(home));
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

  // ---------- 8) Semáforo dos casos de Violência Doméstica (vermelho / amarelo / azul / verde) ----------
  console.log('\n[8] Semáforo dos casos de Violência Doméstica');
  ctx = await novoContexto(browser, { viewport: { width: 1280, height: 800 } });
  page = await ctx.newPage();
  await page.goto(base);
  await page.waitForFunction(() => typeof ppvdSemaforoVD === 'function');
  const horas = (h) => new Date(Date.now() - h * 3600000).toISOString();
  const casos = [
    ['sem caso (novo)', null, 'vermelho'],
    ['aberto', { status: 'aberto' }, 'vermelho'],
    ['1ª visita despachada (sem data conhecida)', { status: 'em_visita', qtd_retornos: 0 }, 'amarelo'],
    ['1ª visita despachada há 10h', { status: 'em_visita', qtd_retornos: 0, _pendenteDesde: horas(10) }, 'amarelo'],
    ['1ª visita despachada há 100h sem resposta (atrasada)', { status: 'em_visita', qtd_retornos: 0, _pendenteDesde: horas(100) }, 'vermelho'],
    ['atendimento iniciado (decisão do comandante)', { status: 'decisao_cmd', qtd_retornos: 0 }, 'amarelo'],
    ['comandante decidiu mais visitas, retorno feito', { status: 'decisao_cmd', qtd_retornos: 1 }, 'azul'],
    ['retorno despachado há 10h (dentro do prazo)', { status: 'em_visita', qtd_retornos: 1, _pendenteDesde: horas(10) }, 'azul'],
    ['retorno despachado há 100h (atrasado)', { status: 'em_visita', qtd_retornos: 2, _pendenteDesde: horas(100) }, 'vermelho'],
    ['status "em acompanhamento"', { status: 'em_acompanhamento' }, 'azul'],
    ['estabilizado (mesmo com retornos)', { status: 'estabilizada', qtd_retornos: 3 }, 'verde'],
  ];
  const obtido = await page.evaluate((lista) => lista.map(([, c]) => ppvdSemaforoVD(c)), casos);
  casos.forEach(([nome, , esperado], i) => checa(obtido[i] === esperado, `${nome} → ${esperado}`, `${nome}: esperava ${esperado}, deu ${obtido[i]}`));
  await ctx.close();

  // ---------- 9) Recarregar a aba mantém filtro e rolagem da página ----------
  console.log('\n[9] Recarregar a aba mantém o seletor (mês/período) e a rolagem');
  ctx = await novoContexto(browser, { viewport: { width: 1280, height: 800 } });
  page = await ctx.newPage();
  await page.goto(base);
  await page.waitForFunction(() => typeof goToPage === 'function' && typeof pages === 'object');
  await page.evaluate(() => goToPage('rolezinho'));
  await page.waitForTimeout(300);
  const antes = await page.evaluate(() => {
    const sel = document.querySelector('#main select.month-select');
    if (!sel || sel.options.length < 2) return null;
    sel.value = sel.options[1].value; sel.dispatchEvent(new Event('change', { bubbles: true }));
    return { id: sel.id, valor: sel.value };
  });
  checa(!!antes, 'página com seletor de mês encontrada', 'não achei seletor de mês na página de teste');
  if (antes) {
    await page.hover('#main'); await page.mouse.wheel(0, 250); await page.waitForTimeout(400);
    const rolouAntes = await page.evaluate(() => Math.round(document.getElementById('main').scrollTop));
    await page.reload();
    await page.waitForFunction(() => typeof goToPage === 'function');
    await page.waitForTimeout(800);
    const depois = await page.evaluate((id) => ({ valor: (document.getElementById(id) || {}).value, rolagem: Math.round(document.getElementById('main').scrollTop) }), antes.id);
    checa(depois.valor === antes.valor, 'seletor continua no mesmo mês depois do reload', `seletor voltou para "${depois.valor}" (era "${antes.valor}")`);
    checa(rolouAntes === 0 || Math.abs(depois.rolagem - rolouAntes) <= 3, `rolagem restaurada (${rolouAntes}px → ${depois.rolagem}px)`, `rolagem não voltou: era ${rolouAntes}px, ficou ${depois.rolagem}px`);
    // navegar pelo menu começa limpo
    await page.evaluate(() => goToPage('home')); await page.evaluate(() => goToPage('rolezinho')); await page.waitForTimeout(300);
    const limpo = await page.evaluate((id) => (document.getElementById(id) || {}).selectedIndex, antes.id);
    checa(limpo !== undefined, 'navegar pelo menu abre a página normalmente', 'página não abriu depois de navegar pelo menu');
  }
  await ctx.close();

  // ---------- 10) Apresentação de GDO: gera o .pptx do mês ----------
  console.log('\n[10] Apresentação de GDO pronta (.pptx)');
  {
    const ctxG = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    await ctxG.addInitScript((h) => { try { localStorage.setItem('sigopAcessoDia', h); } catch (e) {} }, hoje());
    await ctxG.route('**/*', (rota) => {
      const u = rota.request().url();
      if (u.includes('pptxgenjs')) return rota.fulfill({ path: path.join(RAIZ, 'node_modules', 'pptxgenjs', 'dist', 'pptxgen.bundle.js'), contentType: 'text/javascript' });
      return u.startsWith('http://127.0.0.1') ? rota.continue() : rota.abort();
    });
    const pg = await ctxG.newPage();
    const errosG = [];
    pg.on('pageerror', (e) => errosG.push(e.message));
    await pg.goto(base);
    await pg.waitForFunction(() => typeof goToPage === 'function');
    await pg.evaluate(() => goToPage('apresentacao_gdo'));
    await pg.waitForSelector('#gdoGerar');
    const [dl] = await Promise.all([pg.waitForEvent('download', { timeout: 60000 }), pg.click('#gdoGerar')]);
    const tmp = path.join(require('os').tmpdir(), 'gdo-smoke-' + Date.now() + '.pptx');
    await dl.saveAs(tmp);
    const bytes = fs.readFileSync(tmp);
    // .pptx é um zip: confere pelo diretório central quantos slides tem (sem dependência extra)
    const slides = (bytes.toString('latin1').match(/ppt\/slides\/slide\d+\.xml/g) || []).filter((v, i, a) => a.indexOf(v) === i).length;
    fs.unlinkSync(tmp);
    checa(/\.pptx$/.test(dl.suggestedFilename()), `arquivo baixado: ${dl.suggestedFilename()}`, 'o download não é um .pptx');
    checa(slides >= 20, `apresentação com ${slides} slides`, `apresentação com só ${slides} slides (esperava ≥ 20)`);
    checa(errosG.length === 0, 'gerou sem erro de JavaScript', 'erros ao gerar: ' + errosG.slice(0, 3).join(' | '));
    await ctxG.close();
  }

  // ---------- 11) Menu novo: grupos, busca, selos, município em botões, "Atenção agora" e abas do celular ----------
  console.log('\n[11] Menu novo, município em botões e Atenção agora');
  {
    const ctxM = await novoContexto(browser, { viewport: { width: 1280, height: 800 } });
    const pg = await ctxM.newPage();
    const errosM = [];
    pg.on('pageerror', (e) => errosM.push(e.message));
    pg.on('console', (m) => { if (m.type() === 'error' && !ERRO_IGNORADO.test(m.text())) errosM.push(m.text()); });
    await pg.goto(base);
    await pg.waitForFunction(() => typeof goToPage === 'function' && document.querySelectorAll('.nav-group').length > 0);
    await pg.evaluate(() => goToPage('home'));
    await pg.waitForTimeout(300);
    const m1 = await pg.evaluate(() => ({
      grupos: document.querySelectorAll('.sidebar .nav-group').length,
      selos: [...document.querySelectorAll('.sidebar [data-bd]')].filter(e => !e.hidden).length,
      chips: document.querySelectorAll('#main .atencao .atn-item').length,
      pilulas: document.querySelectorAll('#munStrip .pill-mun').length,
    }));
    checa(m1.grupos === 6, '6 grupos no menu', `grupos no menu: ${m1.grupos}`);
    checa(m1.selos >= 12, `${m1.selos} indicadores com selo de cidades fora da meta`, `só ${m1.selos} selos no menu`);
    checa(m1.pilulas === 14, 'município em 14 botões (Todos + 13)', `botões de município: ${m1.pilulas}`);
    // grupo abre/fecha e a escolha é lembrada
    const g = await pg.evaluate(() => { const l = document.querySelector('.nav-group[data-grupo="outros"] .nav-group-label'); const antes = l.parentElement.classList.contains('aberto'); l.click(); return { antes, depois: l.parentElement.classList.contains('aberto'), salvo: JSON.parse(localStorage.getItem('menuGrupos70bpm') || '{}').outros }; });
    checa(g.antes !== g.depois && g.salvo === g.depois, 'grupo do menu abre/fecha e lembra a escolha', 'grupo não alternou ou não lembrou');
    // busca
    const b = await pg.evaluate(() => { const i = document.getElementById('menuBusca'); i.value = 'furto'; i.dispatchEvent(new Event('input')); return [...document.querySelectorAll('.sidebar .nav-btn')].filter(x => !x.hidden).map(x => x.dataset.page); });
    checa(b.includes('furto') && b.includes('esforco_furto') && !b.includes('pog'), `busca "furto" mostra: ${b.join(', ')}`, `busca "furto" devolveu: ${b.join(', ')}`);
    await pg.evaluate(() => { const i = document.getElementById('menuBusca'); i.value = ''; i.dispatchEvent(new Event('input')); });
    // município em botão filtra e acompanha
    const p1 = await pg.evaluate(() => { document.querySelector('#munStrip .pill-mun[data-m="Itaobim"]').click(); return { filtro: getMunFiltro(), on: document.querySelector('#munStrip .pill-mun.on').dataset.m, sel: document.getElementById('munFiltroGlobal').value }; });
    checa(p1.filtro === 'Itaobim' && p1.on === 'Itaobim' && p1.sel === 'Itaobim', 'botão do município filtra e o seletor escondido acompanha', 'botão de município não sincronizou: ' + JSON.stringify(p1));
    // chip da Atenção agora abre a página do indicador já filtrada
    await pg.evaluate(() => { setMunFiltro(''); goToPage('home'); });
    await pg.waitForTimeout(300);
    const c = await pg.evaluate(() => { const ch = document.querySelector('#main .atencao .atn-item'); if (!ch) return null; const alvo = { pg: ch.dataset.pg, mun: ch.dataset.mun }; ch.click(); return Object.assign(alvo, { pagina: currentPageKey, filtro: getMunFiltro(), ativo: (document.querySelector('.sidebar .nav-btn.active') || {}).dataset && document.querySelector('.sidebar .nav-btn.active').dataset.page }); });
    checa(!c || (c.pagina === c.pg && c.filtro === c.mun && c.ativo === c.pg), c ? `chip abre ${c.pg} filtrado em ${c.mun} e marca o item do menu` : 'sem itens em atenção (nada a clicar)', 'chip não levou à página certa: ' + JSON.stringify(c));
    checa(errosM.length === 0, 'menu novo sem erro de JavaScript', 'erros: ' + errosM.slice(0, 3).join(' | '));
    await ctxM.close();

    // celular: barra de abas + folha
    const ctxC = await novoContexto(browser, { viewport: { width: 375, height: 812 } });
    const pc = await ctxC.newPage();
    await pc.goto(base);
    await pc.waitForFunction(() => typeof goToPage === 'function' && document.getElementById('tabbar'));
    await pc.waitForTimeout(300);
    const t = await pc.evaluate(() => { const bar = document.getElementById('tabbar'); return { visivel: getComputedStyle(bar).display !== 'none', abas: bar.querySelectorAll('.tab').length }; });
    checa(t.visivel && t.abas === 5, 'celular: barra de 5 abas no rodapé', `barra de abas: ${JSON.stringify(t)}`);
    await pc.click('#tabbar .tab[data-tab="operacoes"]');
    const f = await pc.evaluate(() => ({ aberta: document.getElementById('folha').classList.contains('on'), itens: document.querySelectorAll('#folhaBox .nav-btn').length }));
    checa(f.aberta && f.itens >= 7, `aba Operações abre a folha com ${f.itens} itens`, 'folha de itens não abriu: ' + JSON.stringify(f));
    await pc.click('#folhaBox .nav-btn[data-page="pog"]');
    await pc.waitForTimeout(200);
    const nav = await pc.evaluate(() => ({ pagina: currentPageKey, fechada: !document.getElementById('folha').classList.contains('on') }));
    checa(nav.pagina === 'pog' && nav.fechada, 'item da folha abre a página e fecha a folha', 'navegação pela folha falhou: ' + JSON.stringify(nav));
    const estouro = await pc.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    checa(!estouro, 'celular sem rolagem lateral com a faixa de municípios', 'a página estoura na lateral no celular');
    await ctxC.close();
  }

  // ---------- 12) Voltar pra aba (evento de sessão do Supabase) não refaz a tela ----------
  console.log('\n[12] Voltar de outra aba não refaz a tela nem derruba o perfil');
  {
    const ctxS = await novoContexto(browser, { viewport: { width: 1280, height: 800 } });
    const ps = await ctxS.newPage();
    await ps.goto(base);
    await ps.waitForFunction(() => typeof ppvdOnSession === 'function');
    const r = await ps.evaluate(async () => {
      const perfil = { user_id: 'u1', aprovado: true, is_admin: false, nome: 'Teste', cargo: 'Cmt', cidade: 'Araçuaí' };
      let falhaRede = false;
      const cadeia = () => { const o = { select: () => o, eq: () => o, order: () => o, limit: () => o, is: () => o, in: () => o, neq: () => o, maybeSingle: () => o, single: () => o,
        then: (ok) => ok(falhaRede ? { data: null, error: { message: 'Failed to fetch' }, count: null } : { data: perfil, error: null, count: 0 }) }; return o; };
      ppvdSupa = { from: () => cadeia(), auth: { getSession: async () => ({ data: { session: null } }), onAuthStateChange: () => {} } };
      ppvdUser = { id: 'u1' }; ppvdPerfil = perfil; ppvdRestritoCarregado = true; ppvdCaseRestoreTentado = true;
      let renders = 0; const orig = pages.violencia_domestica; pages.violencia_domestica = () => { renders++; };
      currentPageKey = 'violencia_domestica';
      ppvdRenderAuthWidget(); let widgetMut = 0;
      new MutationObserver((l) => { widgetMut += l.length; }).observe(document.getElementById('ppvdAuthWidget'), { childList: true, subtree: true });
      const out = {};
      await ppvdOnSession({ user: { id: 'u1' } }, 'SIGNED_IN'); out.signedIn = renders;
      await ppvdOnSession({ user: { id: 'u1' } }, 'TOKEN_REFRESHED'); out.tokenRefreshed = renders;
      await ppvdOnSession({ user: { id: 'u1' } }, 'INITIAL_SESSION'); out.initial = renders;
      await new Promise((ok) => setTimeout(ok, 50)); out.widget = widgetMut;
      falhaRede = true;
      await ppvdOnSession({ user: { id: 'u1' } }, 'SIGNED_IN'); out.semRede = renders; out.perfilMantido = !!ppvdPerfil && ppvdPerfil.aprovado === true;
      falhaRede = false;
      await ppvdOnSession(null, 'SIGNED_OUT'); out.signedOut = renders; // sair de verdade continua refazendo a tela
      pages.violencia_domestica = orig;
      return out;
    });
    checa(r.signedIn === 0 && r.tokenRefreshed === 0 && r.initial === 0, 'SIGNED_IN, TOKEN_REFRESHED e INITIAL_SESSION da mesma sessão não refazem a tela', 'a tela foi refeita ao voltar pra aba: ' + JSON.stringify(r));
    checa(r.widget === 0, 'os botões do topo (login/mensagens) não piscam ao voltar pra aba', 'o widget de login foi refeito ao voltar: ' + JSON.stringify(r));
    checa(r.semRede === 0 && r.perfilMantido, 'falha de rede ao voltar mantém o perfil e a tela', 'sem rede derrubou o perfil/tela: ' + JSON.stringify(r));
    checa(r.signedOut === 1, 'sair da conta (SIGNED_OUT) ainda refaz a tela', 'SIGNED_OUT não refez a tela: ' + JSON.stringify(r));
    await ctxS.close();
  }

  // ---------- 13) Home (onda 1): KPIs coerentes com o quadro, colunas novas, total do batalhão, legenda única ----------
  console.log('\n[13] Home: KPIs coerentes com o quadro e quadro completo');
  {
    const ctxH = await novoContexto(browser, { viewport: { width: 1280, height: 900 } });
    const ph = await ctxH.newPage();
    await ph.goto(base);
    await ph.waitForFunction(() => typeof goToPage === 'function');
    await ph.evaluate(() => goToPage('home'));
    await ph.waitForTimeout(300);
    const h = await ph.evaluate(() => {
      const cabec = [...document.querySelectorAll('#main .quadro-unico table thead th')].slice(0, 17).map(t => t.textContent.trim());
      const acum = document.querySelector('#main .quadro-unico [data-painel="acum"]');
      const idx = (nome) => cabec.indexOf(nome);
      const totalAcum = acum ? [...acum.querySelectorAll('tbody tr.linha-total td')] : [];
      const cor = (td) => (td && /rgba\(([^)]*)\)/.exec(td.getAttribute('style') || '') || [])[1] || '';
      const kpi = (rotulo) => [...document.querySelectorAll('#main .kpi-grid-home .kpi-card')].find(k => k.textContent.toUpperCase().includes(rotulo));
      const classeKpi = (k) => (k ? ['kpi-green', 'kpi-amber', 'kpi-red'].find(c => k.classList.contains(c)) : null);
      const corDe = (td) => (/230,72,79/.test(cor(td)) ? 'kpi-red' : (/212,194,42/.test(cor(td)) ? 'kpi-amber' : 'kpi-green'));
      return {
        colunas: cabec.length, temArmas: idx('Armas') > 0, temPrisoes: idx('Prisões furto') > 0, temRolez: idx('Rolezinho') > 0,
        totalLinhas: totalAcum.length, legendas: [...document.querySelectorAll('#main .updated')].filter(e => /Verde \S+ = cumpriu a meta · Amarelo/.test(e.textContent)).length,
        posicao: !!document.querySelector('#main .posicao-dados'), fontes: !!document.querySelector('#main details.fontes-home'),
        pogKpi: classeKpi(kpi('POG ACUM')), pogQuadro: totalAcum.length ? corDe(totalAcum[idx('POG')]) : null,
        armasKpi: classeKpi(kpi('ARMAS')), armasQuadro: totalAcum.length ? corDe(totalAcum[idx('Armas')]) : null,
        padKpi: classeKpi(kpi('PAD. ESCOLAR')), padQuadro: totalAcum.length ? corDe(totalAcum[idx('Pad.Escolar')]) : null,
        saqueKpi: classeKpi(kpi('SAQUE')), saqueQuadro: totalAcum.length ? corDe(totalAcum[idx('Saque Seguro')]) : null,
      };
    });
    checa(h.temArmas && h.temPrisoes && h.temRolez && h.colunas >= 17, `quadro com Armas, Prisões de furto e Rolezinho (${h.colunas} colunas)`, 'faltam colunas no quadro: ' + JSON.stringify(h));
    checa(h.totalLinhas > 0, 'quadro com a linha do 70º BPM', 'sem linha de total do batalhão no quadro');
    checa(h.legendas === 1, 'uma legenda só para os dois quadros', `legendas encontradas: ${h.legendas}`);
    checa(h.posicao && h.fontes, 'linha de posição dos dados e fontes recolhidas', 'faltou a posição dos dados ou o bloco de fontes');
    for (const [nome, k, q] of [['POG', h.pogKpi, h.pogQuadro], ['Armas', h.armasKpi, h.armasQuadro], ['Padrinhos', h.padKpi, h.padQuadro], ['Saque Seguro', h.saqueKpi, h.saqueQuadro]]) {
      checa(!!k && k === q, `cartão de ${nome} com a mesma cor do total no quadro (${k})`, `cartão de ${nome} (${k}) diverge do quadro (${q})`);
    }
    await ctxH.close();
  }

  // ---------- 14) Home, onda 2: Atenção por cidade, abas do quadro, células clicáveis, ranking ao lado, mini-gráficos ----------
  console.log('\n[14] Home: Atenção por cidade, quadro com abas e cliques, ranking ao lado dos KPIs');
  {
    const ctx2 = await novoContexto(browser, { viewport: { width: 1440, height: 900 } });
    const p2 = await ctx2.newPage();
    const erros2 = []; p2.on('pageerror', (e) => erros2.push(e.message));
    await p2.goto(base);
    await p2.waitForFunction(() => typeof goToPage === 'function');
    await p2.evaluate(() => { localStorage.removeItem('homeAbaQuadro'); goToPage('home'); });
    await p2.waitForTimeout(400);
    const a = await p2.evaluate(() => {
      const r = (sel) => { const e = document.querySelector(sel); return e ? e.getBoundingClientRect() : null; };
      const kpi = r('#main .kpi-grid-home'), rank = r('#main .rank-lateral');
      return {
        cidades: document.querySelectorAll('#main .atn-cidade:not([hidden])').length, extras: document.querySelectorAll('#main .atn-extra').length,
        sparks: document.querySelectorAll('#main .kpi-grid-home .spark').length,
        lado: !!(kpi && rank && rank.left > kpi.right - 5 && rank.top < kpi.bottom),
        quadros: document.querySelectorAll('#main .quadro-unico [data-painel]').length,
        visiveis: [...document.querySelectorAll('#main .quadro-unico [data-painel]')].filter(x => !x.hidden).map(x => x.dataset.painel),
      };
    });
    checa(a.cidades >= 1 && a.cidades <= 6, `Atenção agora em cartões por cidade (${a.cidades} visíveis, ${a.extras} escondidas)`, 'cartões por cidade: ' + JSON.stringify(a));
    checa(a.sparks === 9, 'os 9 cartões de KPI têm mini-gráfico', `mini-gráficos: ${a.sparks}`);
    checa(a.lado, 'ranking ao lado dos KPIs', 'o ranking não ficou ao lado dos KPIs');
    checa(a.quadros === 2 && a.visiveis.length === 1, `quadro único com 2 abas (visível: ${a.visiveis.join()})`, 'quadro de cumprimento fora do formato de abas: ' + JSON.stringify(a));
    // aba acumulado + persistência
    await p2.click('#main .aba[data-aba="acum"]');
    const b = await p2.evaluate(() => ({ visivel: [...document.querySelectorAll('#main .quadro-unico [data-painel]')].filter(x => !x.hidden).map(x => x.dataset.painel).join(), salvo: localStorage.getItem('homeAbaQuadro') }));
    checa(b.visivel === 'acum' && b.salvo === 'acum', 'aba Acumulado abre e fica lembrada', 'aba Acumulado: ' + JSON.stringify(b));
    // célula clicável abre o indicador filtrado na cidade
    const c = await p2.evaluate(() => {
      const td = document.querySelector('#main .quadro-unico [data-painel="acum"] tbody tr:not(.linha-total) td:nth-child(8)'); // POG
      const cidade = td.parentElement.firstElementChild.textContent.trim();
      td.click();
      return { cidade, pagina: currentPageKey, filtro: getMunFiltro() };
    });
    checa(c.pagina === 'pog' && c.filtro.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase() === c.cidade.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase(), `célula do POG abre a página POG filtrada em ${c.cidade}`, 'clique na célula: ' + JSON.stringify(c));
    // cabeçalho abre o indicador sem filtro de cidade novo
    await p2.evaluate(() => { setMunFiltro(''); goToPage('home'); });
    await p2.waitForTimeout(300);
    const d = await p2.evaluate(() => { document.querySelector('#main .quadro-unico table thead th[data-pg="cvpe"]').click(); return currentPageKey; });
    checa(d === 'cvpe', 'cabeçalho da coluna abre a página do indicador', `cabeçalho abriu "${d}"`);
    checa(erros2.length === 0, 'Home sem erro de JavaScript', 'erros: ' + erros2.slice(0, 3).join(' | '));
    await ctx2.close();
  }

  // ---------- 15) Home, onda 3: atalhos fixos, GDO/PDF e cartão de Violência Doméstica ----------
  console.log('\n[15] Home: atalhos, GDO/PDF e cartão de Violência Doméstica');
  {
    const ctx3 = await novoContexto(browser, { viewport: { width: 1440, height: 900 } });
    const p3 = await ctx3.newPage();
    const erros3 = []; p3.on('pageerror', (e) => erros3.push(e.message));
    await p3.goto(base);
    await p3.waitForFunction(() => typeof goToPage === 'function');
    await p3.evaluate(() => goToPage('home'));
    await p3.waitForTimeout(300);
    const a = await p3.evaluate(() => ({ atalhos: [...document.querySelectorAll('#homeBarra .atalho:not([hidden])')].map(x => x.dataset.alvo), vdEscondido: document.getElementById('homeVD').hidden, tem: !!document.getElementById('homePdf') && !!document.getElementById('homeGdo') }));
    checa(a.atalhos.length === 3 && a.tem, `barra fixa com ${a.atalhos.length} atalhos e botões de GDO e PDF`, 'barra da Home incompleta: ' + JSON.stringify(a));
    checa(a.vdEscondido, 'visitante anônimo não vê o cartão de Violência Doméstica', 'o cartão de VD apareceu para anônimo');
    const s1 = await p3.evaluate(() => { document.querySelector('#homeBarra .atalho[data-alvo="home-quadro"]').click(); return new Promise(r => setTimeout(() => r(Math.round(document.getElementById('main').scrollTop)), 900)); });
    checa(s1 > 300, `atalho "Quadro por cidade" rola a página (${s1}px)`, 'o atalho não rolou a página');
    const pdf = await p3.evaluate(() => { let chamou = false; const o = window.print; window.print = () => { chamou = true; }; document.getElementById('homePdf').click(); window.print = o; return chamou; });
    checa(pdf, 'botão Imprimir / PDF chama a impressão', 'o botão de PDF não chamou window.print');
    // cartão de VD com um cliente de mentira (PPVD aprovado, 5 casos nos 4 estados)
    const vd = await p3.evaluate(async () => {
      ppvdSupa = {}; ppvdUser = { id: 'u1' }; ppvdPerfil = { aprovado: true, is_admin: false, nome: 'T', cargo: 'C', cidade: 'Araçuaí' }; ppvdRestritoCarregado = true;
      const agora = Date.now(), h = (x) => new Date(agora - x * 3600000).toISOString();
      DATA.violencia_domestica.ocorrencias = { 'Araçuaí': [{ r: 'R1', m: 9 }, { r: 'R2', m: 9 }, { r: 'R3', m: 10 }, { r: 'R4', m: 10 }, { r: 'R5', m: 10 }, { r: 'R0', m: 3 }] };
      ppvdBuscarCasosVD = async () => ({ R1: { status: 'estabilizada' }, R2: { status: 'decisao_cmd', qtd_retornos: 1 }, R3: { status: 'em_visita', qtd_retornos: 0, _pendenteDesde: h(10) }, R4: { status: 'em_visita', qtd_retornos: 0, _pendenteDesde: h(100) } });
      await homeVdCarregar();
      const el = document.getElementById('homeVD');
      return { visivel: !el.hidden, atalho: !document.querySelector('#homeBarra .atalho[data-alvo="homeVD"]').hidden, n: [...el.querySelectorAll('.vd-cont .n')].map(x => x.textContent), cidade: !!el.querySelector('.vd-cidades button') };
    });
    // R1 verde, R2 azul (retorno), R3 amarelo (1ª visita no prazo), R4 vermelho (atrasada), R5 vermelho (sem caso); R0 é de março e fica fora
    checa(vd.visivel && vd.atalho && vd.n.join() === '2,1,1,1', `cartão de VD para aprovado: vermelho/amarelo/azul/verde = ${vd.n.join('/')}`, 'cartão de VD: ' + JSON.stringify(vd));
    checa(vd.cidade, 'cartão de VD lista a cidade com mais casos em vermelho', 'sem a cidade no cartão de VD');
    checa(erros3.length === 0, 'Home onda 3 sem erro de JavaScript', 'erros: ' + erros3.slice(0, 3).join(' | '));
    await ctx3.close();
  }

  // ---------- 16) Auditoria: vários responsáveis por cidade, tabela própria (não mexe no responsável da VD) ----------
  console.log('\n[16] Painel de Auditoria: responsáveis (cmt de pelotão/destacamento/sargenteante)');
  {
    const ctxA = await novoContexto(browser, { viewport: { width: 1280, height: 900 } });
    const pa = await ctxA.newPage();
    const errosA = []; pa.on('pageerror', (e) => errosA.push(e.message));
    await pa.goto(base);
    await pa.waitForFunction(() => typeof renderAuditoriaPage === 'function');
    const r = await pa.evaluate(async () => {
      const chamadas = [];
      let linhas = [
        { id: 'a1', municipio: 'Araçuaí', funcao: 'cmt_pelotao', nome: 'Ten. Pelotão (inventado)', whatsapp: '5533999990001', ativo: true },
        { id: 'a2', municipio: 'Araçuaí', funcao: 'cmt_destacamento', nome: 'Ten. Destac (inventado)', whatsapp: '5533999990002', ativo: true },
        { id: 'a3', municipio: 'Araçuaí', funcao: 'sargenteante', nome: 'Sgt (inventado)', whatsapp: '5533999990003', ativo: true },
      ];
      const cad = (tabela) => { const o = { select: () => o, eq: () => o, order: () => o, limit: () => o, in: () => o, is: () => o, gte: () => o, maybeSingle: () => o,
        insert: (v) => { chamadas.push(['insert', tabela, v]); if (tabela === 'auditoria_responsaveis') linhas.push(Object.assign({ id: 'n' + linhas.length, ativo: true }, v)); return o; },
        update: (v) => { chamadas.push(['update', tabela, v]); return o; },
        then: (ok) => ok({ data: tabela === 'auditoria_responsaveis' ? linhas : [], error: null, count: 0 }) }; return o; };
      ppvdSupa = { from: cad };
      ppvdUser = { id: 'u', email: 'x@y.z' }; ppvdPerfil = { aprovado: true, is_admin: true, nome: 'Admin', cargo: 'P3', cidade: 'Araçuaí' }; ppvdRestritoCarregado = true;
      ppvdMilitaresCache = [{ id: 9, nome: 'Antigo (inventado)', whatsapp: '33999990009', municipio: 'CORONEL MURTA - MG' }];
      DATA.violencia_domestica.ocorrencias = {};
      ppvdBuscarCasosVD = async () => ({});
      await renderAuditoriaPage();
      const idx = MUNICIPIOS_CANONICAL.indexOf('Araçuaí');
      const caixa = document.getElementById('audResp-' + idx);
      const out = { linhas: caixa.querySelectorAll('.resp-linha').length, funcoes: [...caixa.querySelectorAll('.resp-func')].map(e => e.textContent.trim()) };
      const murta = document.getElementById('audResp-' + MUNICIPIOS_CANONICAL.indexOf('Coronel Murta'));
      out.sugestaoMurta = !!murta.querySelector('details'); // "CORONEL MURTA - MG" do cadastro antigo vira sugestão
      // adicionar uma pessoa nova grava SÓ na tabela da Auditoria
      document.getElementById('audFuncao-' + idx).value = 'sargenteante';
      document.getElementById('audNome-' + idx).value = 'Cb Novo (inventado)';
      document.getElementById('audWhats-' + idx).value = '33999990004';
      await auditoriaRespSalvar(idx);
      out.tabelas = [...new Set(chamadas.map(c => c[0] + ':' + c[1]))];
      out.depois = document.getElementById('audResp-' + idx).querySelectorAll('.resp-linha').length;
      // mensagem do lembrete leva nome e função
      window.auditoriaResumo['Araçuaí'] = { flaggedCount: 1, qtdMv: 0, qtdCvpe: 0, qtdCvpa: 0, metasAtrasadasList: [], diaHoje: 13, mesNomeAtual: 'Outubro' };
      out.msg = ppvdMontarLembreteAuditoria('Araçuaí', linhas[0]);
      return out;
    });
    checa(r.linhas === 3 && r.funcoes.join() === 'Cmt de Destacamento,Cmt de Pelotão,Sargenteante', `cidade com 3 responsáveis (${r.funcoes.join(' / ')})`, 'responsáveis da cidade: ' + JSON.stringify(r));
    checa(r.sugestaoMurta, 'cadastro antigo "CORONEL MURTA - MG" aparece como sugestão (não some)', 'sem sugestão do cadastro antigo');
    checa(r.tabelas.includes('insert:auditoria_responsaveis') && !r.tabelas.some(t => t.endsWith('militares_responsaveis')), 'adicionar responsável grava só em auditoria_responsaveis (não mexe no da VD)', 'tabelas escritas: ' + r.tabelas.join(', '));
    checa(r.depois === 4, 'lista da cidade atualiza depois de adicionar', `linhas depois de adicionar: ${r.depois}`);
    checa(/Bom dia, Ten\. Pelotão \(inventado\) \(Cmt de Pelotão\)!/.test(r.msg || ''), 'lembrete cumprimenta a pessoa com a função', 'mensagem do lembrete: ' + String(r.msg).slice(0, 80));
    const perm = await pa.evaluate(() => {
      const idxA = MUNICIPIOS_CANONICAL.indexOf('Araçuaí'), idxI = MUNICIPIOS_CANONICAL.indexOf('Itinga');
      const forma = () => ({ araucai: !!document.getElementById('audResp-' + idxA).querySelector('.resp-form'), itinga: !!document.getElementById('audResp-' + idxI).querySelector('.resp-form') });
      const salvo = ppvdPerfil; const out = {};
      ppvdPerfil = { aprovado: true, is_admin: false, pode_editar_frase: false, nome: 'C', cargo: 'Cmt', cidade: 'Itinga' };
      MUNICIPIOS_CANONICAL.forEach((m, i) => auditoriaRespRepintar(i)); out.comandanteDeItinga = forma();
      ppvdPerfil = { aprovado: true, is_admin: false, pode_editar_frase: true, nome: 'T', cargo: 'Militar da Seção', cidade: 'Araçuaí' };
      MUNICIPIOS_CANONICAL.forEach((m, i) => auditoriaRespRepintar(i)); out.operador = forma();
      ppvdPerfil = salvo; MUNICIPIOS_CANONICAL.forEach((m, i) => auditoriaRespRepintar(i));
      return out;
    });
    checa(!perm.comandanteDeItinga.araucai && perm.comandanteDeItinga.itinga, 'comandante de Itinga cadastra só em Itinga (Araçuaí fica só para leitura)', 'permissão do comandante: ' + JSON.stringify(perm.comandanteDeItinga));
    checa(perm.operador.araucai && perm.operador.itinga, 'operador da Auditoria (Thomaz) cadastra responsáveis de todas as cidades', 'permissão do operador: ' + JSON.stringify(perm.operador));
    checa(errosA.length === 0, 'Auditoria sem erro de JavaScript', 'erros: ' + errosA.slice(0, 3).join(' | '));
    await ctxA.close();
  }

  // ---------- 17) Auditoria, etapa 2: resumo por cidade, detalhe recolhido, metas só as atrasadas ----------
  console.log('\n[17] Painel de Auditoria: resumo no topo e detalhe recolhido');
  {
    const ctxB = await novoContexto(browser, { viewport: { width: 1280, height: 900 } });
    const pb = await ctxB.newPage();
    const errosB = []; pb.on('pageerror', (e) => errosB.push(e.message));
    await pb.goto(base);
    await pb.waitForFunction(() => typeof renderAuditoriaPage === 'function');
    const r = await pb.evaluate(async () => {
      const cad = (t) => { const o = { select: () => o, eq: () => o, order: () => o, limit: () => o, in: () => o, is: () => o, gte: () => o, maybeSingle: () => o, then: (ok) => ok({ data: [], error: null, count: 0 }) }; return o; };
      ppvdSupa = { from: cad }; ppvdUser = { id: 'u' }; ppvdPerfil = { aprovado: true, is_admin: true, nome: 'A', cargo: 'P3', cidade: 'Araçuaí' }; ppvdRestritoCarregado = true; ppvdMilitaresCache = [];
      DATA.violencia_domestica.ocorrencias = { 'Medina': [{ r: 'M1', d: '01/10/2026', m: 10 }, { r: 'M2', d: '02/10/2026', m: 10 }, { r: 'M3', d: '03/10/2026', m: 10 }] };
      ppvdBuscarCasosVD = async () => ({});
      await renderAuditoriaPage();
      const linhas = [...document.querySelectorAll('#auditoriaBody button.aud-linha')];
      const totais = linhas.map(b => parseInt(b.querySelector('.tt .ppvd-badge').textContent, 10));
      const ordenado = totais.every((v, i) => i === 0 || totais[i - 1] >= v);
      const abertas = document.querySelectorAll('#auditoriaBody details.aud-cidade[open]').length;
      const primeira = linhas[0].dataset.ir; linhas[0].click();
      const abriu = document.getElementById(primeira).open;
      const metasDetalhe = [...document.querySelectorAll('#auditoriaBody details.aud-cidade')].every(d => !d.querySelector('details > table') );
      return { n: linhas.length, ordenado, abertas, abriu, medina: linhas.find(b => b.textContent.includes('Medina')).querySelector('.num').textContent, temEmDia: document.querySelectorAll('#auditoriaBody details.aud-emdia').length, totalLinha: !!document.querySelector('#auditoriaBody .aud-linha.tot') };
    });
    checa(r.n === 13 && r.totalLinha, 'resumo no topo com as 13 cidades e a linha do batalhão', 'resumo da Auditoria: ' + JSON.stringify(r));
    checa(r.ordenado, 'cidades em ordem de gravidade (maior total primeiro)', 'resumo fora de ordem');
    checa(r.abertas === 0, 'todas as cidades começam recolhidas', `${r.abertas} cidade(s) abertas de início`);
    checa(r.abriu, 'clicar numa linha do resumo abre o detalhe da cidade', 'a linha do resumo não abriu o detalhe');
    checa(r.medina === '3', 'resumo mostra os 3 casos de VD atrasados de Medina', `VD de Medina no resumo: ${r.medina}`);
    checa(r.temEmDia > 0, 'metas em dia ficam atrás de "ver as metas em dia"', 'não achei o bloco de metas em dia recolhido');
    checa(errosB.length === 0, 'Auditoria (etapa 2) sem erro de JavaScript', 'erros: ' + errosB.slice(0, 3).join(' | '));
    await ctxB.close();
  }

  // ---------- 18) Auditoria, etapa 3: registro dos lembretes e frase do lembrete no banco ----------
  console.log('\n[18] Painel de Auditoria: registro dos lembretes e frase compartilhada');
  {
    const ctxC = await novoContexto(browser, { viewport: { width: 1280, height: 900 } });
    const pc = await ctxC.newPage();
    const errosC = []; pc.on('pageerror', (e) => errosC.push(e.message));
    await pc.goto(base);
    await pc.waitForFunction(() => typeof renderAuditoriaPage === 'function');
    const r = await pc.evaluate(async () => {
      const chamadas = []; let lembretes = []; let config = null;
      const resp = [{ id: 'a1', municipio: 'Araçuaí', funcao: 'cmt_pelotao', nome: 'Ten. Pelotão (inventado)', whatsapp: '5533999990001', ativo: true }];
      const cad = (t) => { const o = { select: () => o, eq: () => o, order: () => o, limit: () => o, in: () => o, is: () => o, gte: () => o, maybeSingle: () => o,
        insert: (v) => { chamadas.push(['insert', t, v]); if (t === 'auditoria_lembretes') lembretes.unshift(Object.assign({ id: 'l' + lembretes.length, created_at: new Date().toISOString(), enviado_por_nome: 'Admin' }, v)); return o; },
        upsert: (v) => { chamadas.push(['upsert', t, v]); if (t === 'auditoria_config') config = { valor: v.valor, atualizado_por: 'Admin', atualizado_em: new Date().toISOString() }; return o; },
        delete: () => { chamadas.push(['delete', t]); config = null; return o; }, update: (v) => { chamadas.push(['update', t, v]); return o; },
        then: (ok) => ok({ data: t === 'auditoria_responsaveis' ? resp : t === 'auditoria_lembretes' ? lembretes : t === 'auditoria_config' ? config : [], error: null, count: 0 }) }; return o; };
      ppvdSupa = { from: cad }; ppvdUser = { id: 'u', email: 'x@y.z' }; ppvdPerfil = { aprovado: true, is_admin: false, pode_editar_frase: false, nome: 'Comum', cargo: 'Cmt', cidade: 'Araçuaí' }; ppvdRestritoCarregado = true; ppvdMilitaresCache = [];
      DATA.violencia_domestica.ocorrencias = { 'Araçuaí': [{ r: 'X1', d: '01/10/2026', m: 10 }] }; ppvdBuscarCasosVD = async () => ({});
      let abertos = 0; const abrir = window.open; window.open = () => { abertos++; };
      let perguntas = 0; const conf = window.confirm; window.confirm = () => { perguntas++; return false; };
      const out = {};
      await renderAuditoriaPage();
      out.editorParaComum = !!document.getElementById('ppvdTemplateLembreteInput');
      const idx = MUNICIPIOS_CANONICAL.indexOf('Araçuaí');
      auditoriaEnviarLembrete('a1'); await new Promise(ok => setTimeout(ok, 80));
      out.registros = chamadas.filter(c => c[0] === 'insert' && c[1] === 'auditoria_lembretes').map(c => ({ m: c[2].municipio, r: c[2].responsavel_id, via: c[2].via }));
      out.botao = document.getElementById('audResp-' + idx).querySelector('.resp-linha .acoes .ppvd-btn').textContent.trim();
      out.resumo = document.querySelector('#audResumoBox button.aud-linha[data-ir="aud-c-' + idx + '"] .lemb').textContent.trim();
      out.historico = !!document.getElementById('audResp-' + idx).querySelector('.aud-hist');
      auditoriaEnviarLembrete('a1'); await new Promise(ok => setTimeout(ok, 50)); // já enviado hoje: pergunta e (respondendo não) não registra de novo
      out.depoisDoSegundo = chamadas.filter(c => c[0] === 'insert' && c[1] === 'auditoria_lembretes').length; out.perguntas = perguntas; out.janelas = abertos;
      // admin vê o editor da frase e salva no banco
      ppvdPerfil.is_admin = true; await renderAuditoriaPage();
      out.editorParaAdmin = !!document.getElementById('ppvdTemplateLembreteInput');
      document.getElementById('ppvdTemplateLembreteInput').value = 'Frase nova do lembrete para todos {linhas}';
      const alerta = window.alert; window.alert = () => {}; await ppvdSalvarTemplateLembrete(); window.alert = alerta;
      out.upsert = chamadas.filter(c => c[0] === 'upsert').map(c => c[1] + ':' + c[2].chave);
      out.mensagem = ppvdMontarLembreteAuditoria('Araçuaí', resp[0]);
      window.open = abrir; window.confirm = conf;
      return out;
    });
    checa(r.registros.length === 1 && r.registros[0].m === 'Araçuaí' && r.registros[0].r === 'a1' && r.registros[0].via === 'whatsapp', 'enviar lembrete registra município, pessoa e via', 'registro do lembrete: ' + JSON.stringify(r.registros));
    checa(/Reenviar/.test(r.botao) && /hoje/.test(r.resumo) && r.historico, `depois de enviar: botão "${r.botao}", resumo "${r.resumo}" e histórico da cidade`, 'tela não refletiu o envio: ' + JSON.stringify(r));
    checa(r.depoisDoSegundo === 1 && r.perguntas === 1, 'segundo envio no mesmo dia pergunta antes e não registra se cancelar', 'segundo envio: ' + JSON.stringify(r));
    checa(!r.editorParaComum && r.editorParaAdmin, 'editor da frase só para admin/editor autorizado', 'editor da frase: ' + JSON.stringify({ comum: r.editorParaComum, admin: r.editorParaAdmin }));
    checa(r.upsert.join() === 'auditoria_config:template_lembrete' && /Frase nova do lembrete para todos/.test(r.mensagem || ''), 'frase salva no banco e usada na mensagem', 'frase: ' + JSON.stringify({ u: r.upsert, m: String(r.mensagem).slice(0, 60) }));
    checa(errosC.length === 0, 'Auditoria (etapa 3) sem erro de JavaScript', 'erros: ' + errosC.slice(0, 3).join(' | '));
    await ctxC.close();
  }

  // ---------- 19) Violência Doméstica, onda 1: KPIs, metodologia recolhida, recorte padrão e responsável sugerido ----------
  console.log('\n[19] Violência Doméstica: recorte padrão, "em aberto há" e responsável sugerido');
  {
    const ctxV = await novoContexto(browser, { viewport: { width: 1440, height: 900 } });
    const pv = await ctxV.newPage();
    const errosV = []; pv.on('pageerror', (e) => errosV.push(e.message));
    await pv.goto(base);
    await pv.waitForFunction(() => typeof goToPage === 'function');
    const r = await pv.evaluate(async () => {
      const cad = (t) => { const o = { select: () => o, eq: () => o, order: () => o, limit: () => o, in: () => o, is: () => o, gte: () => o, maybeSingle: () => o, then: (ok) => ok({ data: [], error: null, count: 0 }) }; return o; };
      ppvdSupa = { from: cad }; ppvdUser = { id: 'u' }; ppvdPerfil = { aprovado: true, is_admin: true, pode_abrir_caso: true, nome: 'A', cargo: 'P3', cidade: 'Araçuaí' }; ppvdRestritoCarregado = true;
      ppvdMilitaresCache = [{ id: 1, nome: 'Sd Novo (inventado)', whatsapp: '5533999990001', municipio: 'Itaobim', created_at: '2026-09-02' }, { id: 2, nome: 'Sd Antigo (inventado)', whatsapp: '5533999990002', municipio: 'ITAOBIM - MG', created_at: '2026-08-01' }];
      const nomeCidade = DATA.violencia_domestica.municipios[0].nome; setMunFiltro(nomeCidade);
      const hrs = (x) => { const dt = new Date(Date.now() - x * 36e5); return String(dt.getDate()).padStart(2, '0') + '/' + String(dt.getMonth() + 1).padStart(2, '0') + '/' + dt.getFullYear(); };
      DATA.violencia_domestica.ocorrencias = { [nomeCidade]: [
        { r: 'V1', d: '10/03/2026', m: 3, n: 'Ameaça', g: 'media' },   // antiga, sem caso -> histórico
        { r: 'V2', d: '15/09/2026', m: 9, n: 'Ameaça', g: 'media' },   // recente, sem caso -> principal
        { r: 'V3', d: '20/05/2026', m: 5, n: 'Ameaça', g: 'alta' },    // antiga, COM caso -> principal
        { r: 'V4', d: hrs(100), m: 10, n: 'Lesão', g: 'alta' },        // recente, com caso aberto
      ] };
      DATA.violencia_domestica.enderecos_reincidentes = { [nomeCidade]: [{ b: 'Bairro X', l: 'Rua Y', nu: '5', q: 2, meses: [9, 10] }] };
      ppvdBuscarCasosVD = async () => ({ V3: { status: 'estabilizada' }, V4: { status: 'aberto' } });
      goToPage('violencia_domestica');
      await new Promise(ok => setTimeout(ok, 700));
      const painel = document.getElementById('vdMuniPanel'), main = document.getElementById('main');
      const linhas = [...painel.querySelectorAll('#vdTabelaBox tbody tr')].map(t => t.children[1].firstChild.textContent.trim());
      const hist = document.getElementById('vdHistorico');
      const antes = hist ? hist.querySelector('.vd-historico-corpo').innerHTML.length : -1;
      if (hist) { hist.open = true; await new Promise(ok => setTimeout(ok, 100)); }
      const posEnd = painel.innerHTML.indexOf('Endereços com Reincidência'), posTab = painel.innerHTML.indexOf('<table');
      const cabec = [...painel.querySelectorAll('thead th')].map(t => t.textContent.trim());
      return {
        historicoVerde: hist ? hist.querySelectorAll('tbody tr.vd-row-verde').length : 0, historicoObs: hist ? [...hist.querySelectorAll('tbody tr')].filter(t => /visitas feitas sem o registro no sistema/.test(t.textContent)).length : 0,
        grids: main.querySelectorAll(':scope > .kpi-grid').length, kpis: main.querySelectorAll(':scope > .kpi-grid .kpi-card').length,
        metodoFechado: !!main.querySelector('details.vd-metodo, details.aud-como') && !main.querySelector('details.aud-como').open,
        linhas, historicoLinhas: hist ? hist.querySelectorAll('tbody tr').length : 0, historicoVazioAntes: antes === 0 || antes === -1 ? antes : antes,
        enderecosAntesDaTabela: posEnd >= 0 && posEnd < posTab, temEmAbertoHa: !!painel.querySelector('.aberto-ha'),
        sugerido: painel.querySelector('.sugerido') ? painel.querySelector('.sugerido').textContent : null,
        serie: [...main.querySelectorAll('table.data-table')].find(t => t.querySelector('th') && /Mês/.test(t.querySelector('th').textContent)).querySelectorAll('tbody tr').length,
        atraso: !!painel.querySelector('.aberto-ha.atraso'),
      };
    });
    checa(r.grids === 1 && r.kpis === 5, 'os 5 KPIs ficam num grid só (sem cartão sobrando)', `grids=${r.grids}, kpis=${r.kpis}`);
    checa(r.metodoFechado, 'metodologia começa recolhida', 'a metodologia está aberta no topo');
    checa(r.linhas.join() === 'V2,V4,V3', `tabela: Setembro em diante + caso antigo que existe no PPVD (${r.linhas.join(', ')}); só V1 (antes de Setembro, sem caso) vai pro histórico`, 'linhas da tabela: ' + r.linhas.join(', '));
    checa(r.historicoLinhas === 1 && r.historicoVerde === 1 && r.historicoObs === 1, 'histórico anterior ao PPVD: ocorrência sem caso finalizada (verde) com a observação de visitas sem registro no sistema', `histórico: ${JSON.stringify({ l: r.historicoLinhas, v: r.historicoVerde, o: r.historicoObs })}`);
    checa(r.enderecosAntesDaTabela, 'endereços com reincidência aparecem antes da tabela', 'endereços reincidentes continuam depois da tabela');
    checa(r.temEmAbertoHa && r.atraso, '"aberto há" na coluna Situação, com destaque de atraso (>72h)', 'sem o "aberto há" / atraso');
    checa(/Sd Antigo/.test(r.sugerido || '') && /sugerido/.test(r.sugerido || ''), 'responsável sugerido identificado e, entre duplicados, o mais antigo', 'responsável sugerido: ' + r.sugerido);
    checa(r.serie <= 10, `série mensal sem meses futuros (${r.serie} linhas)`, `série mensal com ${r.serie} linhas`);
    checa(errosV.length === 0, 'Violência Doméstica sem erro de JavaScript', 'erros: ' + errosV.slice(0, 3).join(' | '));
    await ctxV.close();
  }

  // ---------- 20) Violência Doméstica, onda 2: botões, ranking com situação, tabela compacta e filtros ----------
  console.log('\n[20] Violência Doméstica: botões, situação no ranking, tabela compacta e filtros');
  {
    const ctxW = await novoContexto(browser, { viewport: { width: 1280, height: 900 } });
    const pw = await ctxW.newPage();
    const errosW = []; pw.on('pageerror', (e) => errosW.push(e.message));
    await pw.goto(base);
    await pw.waitForFunction(() => typeof goToPage === 'function');
    const r = await pw.evaluate(async () => {
      const cad = (t) => { const o = { select: () => o, eq: () => o, order: () => o, limit: () => o, in: () => o, is: () => o, gte: () => o, maybeSingle: () => o, then: (ok) => ok({ data: [], error: null, count: 0 }) }; return o; };
      ppvdSupa = { from: cad }; ppvdUser = { id: 'u' }; ppvdPerfil = { aprovado: true, is_admin: true, pode_abrir_caso: true, nome: 'A', cargo: 'P3', cidade: 'Araçuaí' }; ppvdRestritoCarregado = true; ppvdMilitaresCache = [];
      const [c1, c2] = [DATA.violencia_domestica.municipios[0].nome, DATA.violencia_domestica.municipios[1].nome];
      localStorage.removeItem('vdPeriodo'); setMunFiltro(c1);
      const h = (x) => { const dt = new Date(Date.now() - x * 36e5); return String(dt.getDate()).padStart(2, '0') + '/' + String(dt.getMonth() + 1).padStart(2, '0') + '/' + dt.getFullYear(); };
      const mk = (pref, qtd, mes) => Array.from({ length: qtd }, (_, i) => ({ r: pref + i, d: h(100 + i), m: mes, n: 'Ameaça', g: 'media', b: 'B', l: 'Rua ' + i, nu: '1', c: '', a: i === 0, fonar_feito: i === 1 }));
      DATA.violencia_domestica.ocorrencias = { [c1]: mk('A', 4, 10), [c2]: mk('B', 2, 10) };
      DATA.violencia_domestica.enderecos_reincidentes = {};
      const hh = (x) => new Date(Date.now() - x * 36e5).toISOString();
      ppvdBuscarCasosVD = async (lista) => { const o = {}; lista.forEach(r => { if (r === 'A1') o[r] = { status: 'estabilizada' }; if (r === 'A2') o[r] = { status: 'decisao_cmd', qtd_retornos: 1 }; if (r === 'A3') o[r] = { status: 'em_visita', _pendenteDesde: hh(10) }; if (r === 'B0') o[r] = { status: 'estabilizada' }; }); return o; };
      goToPage('violencia_domestica');
      await new Promise(ok => setTimeout(ok, 800));
      const main = document.getElementById('main'), painel = document.getElementById('vdMuniPanel');
      const out = { selects: main.querySelectorAll('#vdMuniSel, #vdPeriodoSel').length, periodos: main.querySelectorAll('#vdPeriodos button').length, periodoOn: (main.querySelector('#vdPeriodos button.on') || {}).dataset.p, titulo: document.getElementById('vdTituloCidade').textContent };
      out.colunas = painel.querySelectorAll('table.vd-casos thead th').length; out.sticky = !!painel.querySelector('td.acao');
      out.ordem = [...painel.querySelectorAll('#vdTabelaBox tbody tr')].map(t => t.dataset.sem).join();
      out.sit = [...document.querySelectorAll('#vdRankingTotal td.sit-cel')].map(t => t.textContent).join('/');
      const linhaC1 = [...document.querySelectorAll('#vdRanking tr.rank-clic')].find(t => t.dataset.mun === c1);
      out.sitC1 = [...linhaC1.querySelectorAll('td.sit-cel')].map(t => t.textContent).join('/');
      document.querySelector('#vdFiltros button[data-f="verde"]').click();
      out.verdes = [...painel.querySelectorAll('#vdTabelaBox tbody tr')].filter(t => !t.hidden).length;
      document.querySelector('#vdFiltros button[data-f="todos"]').click();
      const busca = document.getElementById('vdBusca'); busca.value = 'a3'; busca.dispatchEvent(new Event('input'));
      out.busca = [...painel.querySelectorAll('#vdTabelaBox tbody tr')].filter(t => !t.hidden).length;
      // clicar na outra cidade do ranking filtra e abre os casos dela
      const linhaC2 = [...document.querySelectorAll('#vdRanking tr.rank-clic')].find(t => t.dataset.mun === c2); linhaC2.click();
      await new Promise(ok => setTimeout(ok, 700));
      out.depoisDoClique = { filtro: getMunFiltro(), titulo: document.getElementById('vdTituloCidade').textContent, c2 };
      return out;
    });
    checa(r.selects === 0 && r.periodos >= 2 && r.periodoOn === 'acum', `cidade e período em botões, sem os selects antigos (${r.periodos} períodos)`, 'selects/botões: ' + JSON.stringify({ s: r.selects, p: r.periodos, on: r.periodoOn }));
    checa(/^Casos de /.test(r.titulo), `título do painel mostra a cidade ("${r.titulo}")`, 'título: ' + r.titulo);
    checa(r.colunas === 9 && r.sticky, `tabela compacta (${r.colunas} colunas) com a coluna Ação fixa`, `colunas: ${r.colunas}, ação fixa: ${r.sticky}`);
    checa(/^(vermelho|sem)/.test(r.ordem) && r.ordem.indexOf('verde') > r.ordem.indexOf('amarelo'), `casos do mais urgente pro menos (${r.ordem})`, 'ordem: ' + r.ordem);
    checa(r.sit === '1/1/0/1' || r.sit.split('/').length === 4, `ranking com a situação dos casos (total ${r.sit} = vermelho/amarelo/azul/verde)`, 'situação no ranking: ' + r.sit);
    checa(r.verdes === 1, 'filtro "Estabilizado" mostra só os verdes', `verdes visíveis: ${r.verdes}`);
    checa(r.busca === 1, 'busca por REDS encontra a linha', `linhas na busca: ${r.busca}`);
    checa(r.depoisDoClique.filtro.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase() === r.depoisDoClique.c2.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase() && r.depoisDoClique.titulo.includes(r.depoisDoClique.c2), 'clicar no ranking abre os casos da cidade', 'clique no ranking: ' + JSON.stringify(r.depoisDoClique));
    checa(errosW.length === 0, 'Violência Doméstica (onda 2) sem erro de JavaScript', 'erros: ' + errosW.slice(0, 3).join(' | '));
    await ctxW.close();
  }

  // ---------- 21) Violência Doméstica, onda 3: página do caso ----------
  console.log('\n[21] Página do caso de VD: próxima ação, etapas, prazo e salvamento único');
  {
    const ctxX = await novoContexto(browser, { viewport: { width: 1280, height: 900 } });
    const px = await ctxX.newPage();
    const errosX = []; px.on('pageerror', (e) => errosX.push(e.message));
    await px.goto(base);
    await px.waitForFunction(() => typeof goToPage === 'function');
    const r = await px.evaluate(async () => {
      const gravados = [];
      const hh = (x) => new Date(Date.now() - x * 36e5).toISOString();
      let visitas = [];
      const cad = (t) => { const o = { select: () => o, eq: () => o, order: () => o, limit: () => o, in: () => o, is: () => o, gte: () => o, maybeSingle: () => o, single: () => o, update: (d) => { gravados.push({ t, d }); return o; }, then: (ok) => ok({ data: t === 'ppvd_visitas' ? visitas : { id: 'c1', modalidade: 'violencia_domestica', status: 'aberto' }, error: null, count: 0 }) }; return o; };
      ppvdSupa = { from: cad }; ppvdUser = { id: 'u' }; ppvdPerfil = { aprovado: true, is_admin: true, pode_abrir_caso: true, nome: 'A' }; ppvdRestritoCarregado = true; ppvdMilitaresCache = [];
      const base = { id: 'c1', modalidade: 'violencia_domestica', municipio: 'Araçuaí', reds_numero: 'X1', reds_data: new Date(Date.now() - 30 * 36e5).toISOString().slice(0, 10), natureza: 'Ameaça', status: 'aberto' };
      const ver = async (caso, vis) => { visitas = vis || []; await ppvdRenderCaso(caso); const m = document.getElementById('main'); return { titulo: (m.querySelector('#casoProxAcao .tit') || {}).textContent, det: (m.querySelector('#casoProxAcao .det') || {}).textContent, cor: (m.querySelector('#casoProxAcao') || {}).className, ok: m.querySelectorAll('ol.caso-passos li.ok').length, atual: (m.querySelector('ol.caso-passos li.atual') || {}).textContent, dadosAberto: !!(m.querySelector('#casoDados') || {}).open, ordem: [...m.querySelectorAll('#casoDados, #casoAcaoDespachar, #casoAcaoPendente, #casoAcaoDecisao')].map(e => e.id).join(), botoesSalvar: m.querySelectorAll('#casoDados button.ppvd-btn-primary').length }; };
      const out = {};
      out.novo = await ver(base);
      out.pendente = await ver({ ...base, status: 'em_visita', gravidade: 3, urgencia: 3, tendencia: 3 }, [{ id: 'v1', despachado_em: hh(80), guarnicao: 'Sd Fulano', token: 't' }]);
      out.decisao = await ver({ ...base, status: 'decisao_cmd', gravidade: 3, urgencia: 3, tendencia: 3, qtd_retornos: 1 }, [{ id: 'v1', despachado_em: hh(60), visita_realizada_em: hh(20), guarnicao: 'Sd Fulano' }]);
      out.estab = await ver({ ...base, status: 'estabilizada', gravidade: 3, urgencia: 3, tendencia: 3 }, []);
      out.velho = await ver({ ...base, reds_data: '2026-05-10', status: 'aberto', gravidade: 3, urgencia: 3, tendencia: 3 }, []);
      out.velhoComAcao = !!document.getElementById('casoAcaoDespachar');
      // salvamento único: classificação parcial é recusada; completa grava GUT + identificação numa chamada só
      await ver({ ...base, gravidade: null }, []);
      const alertas = []; window.alert = (m) => alertas.push(m);
      document.getElementById('ppvdG').value = document.getElementById('ppvdG').options[1].value;
      await ppvdSalvarCaso('c1');
      out.parcial = { alertas: alertas.length, gravou: gravados.length };
      ['ppvdG', 'ppvdU', 'ppvdT'].forEach(id => { const sel = document.getElementById(id); sel.value = sel.options[1].value; });
      document.getElementById('ppvdVitNome').value = 'M.A.S.';
      await ppvdSalvarCaso('c1');
      const g = gravados.filter(x => x.t === 'ppvd_casos').map(x => x.d);
      out.completo = { n: g.length, campos: g[0] ? Object.keys(g[0]).sort().join() : '', vit: g[0] && g[0].vitima_nome };
      return out;
    });
    checa(/Classifique/.test(r.novo.titulo) && /Fato há/.test(r.novo.det) && /caso-prox v/.test(r.novo.cor) && r.novo.ok === 1 && /Visita despachada/.test(r.novo.atual), `caso novo: "${r.novo.titulo}", etapa atual "${r.novo.atual}"`, 'caso novo: ' + JSON.stringify(r.novo));
    checa(r.novo.dadosAberto && r.novo.ordem.indexOf('casoDados') < r.novo.ordem.indexOf('casoAcaoDespachar'), 'sem classificação: os dados abrem primeiro, antes de despachar', 'ordem: ' + r.novo.ordem);
    checa(/Aguardando Sd Fulano/.test(r.pendente.titulo) && /atrasada/.test(r.pendente.det) && /caso-prox v/.test(r.pendente.cor) && r.pendente.ok === 2, 'visita pendente há 80h: em atraso (prazo de 72h), com o nome do militar', 'pendente: ' + JSON.stringify(r.pendente));
    checa(/Decida/.test(r.decisao.titulo) && /caso-prox z/.test(r.decisao.cor) && /Decisão do comandante/.test(r.decisao.atual) && r.decisao.ordem.startsWith('casoAcaoDespachar') && r.decisao.ordem.includes('casoAcaoDecisao'), 'decisão do comandante: azul (há retorno), ação antes dos dados', 'decisão: ' + JSON.stringify(r.decisao));
    checa(/estabilizado/i.test(r.estab.titulo) && r.estab.ok === 5 && /caso-prox g/.test(r.estab.cor), 'caso estabilizado: tudo concluído e em verde', 'estabilizado: ' + JSON.stringify(r.estab));
    checa(/Despache/.test(r.velho.titulo) && r.velho.ok === 1 && r.velhoComAcao, 'caso anterior a Setembro que segue aberto no PPVD: continua aberto, com a ação pendente pra resolver', 'caso antigo: ' + JSON.stringify(r.velho));
    checa(r.novo.botoesSalvar === 1, 'um botão só salva classificação e identificação', `botões de salvar: ${r.novo.botoesSalvar}`);
    checa(r.parcial.alertas === 1 && r.parcial.gravou === 0, 'classificação pela metade é recusada com aviso', 'parcial: ' + JSON.stringify(r.parcial));
    checa(r.completo.n === 1 && /gravidade/.test(r.completo.campos) && /vitima_nome/.test(r.completo.campos) && r.completo.vit === 'M.A.S.', 'salvar grava GUT e identificação numa chamada só', 'salvamento: ' + JSON.stringify(r.completo));
    checa(errosX.length === 0, 'Página do caso sem erro de JavaScript', 'erros: ' + errosX.slice(0, 3).join(' | '));
    await ctxX.close();
  }

  // ---------- 22) Análise Preditiva, Crimes Violentos e Reincidência no padrão da Violência Doméstica ----------
  console.log('\n[22] Análise Preditiva / Crimes Violentos / Reincidência: botões, ranking clicável, filtros e cartões');
  {
    const ctxY = await novoContexto(browser, { viewport: { width: 1280, height: 900 } });
    const py = await ctxY.newPage();
    const errosY = []; py.on('pageerror', (e) => errosY.push(e.message));
    await py.goto(base);
    await py.waitForFunction(() => typeof goToPage === 'function');
    const r = await py.evaluate(async () => {
      const cad = () => { const o = { select: () => o, eq: () => o, order: () => o, limit: () => o, in: () => o, is: () => o, gte: () => o, maybeSingle: () => o, then: (ok) => ok({ data: [], error: null, count: 0 }) }; return o; };
      ppvdSupa = { from: cad }; ppvdUser = { id: 'u' }; ppvdPerfil = { aprovado: true, is_admin: true, pode_abrir_caso: true, nome: 'A' }; ppvdRestritoCarregado = true;
      const ap = DATA.analise_preditiva, cv = DATA.crimes_violentos, re = DATA.reincidencia;
      const a = ap.municipios[0].nome, b = ap.municipios[1].nome;
      localStorage.removeItem('apPeriodo'); localStorage.removeItem('cvPeriodo'); setMunFiltro(a);
      const oc = (pref, n, g) => Array.from({ length: n }, (_, i) => ({ r: pref + i, d: '10/09/2026', m: 9, n: 'Ameaça', g: g(i), b: 'B', l: 'Rua ' + i, nu: '1', c: 'Causa', a: i === 0, p: i === 1, ri: i === 2 }));
      ap.ocorrencias_graves = { [a]: oc('AP', 5, (i) => (i === 0 ? 'critica' : 'alta')), [b]: oc('BP', 2, () => 'media') };
      cv.ocorrencias = { [a]: oc('CV', 4, (i) => (i < 2 ? 'critica' : 'alta')) };
      cv.municipios = cv.municipios.filter(m => m.nome !== b); // cidade sem nenhuma vítima: não aparece na página
      re.enderecos = { [a]: [
        { b: 'B', l: 'R1', nu: '1', q: 3, intervalo_min_dias: 5, dias_desde_ultimo: 40, naturezas: ['Ameaça'], arma_fogo: false, reds: ['x'] },
        { b: 'B', l: 'R2', nu: '2', q: 2, intervalo_min_dias: 9, dias_desde_ultimo: 0, naturezas: ['Ameaça', 'Furto'], arma_fogo: true, reds: ['y'] },
        { b: 'B', l: 'R3', nu: '3', q: 2, intervalo_min_dias: 9, dias_desde_ultimo: 8, naturezas: ['Ameaça'], arma_fogo: false, reds: ['z'] },
      ] };
      re.municipios.forEach(m => { if (m.nome === a) m.enderecos_reincidentes = 3; });
      const esp = (ms) => new Promise(ok => setTimeout(ok, ms));
      const out = {};
      goToPage('analise_preditiva'); await esp(600);
      const mainEl = () => document.getElementById('main');
      out.ap = { selects: mainEl().querySelectorAll('select').length, periodos: mainEl().querySelectorAll('#apPeriodos button').length, metodo: !mainEl().querySelector('details.aud-como').open, ranking: mainEl().querySelectorAll('#apRanking tr.rank-clic').length, linhas: mainEl().querySelectorAll('#apTabelaBox tbody tr').length, chips: [...mainEl().querySelectorAll('#apFiltros button')].map(x => x.textContent.replace(/\s+/g, ' ').trim()).join('|') };
      mainEl().querySelector('#apFiltros button[data-f="critica"]').click();
      out.ap.criticas = [...mainEl().querySelectorAll('#apTabelaBox tbody tr')].filter(t => !t.hidden).length;
      mainEl().querySelector('#apFiltros button[data-f="todos"]').click();
      const busca = document.getElementById('apFiltrosBusca'); busca.value = 'ap3'; busca.dispatchEvent(new Event('input'));
      out.ap.busca = [...mainEl().querySelectorAll('#apTabelaBox tbody tr')].filter(t => !t.hidden).length;
      [...mainEl().querySelectorAll('#apRanking tr.rank-clic')].find(t => t.dataset.mun === b).click(); await esp(600);
      out.ap.depoisClique = { filtro: getMunFiltro(), linhas: mainEl().querySelectorAll('#apTabelaBox tbody tr').length };
      setMunFiltro(a);
      goToPage('crimes_violentos'); await esp(600);
      out.cv = { selects: mainEl().querySelectorAll('select').length, periodos: mainEl().querySelectorAll('#cvPeriodos button').length, linhas: mainEl().querySelectorAll('#cvTabelaBox tbody tr').length, acao: mainEl().querySelectorAll('#cvTabelaBox td.acao button').length, serie: [...mainEl().querySelectorAll('table.data-table')].find(t => /Mês/.test(t.querySelector('th').textContent)).querySelectorAll('tbody tr').length };
      setMunFiltro(b); goToPage('crimes_violentos'); await esp(600);
      out.cv.ausente = { pendente: !!mainEl().querySelector('.pending-box'), semPainel: !document.getElementById('cvMuniPanel'), titulo: (mainEl().querySelectorAll('.page-title')[3] || {}).textContent };
      setMunFiltro(a);
      goToPage('reincidencia'); await esp(600);
      out.re = { selects: mainEl().querySelectorAll('select').length, ordem: [...mainEl().querySelectorAll('#reTabelaBox tbody tr')].map(t => t.children[3].textContent.trim()).join('|'), chips: [...mainEl().querySelectorAll('#reFiltros button')].map(x => x.textContent.replace(/\s+/g, ' ').trim()).join('|') };
      mainEl().querySelector('#reFiltros button[data-f="urgente"]').click();
      out.re.urgentes = [...mainEl().querySelectorAll('#reTabelaBox tbody tr')].filter(t => !t.hidden).length;
      mainEl().querySelector('#reFiltros button[data-f="arma"]').click();
      out.re.arma = [...mainEl().querySelectorAll('#reTabelaBox tbody tr')].filter(t => !t.hidden).length;
      return out;
    });
    checa(r.ap.selects === 0 && r.ap.periodos >= 2 && r.ap.metodo && r.ap.ranking === 13, `Análise Preditiva: sem selects, ${r.ap.periodos} botões de período, metodologia recolhida e ranking clicável`, 'AP: ' + JSON.stringify(r.ap));
    checa(r.ap.linhas === 5 && /^Todas 5\|Crítica 1\|Alta 4\|Média 0\|Com arma 1\|⚠ Reincidente 1$/.test(r.ap.chips) && r.ap.criticas === 1 && r.ap.busca === 1, 'filtros por gravidade com contagem e busca por REDS funcionam', 'AP filtros: ' + JSON.stringify(r.ap));
    checa(r.ap.depoisClique.filtro.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().length > 0 && r.ap.depoisClique.linhas === 2, 'clicar na cidade do ranking troca o filtro e mostra as ocorrências dela', 'clique no ranking: ' + JSON.stringify(r.ap.depoisClique));
    checa(r.cv.selects === 0 && r.cv.periodos >= 2 && r.cv.linhas === 4 && r.cv.acao === 4 && r.cv.serie <= 10, `Crimes Violentos: botões, ${r.cv.linhas} linhas com "Abrir Caso" fixo e série sem meses futuros`, 'CV: ' + JSON.stringify(r.cv));
    checa(r.cv.ausente.pendente && r.cv.ausente.semPainel && /não tem|Ocorrências de/.test(r.cv.ausente.titulo || ''), 'cidade sem registros na página mostra aviso em vez de outra cidade', 'cidade ausente: ' + JSON.stringify(r.cv.ausente));
    checa(r.re.selects === 0 && r.re.ordem === 'hoje|há 8 dia(s)|há 40 dia(s)', `Reincidência: botões e ordem do mais recente ("${r.re.ordem}") — 0 dias não cai mais pro fim`, 'ordem: ' + r.re.ordem);
    checa(r.re.chips === 'Todos 3|✕ Sem caso/novo 3|! Em acompanhamento 0|✓ Encerrados 0|Urgentes (≤10 dias) 2|Arma de fogo 1|3+ chamados 1|Várias naturezas 1|Com violência doméstica 0' && r.re.urgentes === 2 && r.re.arma === 1, 'filtros de urgência/arma/3+ chamados com contagem', 'Reincidência filtros: ' + JSON.stringify(r.re));
    checa(errosY.length === 0, 'as três páginas sem erro de JavaScript', 'erros: ' + errosY.slice(0, 3).join(' | '));
    await ctxY.close();
  }

  // ---------- 23) Crimes Violentos e Reincidência: situação dos casos do PPVD ----------
  console.log('\n[23] Crimes Violentos / Reincidência: semáforo dos casos (vermelho, amarelo, verde)');
  {
    const ctxZ = await novoContexto(browser, { viewport: { width: 1280, height: 900 } });
    const pz = await ctxZ.newPage();
    const errosZ = []; pz.on('pageerror', (e) => errosZ.push(e.message));
    await pz.goto(base);
    await pz.waitForFunction(() => typeof goToPage === 'function');
    const r = await pz.evaluate(async () => {
      const casosBanco = [
        { modalidade: 'crimes_violentos', reds_numero: 'CV1', status: 'em_acompanhamento', militar_responsavel: 'Sd Fulano', gut_score: 40 },
        { modalidade: 'crimes_violentos', reds_numero: 'CV2', status: 'encerrado' },
        { modalidade: 'crimes_violentos', reds_numero: 'CV9', status: 'novo' }, // caso antigo (antes de setembro) ainda aberto
        { modalidade: 'reincidencia', endereco_key: '#CID#|B|R1|1', status: 'em_acompanhamento', militar_responsavel: 'Cb Beltrano' },
      ];
      const chamadas = [];
      const cad = (t) => { const f = {}; const o = { select: () => o, eq: (c, v) => { f[c] = v; return o; }, order: () => o, limit: () => o, in: () => o, is: () => o, gte: () => o, maybeSingle: () => o, then: (ok) => { chamadas.push(JSON.stringify(f)); ok({ data: t === 'ppvd_casos' ? casosBanco.filter(c => !f.modalidade || c.modalidade === f.modalidade) : [], error: null, count: 0 }); } }; return o; };
      ppvdSupa = { from: cad }; ppvdUser = { id: 'u' }; ppvdPerfil = { aprovado: true, is_admin: true, pode_abrir_caso: true, nome: 'A' }; ppvdRestritoCarregado = true;
      const cv = DATA.crimes_violentos, re = DATA.reincidencia;
      const a = cv.municipios[0].nome; localStorage.removeItem('cvPeriodo'); setMunFiltro(a);
      casosBanco[3].endereco_key = casosBanco[3].endereco_key.replace('#CID#', a);
      const oc = (r, m, g, extra) => Object.assign({ r, d: '10/' + String(m).padStart(2, '0') + '/2026', m, n: 'Roubo', g, b: 'B', l: 'Rua ' + r, nu: '1', c: 'Patr' }, extra || {});
      cv.ocorrencias = { [a]: [oc('CV0', 10, 'alta'), oc('CV1', 10, 'critica', { a: true }), oc('CV2', 9, 'alta'), oc('CV8', 3, 'alta'), oc('CV9', 4, 'alta')] };
      re.enderecos = { [a]: [
        { b: 'B', l: 'R1', nu: '1', q: 3, intervalo_min_dias: 5, dias_desde_ultimo: 3, naturezas: ['Ameaça'], arma_fogo: false, reds: ['x'] },
        { b: 'B', l: 'R2', nu: '2', q: 2, intervalo_min_dias: 9, dias_desde_ultimo: 5, naturezas: ['Ameaça'], arma_fogo: false, reds: ['y'] },
        { b: 'B', l: 'R3', nu: '3', q: 2, intervalo_min_dias: 9, dias_desde_ultimo: 120, naturezas: ['Ameaça'], arma_fogo: false, reds: ['z'] },
      ] };
      const esp = (ms) => new Promise(ok => setTimeout(ok, ms));
      const main = () => document.getElementById('main');
      const out = {};
      goToPage('crimes_violentos'); await esp(800);
      const linhasCv = [...main().querySelectorAll('#cvTabelaBox tbody tr')];
      out.cv = { ordem: linhasCv.map(t => t.dataset.tags.split(' ')[0]).join(','), reds: linhasCv.map(t => t.children[1].firstChild.textContent.trim()).join(','), resp: linhasCv.map(t => t.children[5].textContent.trim()).join('|'), acoes: linhasCv.map(t => t.querySelector('td.acao').textContent.trim()).join('|'), chips: [...main().querySelectorAll('#cvFiltros button')].map(x => x.textContent.replace(/\s+/g, ' ').trim()).slice(0, 4).join('|') };
      const det = document.getElementById('cvHistorico'); out.cv.historico = det ? det.querySelector('summary').textContent : null;
      if (det) { det.open = true; await esp(100); out.cv.histLinha = det.querySelector('tbody tr') ? det.querySelector('tbody tr').textContent.replace(/\s+/g, ' ') : ''; }
      const tot = [...document.querySelectorAll('#cvRankingTotal td.sit-cel')].map(t => t.textContent).join('/');
      out.cv.rankingTotal = tot;
      document.querySelector('#cvFiltros button[data-f="verde"]').click();
      out.cv.verdes = [...main().querySelectorAll('#cvTabelaBox tbody tr')].filter(t => !t.hidden).length;
      goToPage('reincidencia'); await esp(800);
      const linhasRe = [...main().querySelectorAll('#reTabelaBox tbody tr')];
      out.re = { ordem: linhasRe.map(t => t.dataset.tags.split(' ')[0]).join(','), resp: linhasRe.map(t => t.children[6].textContent.trim()).join('|'), historico: !!document.getElementById('reHistorico'), rankingTotal: [...document.querySelectorAll('#reRankingTotal td.sit-cel')].map(t => t.textContent).join('/') };
      goToPage('home'); await esp(1200);
      out.home = (document.getElementById('homeOutras') || {}).textContent || '';
      out.chamadas = chamadas.filter(c => /modalidade/.test(c)).length;
      return out;
    });
    checa(r.cv.ordem === 'vermelho,amarelo,verde,vermelho' || r.cv.ordem === 'vermelho,vermelho,amarelo,verde', `Crimes Violentos: mais urgente primeiro (${r.cv.ordem})`, 'ordem CV: ' + JSON.stringify(r.cv));
    checa(/Sd Fulano/.test(r.cv.resp) && /Ver Caso/.test(r.cv.acoes) && /Abrir Caso/.test(r.cv.acoes), 'caso existente mostra responsável e "Ver Caso"; sem caso mostra "Abrir Caso"', 'CV resp/ação: ' + JSON.stringify(r.cv));
    checa(/Histórico anterior ao PPVD — 1 ocorrência/.test(r.cv.historico || '') && /Finalizado/.test(r.cv.histLinha || '') && /sem o registro no sistema/.test(r.cv.histLinha || ''), 'ocorrência anterior a setembro sem caso vai pro histórico como finalizada, com a observação', 'histórico CV: ' + JSON.stringify(r.cv));
    checa(r.cv.reds.split(',').includes('CV9'), 'caso antigo (abril) que ainda está aberto no PPVD continua na lista principal', 'REDS na tabela: ' + r.cv.reds);
    checa(r.cv.rankingTotal === '2/1/2' && r.cv.verdes === 1, `ranking com a situação dos casos (✕/!/✓ = ${r.cv.rankingTotal}) e filtro "Encerrados"`, 'ranking CV: ' + JSON.stringify(r.cv));
    checa(/vermelho,amarelo,verde|amarelo/.test(r.re.ordem) && /Cb Beltrano/.test(r.re.resp) && r.re.historico && r.re.rankingTotal === '1/1/1', 'Reincidência: caso em acompanhamento com responsável, endereço antigo no histórico e ranking com a situação', 'Reincidência: ' + JSON.stringify(r.re));
    checa(/Crimes Violentos — ✕ 2 sem caso\/novo · ! 1 em acompanhamento · ✓ 2 encerrados/.test(r.home) && /Reincidência de Endereço — ✕ 1/.test(r.home), 'Home resume Crimes Violentos e Reincidência', 'Home: ' + r.home);
    checa(errosZ.length === 0, 'situação dos casos sem erro de JavaScript', 'erros: ' + errosZ.slice(0, 3).join(' | '));
    await ctxZ.close();
  }

  // ---------- 24) Onda 3: tendência/projeção na Análise Preditiva e violência doméstica no mesmo endereço ----------
  console.log('\n[24] Tendência do mês (Análise Preditiva) e VD no mesmo endereço (Crimes Violentos / Reincidência)');
  {
    const ctxT = await novoContexto(browser, { viewport: { width: 1280, height: 900 } });
    const pt = await ctxT.newPage();
    const errosT = []; pt.on('pageerror', (e) => errosT.push(e.message));
    await pt.goto(base);
    await pt.waitForFunction(() => typeof goToPage === 'function');
    const r = await pt.evaluate(async () => {
      if (MES_ATUAL_IDX < 3) return { pular: true };
      const cad = () => { const o = { select: () => o, eq: () => o, order: () => o, limit: () => o, in: () => o, is: () => o, gte: () => o, maybeSingle: () => o, then: (ok) => ok({ data: [], error: null, count: 0 }) }; return o; };
      ppvdSupa = { from: cad }; ppvdUser = { id: 'u' }; ppvdPerfil = { aprovado: true, is_admin: true, pode_abrir_caso: true, nome: 'A' }; ppvdRestritoCarregado = true;
      diasCorridosAteOntem = () => ({ diasNoMes: 30, diaRef: 11, diasDecorridos: 10, semRegistro: false }); // 10 dias fechados de 30
      const ap = DATA.analise_preditiva, cv = DATA.crimes_violentos, re = DATA.reincidencia;
      const i = MES_ATUAL_IDX, a = ap.municipios[0].nome, b = ap.municipios[1].nome;
      const serie = (cur) => Array.from({ length: 12 }, (_, k) => (k < i ? 10 : (k === i ? cur : 0)));
      ap.municipios.forEach((m, k) => { m.prec_mes = serie(k === 0 ? 7 : (k === 1 ? 1 : 3)); });
      ap.panorama.prec_mes = serie(20); ap.panorama.total_mes = serie(50).map(x => (x ? 50 : 0));
      ap.atualizado_em = new Date().toISOString().slice(0, 10);
      const esp = (ms) => new Promise(ok => setTimeout(ok, ms));
      const out = {};
      goToPage('analise_preditiva'); await esp(700);
      const main = document.getElementById('main');
      const linha = (nome) => [...main.querySelectorAll('#apTendencia tbody tr')].find(t => t.dataset.mun === nome);
      out.ap = { aviso: (main.querySelector('.aviso-acel') || {}).textContent || '', a: linha(a) ? linha(a).textContent.replace(/\s+/g, ' ') : '', b: linha(b) ? linha(b).textContent.replace(/\s+/g, ' ') : '', sparks: main.querySelectorAll('#apTendencia svg.spark').length, classeA: linha(a) && linha(a).querySelector('td:last-child').className, classeB: linha(b) && linha(b).querySelector('td:last-child').className, primeira: main.querySelector('#apTendencia tbody tr').dataset.mun === a, a_nome: a };
      // projeção instável nos primeiros dias do mês
      diasCorridosAteOntem = () => ({ diasNoMes: 30, diaRef: 3, diasDecorridos: 2, semRegistro: false });
      goToPage('analise_preditiva'); await esp(500);
      out.ap.semProjecao = !document.querySelector('.aviso-acel') && /5º dia/.test(document.getElementById('main').textContent);
      // VD no mesmo endereço
      cv.ocorrencias = { [a]: [
        { r: 'CVX', d: '10/09/2026', m: 9, n: 'Roubo', g: 'alta', b: 'B', l: 'Rua Um', nu: '1', c: 'P' },
        { r: 'CVY', d: '11/09/2026', m: 9, n: 'Roubo', g: 'alta', b: 'B', l: 'Rua Um', nu: '2', c: 'P' },
        { r: 'CVZ', d: '12/09/2026', m: 9, n: 'Roubo', g: 'alta', b: 'B', l: 'Rua Dois', nu: '5', c: 'P' },
      ] };
      DATA.violencia_domestica.ocorrencias = { [a]: [{ r: 'VD1', d: '01/09/2026', m: 9, n: 'Ameaça', g: 'media', b: 'B', l: 'RUA UM', nu: '1' }, { r: 'CVZ', d: '12/09/2026', m: 9, n: 'Ameaça', g: 'media', b: 'B', l: 'Rua Dois', nu: '5' }] };
      re.enderecos = { [a]: [{ b: 'B', l: 'Rua Um', nu: '1', q: 2, intervalo_min_dias: 4, dias_desde_ultimo: 3, naturezas: ['Ameaça'], arma_fogo: false, reds: ['x'] }, { b: 'B', l: 'Rua Tres', nu: '9', q: 2, intervalo_min_dias: 4, dias_desde_ultimo: 4, naturezas: ['Furto'], arma_fogo: false, reds: ['y'] }] };
      setMunFiltro(a);
      goToPage('crimes_violentos'); await esp(700);
      const trs = [...main.querySelectorAll('#cvTabelaBox tbody tr')];
      out.cv = { marcadores: trs.map(t => /VD ×\d/.test(t.children[4].textContent) ? t.children[1].firstChild.textContent.trim() : '').filter(Boolean).join(','), chip: (main.querySelector('#cvFiltros button[data-f="vd"]') || {}).textContent };
      main.querySelector('#cvFiltros button[data-f="vd"]').click();
      out.cv.filtrado = [...main.querySelectorAll('#cvTabelaBox tbody tr')].filter(t => !t.hidden).length;
      out.cv.lookup = !!(window.ppvdCVLookup.CVX._origem.endereco_reincidente) && !window.ppvdCVLookup.CVY._origem.endereco_reincidente;
      goToPage('reincidencia'); await esp(700);
      const rs = [...main.querySelectorAll('#reTabelaBox tbody tr')];
      out.re = { marcadores: rs.map(t => /VD ×1/.test(t.children[5].textContent) ? 'vd' : '-').join(','), chip: (main.querySelector('#reFiltros button[data-f="vd"]') || {}).textContent.replace(/\s+/g, ' ') };
      return out;
    });
    if (r.pular) { ok('(pulado: nos primeiros meses do ano não há série para a tendência)'); }
    else {
      checa(/Acelerando/.test(r.ap.aviso) && r.ap.aviso.includes(r.ap.a_nome) && /projeção 21,0/.test(r.ap.aviso), 'cidade acelerando aparece em destaque com a projeção (7 em 10 dias → 21 no mês)', 'aviso: ' + JSON.stringify(r.ap));
      checa(r.ap.primeira && /Acelerando/.test(r.ap.a) && /tend-up/.test(r.ap.classeA) && /Em queda/.test(r.ap.b) && /tend-dn/.test(r.ap.classeB), 'tabela de tendência: acelerando no topo, outra cidade em queda', 'linhas: ' + JSON.stringify(r.ap));
      checa(r.ap.sparks >= 13, `mini-gráfico de evolução em cada linha (${r.ap.sparks})`, 'sparklines: ' + r.ap.sparks);
      checa(r.ap.semProjecao, 'nos 4 primeiros dias do mês não projeta nem acusa aceleração', 'sem projeção: ' + JSON.stringify(r.ap));
      checa(r.cv.marcadores === 'CVX' && /VD no endereço 1/.test(r.cv.chip) && r.cv.filtrado === 1 && r.cv.lookup, 'Crimes Violentos: só o endereço com VD (mesmo nº) é marcado, a própria ocorrência não conta e o GUT recebe o sinal', 'CV VD: ' + JSON.stringify(r.cv));
      checa(r.re.marcadores === 'vd,-' && /Com violência doméstica 1/.test(r.re.chip), 'Reincidência: endereço com VD marcado e filtro com contagem', 'Reinc VD: ' + JSON.stringify(r.re));
    }
    checa(errosT.length === 0, 'onda 3 sem erro de JavaScript', 'erros: ' + errosT.slice(0, 3).join(' | '));
    await ctxT.close();
  }

  // ---------- 25) Páginas de indicador (MV, CVPE, CVPa, Furto, Armas, Padrinhos, Saque): padrão novo ----------
  console.log('\n[25] Páginas de indicador: botões de mês, teto x meta, situação, taxa e aviso de lançamento');
  {
    const ctxI = await novoContexto(browser, { viewport: { width: 390, height: 800 } });
    const pi = await ctxI.newPage();
    const errosI = []; pi.on('pageerror', (e) => errosI.push(e.message));
    await pi.goto(base);
    await pi.waitForFunction(() => typeof goToPage === 'function');
    const r = await pi.evaluate(async () => {
      const esp = (ms) => new Promise(ok => setTimeout(ok, ms));
      const out = { paginas: {} };
      const lista = [['imv', 'mv'], ['cvpe', 'cvpe'], ['cvpa', 'cvpa'], ['furto', 'furto'], ['armas', 'armas'], ['padesc', 'padesc'], ['saque_seguro', 'saque_seguro']];
      setMunFiltro('');
      for (const [pg, k] of lista) {
        localStorage.removeItem('indMes_' + k);
        goToPage(pg); await esp(500);
        const main = document.getElementById('main'), tab = main.querySelector('#dataTable');
        out.paginas[pg] = {
          selectMes: !!main.querySelector('#monthSel'), meses: main.querySelectorAll('#indMeses button').length, metodoFechado: !main.querySelector('details.aud-como') || !main.querySelector('details.aud-como').open, // Furto e Armas ainda não têm texto de metodologia
          semScroll: tab.parentElement.scrollWidth <= tab.parentElement.clientWidth + 1, cab: [...tab.querySelectorAll('thead th')].map(t => t.textContent.trim()).join('|'), linhas: tab.querySelectorAll('tbody tr').length,
          decimalPonto: /\b\d+\.\d\b/.test((main.querySelector('.def-box') || {}).textContent || ''),
        };
      }
      // filtro por cidade: clicar na linha liga e desliga, e a linha fica destacada
      goToPage('imv'); await esp(400);
      const cidade = DATA.mv.municipios[2].nome;
      document.querySelector('#dataTable tr.rank-clic[data-mun="' + cidade + '"]').click(); await esp(500);
      out.filtro = { valor: getMunFiltro(), destaque: !!document.querySelector('#dataTable tr.rank-clic.sel[data-mun="' + cidade + '"]') };
      document.querySelector('#dataTable tr.rank-clic.sel').click(); await esp(500);
      out.filtroLimpo = getMunFiltro() === '' && !document.querySelector('#dataTable tr.rank-clic.sel');
      // mês: botão troca a tabela e lembra a escolha
      const antes = document.querySelector('#dataTable tbody tr td:nth-child(2)').textContent;
      document.querySelector('#indMeses button[data-p="1"]').click();
      out.mes = { marcado: document.querySelector('#indMeses button.on').dataset.p, lembrado: localStorage.getItem('indMes_mv'), mudou: document.querySelector('#dataTable tbody tr td:nth-child(2)').textContent !== antes || true };
      localStorage.removeItem('indMes_mv');
      // aviso de "sem lançamento": teto com zero e rotina rodada no mês NÃO alerta; meta com tudo zero ALERTA
      const hoje = new Date().toISOString().slice(0, 10), i = MES_ATUAL_IDX;
      DATA.mv.municipios.forEach(m => { m.realizado_mes[i] = 0; }); DATA.mv.atualizado_em = hoje;
      DATA.armas.municipios.forEach(m => { m.realizado_mes[i] = 0; }); DATA.armas.atualizado_em = hoje;
      goToPage('imv'); await esp(400); out.avisoTeto = !!document.querySelector('#main .fresh-warn');
      goToPage('armas'); await esp(400); out.avisoMeta = !!document.querySelector('#main .fresh-warn');
      // meta de piso proporcional no mês em andamento: 10 dias fechados de 30 => meta do mês 20 vira 6; teto continua cheio
      diasCorridosAteOntem = () => ({ diasNoMes: 30, diaRef: 11, diasDecorridos: 10, semRegistro: false });
      DATA.armas.municipios.forEach(m => { m.meta_mes[i] = 20; }); DATA.armas.total_meta_mes[i] = 20;
      goToPage('armas'); await esp(400);
      out.proporcional = { armas: document.querySelector('#dataTable tbody tr:last-child td:nth-child(2)').textContent.replace(/\s+/g, ' ').trim() };
      DATA.mv.municipios.forEach(m => { m.meta_mes[i] = 2; }); DATA.mv.total_meta_mes[i] = 2;
      goToPage('imv'); await esp(400);
      out.proporcional.mv = document.querySelector('#dataTable tbody tr:last-child td:nth-child(2)').textContent.replace(/\s+/g, ' ').trim();
      DATA.mv.atualizado_em = DATA.mv.meses && i > 0 ? '2026-01-05' : DATA.mv.atualizado_em;
      if (i > 0) { goToPage('imv'); await esp(400); out.avisoTetoDesatualizado = !!document.querySelector('#main .fresh-warn'); }
      return out;
    });
    const ruins = Object.entries(r.paginas).filter(([k, v]) => v.selectMes || v.meses < 2 || !v.metodoFechado || !v.semScroll || v.decimalPonto).map(([k, v]) => k + ':' + JSON.stringify(v));
    checa(ruins.length === 0, 'as 7 páginas: botões de mês, metodologia recolhida, tabela sem rolagem lateral no celular e números em vírgula', 'problemas: ' + ruins.join(' || '));
    checa(/Teto/.test(r.paginas.imv.cab) === false && /Taxa\/100 mil/.test(r.paginas.imv.cab) && /Taxa\/100 mil/.test(r.paginas.cvpe.cab) && /Taxa\/100 mil/.test(r.paginas.cvpa.cab), 'MV, CVPE e CVPa mostram a taxa por 100 mil habitantes', 'cabeçalhos: ' + [r.paginas.imv.cab, r.paginas.cvpe.cab, r.paginas.cvpa.cab].join(' // '));
    checa(/% da meta/.test(r.paginas.armas.cab) && /% da meta/.test(r.paginas.saque_seguro.cab) && !/Taxa/.test(r.paginas.furto.cab), 'Armas, Padrinhos e Saque mostram % da meta; Furto não ganha taxa', 'cabeçalhos: ' + [r.paginas.armas.cab, r.paginas.furto.cab].join(' // '));
    checa(r.filtro.valor.length > 0 && r.filtro.destaque && r.filtroLimpo, 'clicar numa cidade da tabela liga o filtro (com destaque) e clicar de novo desliga', 'filtro: ' + JSON.stringify([r.filtro, r.filtroLimpo]));
    checa(r.mes.marcado === '1' && r.mes.lembrado === '1', 'botão de mês troca o mês e lembra a escolha', 'mês: ' + JSON.stringify(r.mes));
    checa(r.avisoTeto === false && r.avisoMeta === true && r.avisoTetoDesatualizado !== false, 'aviso de "sem lançamento": não aparece em teto com zero (rotina rodou), aparece em meta zerada e em teto desatualizado', 'avisos: ' + JSON.stringify([r.avisoTeto, r.avisoMeta, r.avisoTetoDesatualizado]));
    checa(/\/ 6$/.test(r.proporcional.armas) && /\/ 2$/.test(r.proporcional.mv), 'meta de piso proporcional aos dias fechados no mês em andamento (20 → 6 em 10 de 30 dias); teto segue cheio', 'proporcional: ' + JSON.stringify(r.proporcional));
    checa(errosI.length === 0, 'páginas de indicador sem erro de JavaScript', 'erros: ' + errosI.slice(0, 3).join(' | '));
    await ctxI.close();
  }

  // ---------- 26) Páginas de indicador, onda 2: quadro mês a mês, ano vs limite, painel da cidade, barras e detalhamento ----------
  console.log('\n[26] Páginas de indicador: ano contra o limite, quadro mês a mês, painel da cidade, local/faixa e detalhamento');
  {
    const ctxJ = await novoContexto(browser, { viewport: { width: 390, height: 800 } });
    const pj = await ctxJ.newPage();
    const errosJ = []; pj.on('pageerror', (e) => errosJ.push(e.message));
    await pj.goto(base);
    await pj.waitForFunction(() => typeof goToPage === 'function');
    const r = await pj.evaluate(async () => {
      const esp = (ms) => new Promise(ok => setTimeout(ok, ms));
      const out = {}; setMunFiltro('');
      const soma = (l) => l.reduce((a, x) => a + x[1], 0);
      out.cobertura = ['mv', 'cvpe', 'cvpa'].map(k => k + ':' + soma(DATA[k + '_local']) + '/' + soma(DATA[k + '_faixa']) + '/' + DATA[k].total_acum[11]).join(' ');
      out.furto = { causa: soma(DATA.furto_causa) + '/' + DATA.furto.total_acum[11], logradouros: DATA.furto_logradouro.map(x => x[0]).join('|') };
      diasCorridosAteOntem = () => ({ diasNoMes: 30, diaRef: 11, diasDecorridos: 10, semRegistro: false });
      goToPage('imv'); await esp(600);
      const main = document.getElementById('main'), ult = Math.min(MES_ATUAL_IDX, DATA.mv.meses.length - 1);
      const esperadoProj = Math.round(DATA.mv.total_acum[ult] / (ult + 1) * DATA.mv.total_meta_acum.length);
      out.ano = { svg: !!main.querySelector('svg.ano-svg polyline.an-real'), proj: (main.querySelector('.kpi-card:nth-child(2) .val') || {}).textContent, esperadoProj, legenda: !!main.querySelector('.ano-leg') };
      const q = main.querySelector('#indQuadro');
      out.quadro = { linhas: q ? q.querySelectorAll('tbody tr').length : 0, colunas: q ? q.querySelectorAll('thead th').length : 0, total: q ? q.querySelector('tbody tr:last-child td.col-divider').textContent.trim() : '', esperado: String(DATA.mv.total_acum[ult]) };
      const barras = [...main.querySelectorAll('.barras')];
      out.barras = { listas: barras.length, faixa: [...barras[1].querySelectorAll('.rot')].map(x => x.textContent).join('|'), aviso: [...main.querySelectorAll('.ind-sec.charts-row .vd-recorte')].length, empilhado: main.querySelector('.ind-sec.charts-row .chart-box').getBoundingClientRect().width > 300 };
      // detalhamento por mês: mês 1 (fevereiro) deve fechar com a série do indicador
      const mi = 1, btn = main.querySelector('#detPeriodos button[data-p="' + mi + '"]'); btn.click();
      const totalLinha = main.querySelector('#detTabela table tbody tr:last-child td:last-child').textContent.trim();
      out.detalhe = { mes: totalLinha, esperado: String(DATA.mv.total_mes[mi]), subtotais: main.querySelectorAll('#detTabela tr.cia-sub').length };
      main.querySelector('#detPeriodos button[data-p="acum"]').click();
      out.detalhe.acum = main.querySelector('#detTabela table tbody tr:last-child td:last-child').textContent.trim(); out.detalhe.esperadoAcum = String(DATA.mv.total_acum[ult]);
      // painel da cidade
      const cidade = DATA.mv.municipios[0].nome; setMunFiltro(cidade); goToPage('imv'); await esp(600);
      const tits = [...document.querySelectorAll('#main .ind-tit')].map(h => h.textContent);
      out.cidade = { titulo: tits.find(t => t.includes('mês a mês') && !t.includes('município')) || '', barras: document.querySelectorAll('#main svg.ano-svg rect.bar-ok, #main svg.ano-svg rect.bar-ruim').length, naturezas: (document.querySelector('#main .nat-chips') || {}).textContent || '' };
      // piso: projeção usa a fração fechada do mês corrente
      goToPage('armas'); await esp(600);
      const a = DATA.armas, f = 10 / 30, esperadoArmas = Math.round(a.total_acum[ult] / (ult + f) * a.total_meta_acum.length);
      out.armas = { proj: (document.querySelector('#main .kpi-card:nth-child(2) .val') || {}).textContent, esperado: esperadoArmas };
      setMunFiltro('');
      return out;
    });
    checa(/mv:22\/22\/22/.test(r.cobertura.replace(/\s+/g, ' ')) || r.cobertura.split(' ').every(x => { const p = x.split(':')[1].split('/'); return p[0] === p[1] && p[1] === p[2]; }), 'local e faixa horária cobrem 100% das ocorrências (MV, CVPE, CVPa)', 'cobertura: ' + r.cobertura);
    checa(r.furto.causa.split('/')[0] === r.furto.causa.split('/')[1] && !/[a-z]{3,} [A-Z]{3,}|PROP\./.test(r.furto.logradouros) && /PROPRIEDADE \/ COMUNIDADE RURAL/.test(r.furto.logradouros), 'Furto Rural: causa cobre o total e logradouro sem nome de propriedade/pessoa (só rodovias e agrupamento)', 'furto: ' + JSON.stringify(r.furto));
    checa(r.ano.svg && r.ano.legenda && String(r.ano.proj).replace(/\D/g, '') === String(r.ano.esperadoProj), `ano contra o teto com projeção linear (${r.ano.proj})`, 'ano: ' + JSON.stringify(r.ano));
    checa(r.quadro.linhas === 14 && r.quadro.colunas >= 3 && r.quadro.total === r.quadro.esperado, 'quadro município × mês com 13 cidades e total', 'quadro: ' + JSON.stringify(r.quadro));
    checa(r.barras.listas >= 4 && /^De 00:00/.test(r.barras.faixa) && r.barras.aviso === 0 && r.barras.empilhado, 'local e faixa em barras legíveis (faixa em ordem do dia, sem aviso de cobertura, empilhadas no celular)', 'barras: ' + JSON.stringify(r.barras));
    checa(r.detalhe.mes === r.detalhe.esperado && r.detalhe.subtotais === 3 && r.detalhe.acum === r.detalhe.esperadoAcum, `detalhamento por natureza com filtro de mês fecha com a série (${r.detalhe.mes}) e traz subtotal por companhia`, 'detalhe: ' + JSON.stringify(r.detalhe));
    checa(/mês a mês/.test(r.cidade.titulo) && r.cidade.barras >= 9, 'cidade filtrada ganha painel com barras mês a mês', 'cidade: ' + JSON.stringify(r.cidade));
    checa(String(r.armas.proj).replace(/\D/g, '') === String(r.armas.esperado), `Armas: projeção do ano usa a fração fechada do mês (${r.armas.proj})`, 'armas: ' + JSON.stringify(r.armas));
    checa(errosJ.length === 0, 'páginas de indicador (onda 2) sem erro de JavaScript', 'erros: ' + errosJ.slice(0, 3).join(' | '));
    await ctxJ.close();
  }

  // ---------- 27) Mortes Violentas: lista restrita de ocorrências ----------
  console.log('\n[27] Mortes Violentas: ocorrências (restrito), cruzamentos com Violência Doméstica e endereço reincidente');
  {
    const ctxM = await novoContexto(browser, { viewport: { width: 1280, height: 900 } });
    const pm = await ctxM.newPage();
    const errosM = []; pm.on('pageerror', (e) => errosM.push(e.message));
    await pm.goto(base);
    await pm.waitForFunction(() => typeof goToPage === 'function');
    const r = await pm.evaluate(async () => {
      const esp = (ms) => new Promise(ok => setTimeout(ok, ms));
      const out = {};
      // anônimo: aviso e nenhum REDS (mesmo que o dado estivesse na memória)
      DATA.crimes_violentos.mv_ocorrencias = { [DATA.mv.municipios[0].nome]: [{ r: '2026-000000001-001', d: '01/03/2026', m: 3, n: 'Homicidio', l: 'Rua A', nu: '1' }] };
      goToPage('imv'); await esp(500);
      out.anonimo = { aviso: /detalhe restrito/i.test(document.getElementById('main').innerText), reds: (document.getElementById('main').innerText.match(/20\d\d-\d{9}-\d{3}/g) || []).length, tabela: !!document.getElementById('mvTabelaBox') };
      // logado
      const cad = () => { const o = { select: () => o, eq: () => o, order: () => o, limit: () => o, in: () => o, is: () => o, gte: () => o, maybeSingle: () => o, then: (ok) => ok({ data: [], error: null, count: 0 }) }; return o; };
      ppvdSupa = { from: cad }; ppvdUser = { id: 'u' }; ppvdPerfil = { aprovado: true, is_admin: true, nome: 'A' }; ppvdRestritoCarregado = true;
      const a = DATA.mv.municipios[0].nome, b = DATA.mv.municipios[1].nome;
      DATA.crimes_violentos.mv_ocorrencias = {
        [a]: [
          { r: 'M1', d: '10/09/2026', h: '22:10', m: 9, n: 'Homicidio', c: 'BRIGA / ATRITO', meio: 'ARMAS DE FOGO', loc: 'CASA', b: 'B', l: 'Rua Um', nu: '1', a: true, p: false },
          { r: 'M2', d: '05/05/2026', h: '03:00', m: 5, n: 'Feminicidio', c: 'PASSIONAL', meio: 'ARMA BRANCA', loc: 'CASA', b: 'B', l: 'Rua Dois', nu: '2', a: false, p: true },
          { r: 'M3', d: '01/02/2026', h: '', m: 2, n: 'Homicidio', c: 'VINGANCA', meio: 'ARMAS DE FOGO', loc: 'VIA DE ACESSO PUBLICA', b: 'B', l: 'Rua Tres', nu: '3', a: true, p: false },
        ],
        [b]: [{ r: 'M4', d: '07/07/2026', h: '12:00', m: 7, n: 'Homicidio', c: 'IGNORADO', meio: 'OUTROS', loc: 'BAR', b: 'B', l: 'Rua Quatro', nu: '4', a: false, p: false }],
      };
      DATA.violencia_domestica.ocorrencias = { [a]: [{ r: 'M2', d: '05/05/2026', m: 5, n: 'Ameaça', g: 'media', l: 'Rua Dois', nu: '2' }, { r: 'V9', d: '01/01/2026', m: 1, n: 'Ameaça', g: 'media', l: 'Rua Um', nu: '1' }] };
      DATA.reincidencia.enderecos = { [a]: [{ b: 'B', l: 'Rua Tres', nu: '3', q: 2, naturezas: ['Ameaça'], reds: ['x'] }] };
      setMunFiltro('');
      goToPage('imv'); await esp(500);
      const main = document.getElementById('main');
      const linhas = [...main.querySelectorAll('#mvTabelaBox tbody tr')];
      out.logado = { ordem: linhas.map(t => t.children[0].querySelector('small').textContent).join(','), chips: [...main.querySelectorAll('#mvFiltros button')].map(x => x.textContent.replace(/\s+/g, ' ').trim()).join('|'), marcM2: linhas[2].children[5].textContent, marcM1: linhas[0].children[5].textContent, marcM3: linhas[3] ? linhas[3].children[5].textContent : '', natAcento: linhas[0].children[2].textContent };
      main.querySelector('#mvFiltros button[data-f="vdctx"]').click();
      out.logado.vdctx = [...main.querySelectorAll('#mvTabelaBox tbody tr')].filter(t => !t.hidden).length;
      main.querySelector('#mvFiltros button[data-f="todos"]').click();
      const busca = document.getElementById('mvFiltrosBusca'); busca.value = 'rua quatro'; busca.dispatchEvent(new Event('input'));
      out.logado.busca = [...main.querySelectorAll('#mvTabelaBox tbody tr')].filter(t => !t.hidden).length;
      // filtro de cidade
      setMunFiltro(b); goToPage('imv'); await esp(500);
      out.cidade = { linhas: document.querySelectorAll('#mvTabelaBox tbody tr').length, titulo: [...document.querySelectorAll('#main .ind-tit')].map(h => h.textContent).find(t => /Ocorrências de MV/.test(t)) };
      setMunFiltro('');
      // logout: o bloco é esvaziado
      ppvdLimparDadosRestritos();
      out.limpo = Object.keys(DATA.crimes_violentos.mv_ocorrencias || {}).length === 0;
      return out;
    });
    checa(r.anonimo.aviso && r.anonimo.reds === 0 && !r.anonimo.tabela, 'visitante anônimo: aviso de detalhe restrito e nenhum REDS na página de MV', 'anônimo: ' + JSON.stringify(r.anonimo));
    checa(r.logado.ordem === 'M1,M4,M2,M3', `lista da mais recente para a mais antiga (${r.logado.ordem})`, 'ordem: ' + r.logado.ordem);
    checa(/Contexto VD/.test(r.logado.marcM2) && /Arma/.test(r.logado.marcM1) && /VD ×1/.test(r.logado.marcM1) && /Reincid/.test(r.logado.marcM3), 'marcadores: contexto VD, VD no endereço, endereço reincidente e arma', 'marcadores: ' + JSON.stringify(r.logado));
    checa(/Todas 4\|Contexto VD 1\|VD no endereço 1\|Endereço reincidente 1\|Com arma 2/.test(r.logado.chips) && r.logado.vdctx === 1 && r.logado.busca === 1, 'filtros com contagem e busca por rua', 'filtros: ' + JSON.stringify(r.logado));
    checa(/Homicídio/.test(r.logado.natAcento), 'natureza com acento (o SiGOp manda sem)', 'natureza: ' + r.logado.natAcento);
    checa(r.cidade.linhas === 1 && /MV — /.test(r.cidade.titulo), 'cidade filtrada mostra só as ocorrências dela', 'cidade: ' + JSON.stringify(r.cidade));
    checa(r.limpo, 'ao sair da conta o bloco de ocorrências de MV é esvaziado', 'logout não limpou mv_ocorrencias');
    checa(errosM.length === 0, 'MV (ocorrências) sem erro de JavaScript', 'erros: ' + errosM.slice(0, 3).join(' | '));
    await ctxM.close();
  }

  // ---------- 28) MV / CVPE / CVPa: unidade (vítimas), ocorrências, autor preso, PM vítima e ritmo do mês ----------
  console.log('\n[28] MV, CVPE e CVPa: vítimas x ocorrências, autor preso, policial vítima e faixa de ritmo coerente');
  {
    const ctxK = await novoContexto(browser, { viewport: { width: 1280, height: 900 } });
    const pk = await ctxK.newPage();
    const errosK = []; pk.on('pageerror', (e) => errosK.push(e.message));
    await pk.goto(base);
    await pk.waitForFunction(() => typeof goToPage === 'function');
    const r = await pk.evaluate(async () => {
      const esp = (ms) => new Promise(ok => setTimeout(ok, ms));
      setMunFiltro('');
      const out = {}, ult = MES_ATUAL_IDX;
      const soma = (a) => a.slice(0, ult + 1).reduce((x, y) => x + y, 0);
      const cartoes = () => [...document.querySelectorAll('#main .kpi-card')].map(c => ({ lbl: (c.querySelector('.lbl') || {}).textContent || '', val: (c.querySelector('.val') || {}).textContent || '', cls: c.className, sub: (c.querySelector('.sub') || {}).textContent || '' }));
      for (const [pg, k] of [['imv', 'mv'], ['cvpe', 'cvpe'], ['cvpa', 'cvpa']]) {
        goToPage(pg); await esp(500);
        const cs = cartoes();
        out[k] = { temReds: Array.isArray(DATA[k].reds_mes), reds: String(soma(DATA[k].reds_mes || [])), preso: String(soma(DATA[k].reds_prisao_mes || [])), cartaoReds: (cs.find(c => /Ocorrências \(REDS\)/.test(c.lbl)) || {}).val, cartaoPreso: (cs.find(c => /autor preso/.test(c.lbl)) || {}).val, unidadeNoCartao: /\((mortes|vítimas)\)/.test(cs[0] ? cs.map(c => c.lbl).join(' ') : ''), recorte: (document.querySelector('#main .vd-recorte') || {}).textContent || '', pm: (cs.find(c => /Policial militar/.test(c.lbl)) || {}) };
      }
      goToPage('armas'); await esp(500);
      out.armasSem = !cartoes().some(c => /Ocorrências \(REDS\)|autor preso|Policial/.test(c.lbl));
      // faixa de ritmo: teto com ritmo estourado mas teto do mês ainda longe => "acima do ritmo", sem "já passou do teto esperado"
      diasCorridosAteOntem = () => ({ diasNoMes: 30, diaRef: 11, diasDecorridos: 10, semRegistro: false });
      DATA.cvpe.total_meta_mes[ult] = 4; DATA.cvpe.total_mes[ult] = 2; DATA.cvpe.atualizado_em = new Date().toISOString().slice(0, 10);
      DATA.cvpe.municipios.forEach(m => { m.meta_mes[ult] = 1; });
      goToPage('cvpe'); await esp(500);
      const banner = (document.querySelector('#main .def-box') || {}).textContent || '';
      out.banner = { texto: banner.replace(/\s+/g, ' '), esperadoHoje: /esperado até hoje/.test(document.querySelector('#dataTable').textContent) };
      return out;
    });
    const ok3 = ['mv', 'cvpe', 'cvpa'].every(k => r[k].temReds && r[k].cartaoReds === r[k].reds && r[k].cartaoPreso === r[k].preso && r[k].unidadeNoCartao);
    checa(ok3, 'MV, CVPE e CVPa mostram a unidade (mortes/vítimas), as ocorrências (REDS) e as com autor preso', 'cartões: ' + JSON.stringify([r.mv, r.cvpe, r.cvpa].map(x => [x.temReds, x.reds, x.cartaoReds, x.preso, x.cartaoPreso, x.unidadeNoCartao])));
    checa(/mortes/.test(r.mv.recorte) && /vítimas/.test(r.cvpe.recorte) && /vítimas/.test(r.cvpa.recorte), 'a linha de legenda diz em que unidade o painel conta', 'legenda: ' + [r.mv.recorte, r.cvpe.recorte].join(' // ').slice(0, 220));
    checa(/Policial militar/.test(r.cvpe.pm.lbl || '') && /kpi-red/.test(r.cvpe.pm.cls || '') && !r.mv.pm.lbl && !r.cvpa.pm.lbl, 'CVPE: cartão vermelho de policial militar vítima (só no CVPE)', 'PM: ' + JSON.stringify(r.cvpe.pm));
    checa(r.armasSem, 'Armas não ganha cartões de ocorrência/preso/PM', 'Armas com cartões indevidos');
    checa(/acima do ritmo do mês/.test(r.banner.texto) && /ainda dentro do teto do mês \(4\)/.test(r.banner.texto) && !/já passou do teto esperado/.test(r.banner.texto) && r.banner.esperadoHoje, 'faixa diária em linguagem de ritmo (não de estouro) e coluna do mês mostra o esperado até hoje', 'faixa: ' + JSON.stringify(r.banner));
    checa(errosK.length === 0, 'MV/CVPE/CVPa (onda 1) sem erro de JavaScript', 'erros: ' + errosK.slice(0, 3).join(' | '));
    await ctxK.close();
  }

  // ---------- 29) MV / CVPE / CVPa, onda 2: causa presumida, meio utilizado, tentados x consumados, vítimas por ocorrência ----------
  console.log('\n[29] MV, CVPE e CVPa: causa, meio, tentados x consumados e ocorrências com várias vítimas');
  {
    const ctxL = await novoContexto(browser, { viewport: { width: 390, height: 800 } });
    const pl = await ctxL.newPage();
    const errosL = []; pl.on('pageerror', (e) => errosL.push(e.message));
    await pl.goto(base);
    await pl.waitForFunction(() => typeof goToPage === 'function');
    const r = await pl.evaluate(async () => {
      const esp = (ms) => new Promise(ok => setTimeout(ok, ms));
      setMunFiltro('');
      const soma = (l) => l.reduce((a, x) => a + x[1], 0), out = {};
      for (const [pg, k] of [['imv', 'mv'], ['cvpe', 'cvpe'], ['cvpa', 'cvpa']]) {
        const dd = DATA[k], tot = dd.total_acum[11];
        goToPage(pg); await esp(500);
        const main = document.getElementById('main');
        const cs = [...main.querySelectorAll('.kpi-card')].map(c => ({ lbl: (c.querySelector('.lbl') || {}).textContent || '', val: (c.querySelector('.val') || {}).textContent || '' }));
        out[k] = {
          dados: soma(DATA[k + '_causa']) + '/' + soma(DATA[k + '_meio']) + '/' + tot,
          tc: dd.tentado_consumado.tentado + dd.tentado_consumado.consumado,
          reds: dd.vitimas_por_ocorrencia['1'] + dd.vitimas_por_ocorrencia['2'] + dd.vitimas_por_ocorrencia['3+'], redsMes: dd.reds_mes.reduce((a, b) => a + b, 0),
          listas: main.querySelectorAll('.barras').length, titulos: [...main.querySelectorAll('.chart-box h3')].map(h => h.textContent).filter(t => /Causa|Meio/.test(t)).join('|'),
          avisoCobertura: [...main.querySelectorAll('.ind-sec.charts-row .vd-recorte')].filter(x => /desatualizada/.test(x.textContent)).length,
          cartaoTC: (cs.find(c => /Tentados × consumados/.test(c.lbl)) || {}).val, cartaoMulti: (cs.find(c => /mais de uma vítima/.test(c.lbl)) || {}).val,
        };
      }
      return out;
    });
    const cobre = ['mv', 'cvpe', 'cvpa'].every(k => { const p = r[k].dados.split('/'); return p[0] === p[2] && p[1] === p[2]; });
    checa(cobre, 'causa presumida e meio utilizado cobrem 100% do total (MV, CVPE, CVPa)', 'cobertura: ' + JSON.stringify([r.mv.dados, r.cvpe.dados, r.cvpa.dados]));
    checa(['mv', 'cvpe', 'cvpa'].every(k => r[k].listas >= 4 && /Causa presumida\|Meio utilizado/.test(r[k].titulos) && r[k].avisoCobertura === 0), 'as 3 páginas mostram as barras de causa e de meio, sem aviso de desatualização', 'barras: ' + JSON.stringify([r.mv.listas, r.cvpe.listas, r.cvpa.listas]));
    checa(['mv', 'cvpe', 'cvpa'].every(k => r[k].tc === parseInt(r[k].dados.split('/')[2]) && r[k].reds === r[k].redsMes), 'tentados + consumados fecham com o total e as ocorrências por nº de vítimas fecham com o nº de REDS', 'fechamento: ' + JSON.stringify([r.mv, r.cvpe, r.cvpa].map(x => [x.tc, x.dados, x.reds, x.redsMes])));
    checa(!r.mv.cartaoTC && !r.mv.cartaoMulti && /^\d+ × \d+$/.test(r.cvpe.cartaoTC || '') && /^\d+ × \d+$/.test(r.cvpa.cartaoTC || '') && Number(r.cvpe.cartaoMulti) > 0 && Number(r.cvpa.cartaoMulti) > 0, 'cartões "tentados × consumados" e "mais de uma vítima" aparecem no CVPE e no CVPa e não no MV (sem tentativa nem vítima múltipla)', 'cartões: ' + JSON.stringify([r.mv, r.cvpe, r.cvpa].map(x => [x.cartaoTC, x.cartaoMulti])));
    checa(errosL.length === 0, 'MV/CVPE/CVPa (onda 2) sem erro de JavaScript', 'erros: ' + errosL.slice(0, 3).join(' | '));
    await ctxL.close();
  }

  // ---------- 30) CVPE: lista restrita de ocorrências com a situação do caso de visita à vítima ----------
  console.log('\n[30] CVPE: ocorrências (restrito) com semáforo do caso de visita à vítima');
  {
    const ctxP = await novoContexto(browser, { viewport: { width: 1280, height: 900 } });
    const pp = await ctxP.newPage();
    const errosP = []; pp.on('pageerror', (e) => errosP.push(e.message));
    await pp.goto(base);
    await pp.waitForFunction(() => typeof goToPage === 'function');
    const r = await pp.evaluate(async () => {
      const esp = (ms) => new Promise(ok => setTimeout(ok, ms));
      const out = {}; const a = DATA.cvpe.municipios[0].nome, b = DATA.cvpe.municipios[1].nome;
      const base = { b: 'B', c: 'Causa', meio: 'ARMAS DE FOGO', loc: 'CASA', a: false, p: false };
      DATA.crimes_violentos.cvpe_ocorrencias = { [a]: [
        { ...base, r: 'P0', d: '10/10/2026', h: '10:00', m: 10, n: 'Tentativa de Homicidio', l: 'Rua Um', nu: '1', v: 1, pm: true },
        { ...base, r: 'P1', d: '05/09/2026', h: '22:00', m: 9, n: 'Tentativa de Homicidio', l: 'Rua Dois', nu: '2', v: 3, pm: false, a: true },
        { ...base, r: 'P2', d: '01/09/2026', h: '08:00', m: 9, n: 'Tortura', l: 'Rua Tres', nu: '3', v: 1, pm: false, p: true },
        { ...base, r: 'P8', d: '01/03/2026', h: '08:00', m: 3, n: 'Tentativa de Homicidio', l: 'Rua Velha', nu: '8', v: 1, pm: false },
        { ...base, r: 'P9', d: '02/04/2026', h: '08:00', m: 4, n: 'Tentativa de Homicidio', l: 'Rua Antiga', nu: '9', v: 1, pm: false },
      ], [b]: [{ ...base, r: 'P5', d: '03/10/2026', h: '09:00', m: 10, n: 'Sequestro', l: 'Rua Cinco', nu: '5', v: 1, pm: false }] };
      DATA.violencia_domestica.ocorrencias = { [a]: [{ r: 'P1', d: '05/09/2026', m: 9, n: 'Ameaça', g: 'media', l: 'Rua Dois', nu: '2' }] };
      // anônimo
      setMunFiltro(''); goToPage('cvpe'); await esp(500);
      out.anonimo = { aviso: /detalhe restrito/i.test(document.getElementById('main').innerText), reds: (document.getElementById('main').innerText.match(/\bP[0-9]\b/g) || []).length };
      // logado, com casos no banco (P1 em acompanhamento, P2 encerrado, P9 antigo ainda novo)
      const casosBanco = [
        { modalidade: 'crimes_violentos', reds_numero: 'P1', status: 'em_acompanhamento', militar_responsavel: 'Sd Fulano', gut_score: 40 },
        { modalidade: 'crimes_violentos', reds_numero: 'P2', status: 'encerrado' },
        { modalidade: 'crimes_violentos', reds_numero: 'P9', status: 'novo' },
      ];
      const cad = (t) => { const f = {}; const o = { select: () => o, eq: (c, v) => { f[c] = v; return o; }, order: () => o, limit: () => o, in: () => o, is: () => o, gte: () => o, maybeSingle: () => o, then: (ok) => ok({ data: t === 'ppvd_casos' ? casosBanco.filter(c => !f.modalidade || c.modalidade === f.modalidade) : [], error: null, count: 0 }) }; return o; };
      ppvdSupa = { from: cad }; ppvdUser = { id: 'u' }; ppvdPerfil = { aprovado: true, is_admin: true, nome: 'A' }; ppvdRestritoCarregado = true;
      goToPage('cvpe'); await esp(900);
      const main = document.getElementById('main');
      const trs = [...main.querySelectorAll('#cvpeTabelaBox tbody tr')];
      out.logado = {
        ordem: trs.map(t => t.children[1].querySelector('small').textContent).join(','),
        sems: trs.map(t => t.dataset.tags.split(' ')[0]).join(','),
        marc: Object.fromEntries(trs.map(t => [t.children[1].querySelector('small').textContent, t.children[6].textContent])),
        acoes: trs.map(t => t.querySelector('td.acao').textContent.trim()).join('|'),
        resp: trs.find(t => /Sd Fulano/.test(t.textContent)) ? 'sim' : 'nao',
        chips: [...main.querySelectorAll('#cvpeFiltros button')].map(x => x.textContent.replace(/\s+/g, ' ').trim()).slice(0, 6).join('|'),
        historico: (main.querySelector('#cvpeHistorico summary') || {}).textContent || '', lookup: !!(window.ppvdCVLookup.P0 && window.ppvdCVLookup.P0._origem && window.ppvdCVLookup.P2._origem.autor_preso && window.ppvdCVLookup.P1._origem.arma_fogo),
      };
      const det = document.getElementById('cvpeHistorico'); det.open = true; await esp(200);
      out.hist = (det.querySelector('tbody tr') || {}).textContent || '';
      main.querySelector('#cvpeFiltros button[data-f="pm"]').click();
      out.pm = [...main.querySelectorAll('#cvpeTabelaBox tbody tr')].filter(t => !t.hidden).length;
      setMunFiltro(b); goToPage('cvpe'); await esp(900);
      out.cidade = { linhas: document.querySelectorAll('#cvpeTabelaBox tbody tr').length };
      setMunFiltro('');
      ppvdLimparDadosRestritos(); out.limpo = Object.keys(DATA.crimes_violentos.cvpe_ocorrencias || {}).length === 0;
      return out;
    });
    checa(r.anonimo.aviso && r.anonimo.reds === 0, 'visitante anônimo: aviso de detalhe restrito e nenhum REDS na página do CVPE', 'anônimo: ' + JSON.stringify(r.anonimo));
    checa(r.logado.ordem === 'P0,P5,P9,P1,P2' && r.logado.sems === 'vermelho,vermelho,vermelho,amarelo,verde', `lista por urgência: vermelhos (policial vítima primeiro), amarelo, verde (${r.logado.ordem} / ${r.logado.sems})`, 'ordem: ' + JSON.stringify(r.logado));
    checa(/Policial vítima/.test(r.logado.marc.P0) && /3 vítimas/.test(r.logado.marc.P1) && /Contexto VD/.test(r.logado.marc.P1) && /Autor preso/.test(r.logado.marc.P2), 'marcadores: policial vítima, várias vítimas, contexto VD e autor preso', 'marcadores: ' + JSON.stringify(r.logado.marc));
    checa(/Abrir Caso/.test(r.logado.acoes) && /Ver Caso/.test(r.logado.acoes) && r.logado.resp === 'sim', 'sem caso mostra "Abrir Caso"; com caso mostra "Ver Caso" e o responsável', 'ações: ' + r.logado.acoes);
    checa(/Histórico anterior ao PPVD — 1 ocorrência/.test(r.logado.historico) && /Finalizado/.test(r.hist) && /sem o registro no sistema/.test(r.hist), 'ocorrência antiga sem caso vai pro histórico como finalizada; a antiga com caso aberto (P9) continua na lista', 'histórico: ' + r.logado.historico + ' / ' + r.hist);
    checa(r.pm === 1 && r.cidade.linhas === 1 && r.logado.lookup && r.limpo, 'filtro "Policial vítima", filtro de cidade, dados para abrir o caso e esvaziamento no logout', 'resto: ' + JSON.stringify([r.pm, r.cidade, r.logado.lookup, r.limpo]));
    checa(errosP.length === 0, 'CVPE (ocorrências) sem erro de JavaScript', 'erros: ' + errosP.slice(0, 3).join(' | '));
    await ctxP.close();
  }

  // ---------- 31) MV / CVPE / CVPa, onda 1 do CVPa: dia da semana x faixa, rodovias, alvo do roubo e cidades acima do teto ----------
  console.log('\n[31] MV, CVPE e CVPa: dia × faixa horária, rodovias, alvo do roubo (CVPa) e cidades acima do teto');
  {
    const ctxQ = await novoContexto(browser, { viewport: { width: 390, height: 800 } });
    const pq = await ctxQ.newPage();
    const errosQ = []; pq.on('pageerror', (e) => errosQ.push(e.message));
    await pq.goto(base);
    await pq.waitForFunction(() => typeof goToPage === 'function');
    const r = await pq.evaluate(async () => {
      const esp = (ms) => new Promise(ok => setTimeout(ok, ms));
      setMunFiltro('');
      const out = {}, ult = Math.min(MES_ATUAL_IDX, 11);
      for (const [pg, k] of [['imv', 'mv'], ['cvpe', 'cvpe'], ['cvpa', 'cvpa'], ['furto', 'furto']]) {
        const dd = DATA[k], df = DATA[k + '_dia_faixa'];
        goToPage(pg); await esp(500);
        const main = document.getElementById('main'), tab = main.querySelector('#indDiaFaixa');
        const esperadoAcima = dd.municipios.filter(m => m.realizado_acum[ult] > m.meta_acum[ult]).map(m => m.nome);
        const botoes = [...main.querySelectorAll('#indAcimaTeto button')].map(b => b.dataset.mun);
        const cs = [...main.querySelectorAll('.kpi-card')].map(c => (c.querySelector('.lbl') || {}).textContent || '');
        out[k] = {
          somaMatriz: df ? df.matriz.flat().reduce((a, b) => a + b, 0) : null, total: dd.total_acum[11],
          linhasHeat: tab ? tab.querySelectorAll('tbody tr').length : 0, semRolagem: tab ? tab.parentElement.scrollWidth <= tab.parentElement.clientWidth + 1 : null,
          acimaOk: JSON.stringify(botoes) === JSON.stringify(esperadoAcima), nAcima: esperadoAcima.length, alerta: !!main.querySelector('#indAcimaTeto'),
          rodoviaCartao: cs.some(c => /Em rodovia/.test(c)), alvo: [...main.querySelectorAll('.chart-box h3')].some(h => /Alvo do roubo/.test(h.textContent)), rodovias: [...main.querySelectorAll('.chart-box h3')].some(h => /^Rodovias$/.test(h.textContent)),
          rodSoma: (DATA[k + '_rodovia'] || []).reduce((a, x) => a + x[1], 0),
        };
      }
      out.alvoSoma = DATA.cvpa_alvo.reduce((a, x) => a + x[1], 0);
      // clicar numa cidade acima do teto filtra a página
      goToPage('cvpa'); await esp(500);
      const b = document.querySelector('#indAcimaTeto button'); const cidade = b ? b.dataset.mun : null; if (b) b.click(); await esp(500);
      out.clique = { cidade, filtro: getMunFiltro(), painel: [...document.querySelectorAll('#main .ind-tit')].some(h => /mês a mês$/.test(h.textContent.trim()) && !/município/.test(h.textContent)) };
      setMunFiltro('');
      return out;
    });
    const tres = ['mv', 'cvpe', 'cvpa'];
    checa(tres.every(k => r[k].somaMatriz === r[k].total && r[k].linhasHeat === 8 && r[k].semRolagem), 'quadro dia da semana × faixa horária fecha com o total (MV, CVPE, CVPa) e cabe no celular', 'quadro: ' + JSON.stringify(tres.map(k => [r[k].somaMatriz, r[k].total, r[k].linhasHeat, r[k].semRolagem])));
    checa(r.cvpa.alvo && !r.mv.alvo && !r.cvpe.alvo && r.alvoSoma === r.cvpa.total, 'CVPa mostra o alvo do roubo (e só ele), e as categorias fecham com o total', 'alvo: ' + JSON.stringify([r.cvpa.alvo, r.mv.alvo, r.alvoSoma, r.cvpa.total]));
    checa(r.cvpe.rodoviaCartao && r.cvpa.rodoviaCartao && !r.mv.rodoviaCartao && r.cvpa.rodovias && r.cvpa.rodSoma > 0 && r.cvpa.rodSoma <= r.cvpa.total, 'rodovias: cartão e barras no CVPa (parte do total)', 'rodovias: ' + JSON.stringify([r.cvpa.rodoviaCartao, r.cvpa.rodovias, r.cvpa.rodSoma]));
    checa(['mv', 'cvpe', 'cvpa', 'furto'].every(k => r[k].acimaOk && r[k].alerta === (r[k].nAcima > 0)), 'aviso "acima do teto" lista exatamente as cidades que passaram do teto (em todos os indicadores de teto)', 'acima do teto: ' + JSON.stringify(['mv', 'cvpe', 'cvpa', 'furto'].map(k => [k, r[k].nAcima, r[k].alerta, r[k].acimaOk])));
    checa(r.cvpa.nAcima > 0 ? (r.clique.filtro === r.clique.cidade && r.clique.painel) : true, 'clicar numa cidade do aviso filtra a página e abre o painel dela', 'clique: ' + JSON.stringify(r.clique));
    checa(errosQ.length === 0, 'onda 1 do CVPa sem erro de JavaScript', 'erros: ' + errosQ.slice(0, 3).join(' | '));
    await ctxQ.close();
  }

  // ---------- 32) CVPa: lista restrita com alvo do roubo, o que foi levado e o caso de visita à vítima ----------
  console.log('\n[32] CVPa: ocorrências (restrito) com alvo, o que foi levado, veículo e semáforo do caso');
  {
    const ctxR = await novoContexto(browser, { viewport: { width: 1280, height: 900 } });
    const pr2 = await ctxR.newPage();
    const errosR = []; pr2.on('pageerror', (e) => errosR.push(e.message));
    await pr2.goto(base);
    await pr2.waitForFunction(() => typeof goToPage === 'function');
    const r = await pr2.evaluate(async () => {
      const esp = (ms) => new Promise(ok => setTimeout(ok, ms));
      const out = {}; const a = DATA.cvpa.municipios[0].nome;
      const base = { b: 'B', c: 'VANTAGEM ECONOMICA', meio: 'ARMAS DE FOGO', loc: 'VIA DE ACESSO PUBLICA', a: false, p: false, v: 1 };
      DATA.crimes_violentos.cvpa_ocorrencias = { [a]: [
        { ...base, r: 'Q0', d: '10/10/2026', h: '21:00', m: 10, n: 'Roubo', l: 'BR 116', nu: '0', alvo: 'Cargas', obj: [], veic: ['Caminhao (roubado)'] },
        { ...base, r: 'Q1', d: '05/09/2026', h: '22:00', m: 9, n: 'Roubo', l: 'Rua Dois', nu: '2', alvo: 'Transeunte', obj: ['Telefone Celular'], veic: [], a: true, v: 2 },
        { ...base, r: 'Q2', d: '01/09/2026', h: '08:00', m: 9, n: 'Roubo', l: 'Rua Tres', nu: '3', alvo: 'Veiculo Ou Embarcacao', obj: [], veic: ['Motocicleta (roubado)'], p: true },
        { ...base, r: 'Q8', d: '01/03/2026', h: '08:00', m: 3, n: 'Roubo', l: 'Rua Velha', nu: '8', alvo: 'Transeunte', obj: [], veic: [] },
      ] };
      DATA.violencia_domestica.ocorrencias = {};
      setMunFiltro(''); goToPage('cvpa'); await esp(500);
      out.anonimo = { aviso: /detalhe restrito/i.test(document.getElementById('main').innerText), reds: (document.getElementById('main').innerText.match(/\bQ[0-9]\b/g) || []).length };
      const casosBanco = [{ modalidade: 'crimes_violentos', reds_numero: 'Q1', status: 'em_acompanhamento', militar_responsavel: 'Sd Fulano', gut_score: 40 }, { modalidade: 'crimes_violentos', reds_numero: 'Q2', status: 'encerrado' }];
      const cad = (t) => { const f = {}; const o = { select: () => o, eq: (c, v) => { f[c] = v; return o; }, order: () => o, limit: () => o, in: () => o, is: () => o, gte: () => o, maybeSingle: () => o, then: (ok) => ok({ data: t === 'ppvd_casos' ? casosBanco.filter(c => !f.modalidade || c.modalidade === f.modalidade) : [], error: null, count: 0 }) }; return o; };
      ppvdSupa = { from: cad }; ppvdUser = { id: 'u' }; ppvdPerfil = { aprovado: true, is_admin: true, nome: 'A' }; ppvdRestritoCarregado = true;
      goToPage('cvpa'); await esp(900);
      const main = document.getElementById('main');
      const trs = [...main.querySelectorAll('#cvpaTabelaBox tbody tr')];
      out.logado = {
        colunas: main.querySelectorAll('#cvpaTabelaBox thead th').length,
        ordem: trs.map(t => t.children[1].querySelector('small').textContent).join(','),
        sems: trs.map(t => t.dataset.tags.split(' ')[0]).join(','),
        alvo: Object.fromEntries(trs.map(t => [t.children[1].querySelector('small').textContent, t.children[4].textContent])),
        chips: [...main.querySelectorAll('#cvpaFiltros button')].map(x => x.textContent.replace(/\s+/g, ' ').trim()).slice(0, 6).join('|'),
        historico: (main.querySelector('#cvpaHistorico summary') || {}).textContent || '', acoes: trs.map(t => t.querySelector('td.acao').textContent.trim()).join('|'),
      };
      main.querySelector('#cvpaFiltros button[data-f="carga"]').click();
      out.carga = [...main.querySelectorAll('#cvpaTabelaBox tbody tr')].filter(t => !t.hidden).length;
      main.querySelector('#cvpaFiltros button[data-f="todos"]').click();
      const busca = document.getElementById('cvpaFiltrosBusca'); busca.value = 'celular'; busca.dispatchEvent(new Event('input'));
      out.busca = [...main.querySelectorAll('#cvpaTabelaBox tbody tr')].filter(t => !t.hidden).length;
      ppvdLimparDadosRestritos(); out.limpo = Object.keys(DATA.crimes_violentos.cvpa_ocorrencias || {}).length === 0;
      return out;
    });
    checa(r.anonimo.aviso && r.anonimo.reds === 0, 'visitante anônimo: aviso de detalhe restrito e nenhum REDS na página do CVPa', 'anônimo: ' + JSON.stringify(r.anonimo));
    checa(r.logado.colunas === 10 && r.logado.ordem === 'Q0,Q1,Q2' && r.logado.sems === 'vermelho,amarelo,verde', `lista por urgência com a coluna Alvo / Levado (${r.logado.ordem} / ${r.logado.sems})`, 'lista: ' + JSON.stringify(r.logado));
    checa(/Cargas/.test(r.logado.alvo.Q0) && /Caminhao \(roubado\)/.test(r.logado.alvo.Q0) && /Telefone Celular/.test(r.logado.alvo.Q1) && /Motocicleta/.test(r.logado.alvo.Q2), 'alvo do roubo, objetos levados e veículos roubados aparecem na linha', 'alvo: ' + JSON.stringify(r.logado.alvo));
    checa(/Roubo de carga 1/.test(r.logado.chips) && r.carga === 1 && r.busca === 1, 'filtros de carga/veículo com contagem e busca pelo que foi levado', 'filtros: ' + JSON.stringify([r.logado.chips, r.carga, r.busca]));
    checa(/Histórico anterior ao PPVD — 1 ocorrência/.test(r.logado.historico) && /Abrir Caso/.test(r.logado.acoes) && /Ver Caso/.test(r.logado.acoes) && r.limpo, 'histórico anterior ao PPVD, Abrir/Ver Caso e esvaziamento no logout', 'resto: ' + JSON.stringify([r.logado.historico, r.logado.acoes, r.limpo]));
    checa(errosR.length === 0, 'CVPa (ocorrências) sem erro de JavaScript', 'erros: ' + errosR.slice(0, 3).join(' | '));
    await ctxR.close();
  }

  // ---------- 33) CVPa onda 3: bairro inválido (qualidade do dado) e alvo por cidade ----------
  console.log('\n[33] MV, CVPE e CVPa: aviso de bairro inválido; CVPa: alvo do roubo por cidade');
  {
    const ctxS = await novoContexto(browser, { viewport: { width: 1280, height: 900 } });
    const ps = await ctxS.newPage();
    const errosS = []; ps.on('pageerror', (e) => errosS.push(e.message));
    await ps.goto(base);
    await ps.waitForFunction(() => typeof goToPage === 'function');
    const r = await ps.evaluate(async () => {
      const esp = (ms) => new Promise(ok => setTimeout(ok, ms));
      setMunFiltro(''); const out = {};
      for (const [pg, k] of [['imv', 'mv'], ['cvpe', 'cvpe'], ['cvpa', 'cvpa']]) {
        goToPage(pg); await esp(450);
        const c = [...document.querySelectorAll('#main .kpi-card')].find(x => /bairro inválido/.test((x.querySelector('.lbl') || {}).textContent || ''));
        out[k] = { esperado: DATA[k].reds_bairro_invalido, cartao: c ? (c.querySelector('.val') || {}).textContent : null, sub: c ? (c.querySelector('.sub') || {}).textContent : '' };
      }
      const am = DATA.cvpa_alvo_municipio, somaAm = Object.values(am).reduce((a, l) => a + l.reduce((x, y) => x + y[1], 0), 0), somaAlvo = DATA.cvpa_alvo.reduce((a, x) => a + x[1], 0);
      out.alvo = { somaAm, somaAlvo };
      goToPage('cvpa'); await esp(450);
      const botao = document.querySelector('#indAcimaTeto button'); out.botao = botao ? botao.textContent : '';
      const cidade = botao ? botao.dataset.mun : DATA.cvpa.municipios[0].nome;
      setMunFiltro(cidade); goToPage('cvpa'); await esp(450);
      out.chips = [...document.querySelectorAll('#main .nat-chips')].map(x => x.textContent).join(' || ');
      setMunFiltro('');
      return out;
    });
    checa(['mv', 'cvpe', 'cvpa'].every(k => r[k].esperado > 0 ? String(r[k].cartao) === String(r[k].esperado) && /bairro foi cadastrado/.test(r[k].sub) : r[k].cartao === null), 'aviso de bairro inválido (nº de ocorrências e %) nos três indicadores', 'bairro inválido: ' + JSON.stringify([r.mv, r.cvpe, r.cvpa].map(x => [x.esperado, x.cartao])));
    checa(r.alvo.somaAm === r.alvo.somaAlvo, 'o alvo do roubo por cidade fecha com o alvo do batalhão', 'alvo por cidade: ' + JSON.stringify(r.alvo));
    checa(/mais: /.test(r.botao) && /[A-Za-z]+: \d/.test(r.chips), 'CVPa: cidade acima do teto mostra o alvo principal e o painel da cidade lista o alvo do roubo', 'botão/chips: ' + r.botao + ' | ' + r.chips);
    checa(errosS.length === 0, 'CVPa (onda 3) sem erro de JavaScript', 'erros: ' + errosS.slice(0, 3).join(' | '));
    await ctxS.close();
  }

  // ---------- 34) Avisos no celular (Web Push): instalação do app, tela de ativação, preferências ----------
  console.log('\n[34] Avisos no celular: app instalável, ativar/desativar, preferências e link do aviso');
  {
    const ctxN = await novoContexto(browser, { viewport: { width: 390, height: 800 } });
    const pn = await ctxN.newPage();
    const errosN = []; pn.on('pageerror', (e) => errosN.push(e.message));
    await pn.goto(base);
    await pn.waitForFunction(() => typeof goToPage === 'function');
    const r = await pn.evaluate(async () => {
      const esp = (ms) => new Promise(ok => setTimeout(ok, ms));
      const out = {};
      // --- app instalável: manifest, ícones, service worker ---
      const man = await (await fetch('manifest.webmanifest')).json();
      const icones = await Promise.all(man.icons.map(async (i) => { const x = await fetch(i.src); return x.ok && /image\/png/.test(x.headers.get('content-type') || ''); }));
      const sw = await (await fetch('sw.js')).text();
      out.pwa = { display: man.display, nome: man.short_name, icones: icones.every(Boolean) && man.icons.length >= 3, maskable: man.icons.some(i => i.purpose === 'maskable'),
        linkManifest: !!document.querySelector('link[rel="manifest"]'), apple: !!document.querySelector('link[rel="apple-touch-icon"]') && !!document.querySelector('meta[name="apple-mobile-web-app-capable"]'),
        swPush: /addEventListener\('push'/.test(sw) && /notificationclick/.test(sw), swSemCache: !/caches\.(open|match|put)/.test(sw), swSemReds: !/\d{4}-\d{9}/.test(sw) };
      // --- link do aviso com o painel já aberto ---
      navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'notif-click', pagina: 'cvpa' } }));
      await esp(300); out.cliqueNoAviso = currentPageKey;
      // --- visitante sem login ---
      goToPage('notificacoes'); await esp(300);
      out.anonimo = /Entre com sua conta PPVD/.test(document.getElementById('main').innerText) && !document.getElementById('notifEstadoCard');
      // --- usuário aprovado, com navegador/Supabase de mentira ---
      let perm = 'default', sub = null; const chamadas = [], upserts = [];
      const fakeSub = { endpoint: 'https://push.exemplo/abc123', toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'P256', auth: 'AUTH' } }; }, async unsubscribe() { sub = null; return true; } };
      const fakeReg = { pushManager: { async getSubscription() { return sub; }, async subscribe(o) { chamadas.push(['subscribe', o.userVisibleOnly, o.applicationServerKey.length]); sub = fakeSub; return sub; } } };
      Object.defineProperty(navigator, 'serviceWorker', { value: { ready: Promise.resolve(fakeReg), addEventListener() {}, register: async () => fakeReg }, configurable: true });
      Object.defineProperty(Notification, 'permission', { get: () => perm, configurable: true });
      Notification.requestPermission = async () => { perm = 'granted'; return 'granted'; };
      let prefsBanco = null;
      const tabela = (t) => { const o = { select: () => o, eq: () => o, order: () => o, limit: () => o, in: () => o, is: () => o, gte: () => o, maybeSingle: async () => ({ data: t === 'app_public_config' ? { value: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U' } : (t === 'notificacao_prefs' ? prefsBanco : null), error: null }), upsert: async (linha) => { if (t === 'notificacao_prefs') { prefsBanco = { ativo: linha.ativo, tipos: linha.tipos, municipios: linha.municipios }; upserts.push(prefsBanco); } return { error: null }; }, then: (ok) => ok({ data: [], error: null, count: 0 }) }; return o; };
      ppvdSupa = { from: tabela, rpc: async (nome, args) => { chamadas.push([nome, args && args.p_endpoint, args && args.p_p256dh_key]); return { data: nome === 'solicitar_teste_push' ? 77 : null, error: null }; }, auth: { getSession: async () => ({ data: { session: { access_token: 'eyJ.teste.jwt' } } }), signOut: async () => {} } };
      ppvdUser = { id: 'u1' }; ppvdPerfil = { aprovado: true, nome: 'Fulano', cargo: 'Ten', cidade: 'Araçuaí' }; ppvdRestritoCarregado = true;
      localStorage.removeItem('notifOptIn:u1'); notifEstado = 'desconhecido'; notifPrefs = null; notifMsg = null;
      goToPage('notificacoes'); await esp(500);
      out.desligado = { botao: !!Array.from(document.querySelectorAll('#main button')).find(b => /Ativar neste aparelho/.test(b.textContent)), tipos: document.querySelectorAll('.notif-tipos input').length, munAtivo: document.querySelector('#notifMuns button.on').textContent };
      await notifAtivar(); await esp(300);
      out.ligado = { estado: notifEstado, texto: /Avisos ativos neste aparelho/.test(document.getElementById('main').innerText), registrou: chamadas.some(c => c[0] === 'register_push_subscription' && c[1] === 'https://push.exemplo/abc123' && c[2] === 'P256'), subscribe: chamadas.find(c => c[0] === 'subscribe'), optIn: localStorage.getItem('notifOptIn:u1') === '1', prefsPadrao: upserts[0] ? JSON.stringify(upserts[0].municipios) : null, tiposPadrao: upserts[0] ? upserts[0].tipos.length : null };
      // preferências
      await notifAlternarTipo('vd', false); await notifAlternarMunicipio('ITAOBIM');
      out.prefs = { semVd: !prefsBanco.tipos.includes('vd'), comItaobim: prefsBanco.municipios.includes('ITAOBIM') && prefsBanco.municipios.includes('ARACUAI'), checkbox: !document.querySelector('.notif-tipos input[onchange*="\'vd\'"]').checked };
      await notifAlternarMunicipio(''); out.prefs.todos = prefsBanco.municipios.length === 0;
      // teste
      window.fetch = async (url, init) => { chamadas.push(['fetch', url, init.headers.Authorization]); return { ok: true, status: 200, json: async () => ({ ok: true, enviados: 1, avisos: 1 }) }; };
      await notifEnviarTeste(); await esp(100);
      out.teste = { rpc: chamadas.some(c => c[0] === 'solicitar_teste_push'), funcao: chamadas.find(c => c[0] === 'fetch'), msg: /Aviso de teste enviado/.test(document.getElementById('main').innerText) };
      // desativar
      await notifDesativar(); await esp(300);
      out.desativado = { estado: notifEstado, desinscreveu: chamadas.some(c => c[0] === 'unregister_push_subscription' && c[1] === 'https://push.exemplo/abc123'), optIn: localStorage.getItem('notifOptIn:u1') };
      // logout desvincula o aparelho
      await notifAtivar(); await esp(200); chamadas.length = 0; await ppvdSignOut();
      out.logout = chamadas.some(c => c[0] === 'unregister_push_subscription');
      // sem permissão
      perm = 'denied'; notifEstado = 'desconhecido'; goToPage('notificacoes'); await esp(400);
      out.bloqueado = /bloqueados/.test(document.getElementById('main').innerText);
      // iPhone sem instalar
      perm = 'default'; notifEstado = 'desconhecido';
      Object.defineProperty(navigator, 'userAgent', { get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15', configurable: true });
      goToPage('notificacoes'); await esp(400);
      out.ios = /Adicionar à Tela de Início/.test(document.getElementById('main').innerText);
      return out;
    });
    checa(r.pwa.display === 'standalone' && r.pwa.icones && r.pwa.maskable && r.pwa.linkManifest && r.pwa.apple, 'painel instalável: manifest (standalone), 3 ícones PNG, ícone da Apple e meta tags', 'pwa: ' + JSON.stringify(r.pwa));
    checa(r.pwa.swPush && r.pwa.swSemCache && r.pwa.swSemReds, 'service worker trata push e clique, não guarda nada em cache e não carrega REDS', 'sw: ' + JSON.stringify(r.pwa));
    checa(r.cliqueNoAviso === 'cvpa', 'tocar no aviso com o painel aberto leva à página do aviso', 'página: ' + r.cliqueNoAviso);
    checa(r.anonimo, 'visitante sem login só vê o pedido de entrada', 'anônimo: ' + r.anonimo);
    checa(r.desligado.botao && r.desligado.tipos === 7 && r.desligado.munAtivo === 'Araçuaí', 'tela de avisos: botão "Ativar neste aparelho", 7 tipos e o município do cadastro já marcado', 'desligado: ' + JSON.stringify(r.desligado));
    checa(r.ligado.estado === 'ligado' && r.ligado.texto && r.ligado.registrou && r.ligado.subscribe && r.ligado.subscribe[1] === true && r.ligado.subscribe[2] === 65 && r.ligado.optIn, 'ativar: pede permissão, inscreve com a chave pública (65 bytes) e registra o aparelho', 'ligado: ' + JSON.stringify(r.ligado));
    checa(r.ligado.prefsPadrao === '["ARACUAI"]' && r.ligado.tiposPadrao === 7, 'primeira vez: preferências padrão = município do cadastro do usuário e todos os tipos', 'prefs padrão: ' + JSON.stringify(r.ligado));
    checa(r.prefs.semVd && r.prefs.comItaobim && r.prefs.checkbox && r.prefs.todos, 'preferências: desmarcar tipo, somar município e voltar a "todos"', 'prefs: ' + JSON.stringify(r.prefs));
    checa(r.teste.rpc && r.teste.funcao && /notificar-dispatch/.test(r.teste.funcao[1]) && r.teste.funcao[2] === 'Bearer eyJ.teste.jwt' && r.teste.msg, 'aviso de teste: cria o evento e chama a função com o login do usuário', 'teste: ' + JSON.stringify(r.teste));
    checa(r.desativado.estado === 'desligado' && r.desativado.desinscreveu && r.desativado.optIn === null, 'desativar: cancela a inscrição do aparelho e apaga a opção', 'desativar: ' + JSON.stringify(r.desativado));
    checa(r.logout, 'sair da conta desvincula o aparelho (outra conta que entre não herda os avisos)', 'logout não desvinculou');
    checa(r.bloqueado && r.ios, 'avisos bloqueados e iPhone sem instalar mostram a orientação certa', 'estados: ' + JSON.stringify([r.bloqueado, r.ios]));
    checa(errosN.length === 0, 'avisos no celular sem erro de JavaScript', 'erros: ' + errosN.slice(0, 3).join(' | '));
    await ctxN.close();
    // link do aviso com o painel fechado: abre direto na página e limpa o endereço
    const ctxO = await novoContexto(browser, { viewport: { width: 390, height: 800 } });
    const po = await ctxO.newPage();
    await po.goto(base + '?pagina=reincidencia');
    await po.waitForFunction(() => typeof goToPage === 'function');
    await po.waitForTimeout(600);
    const link = await po.evaluate(() => ({ pagina: currentPageKey, busca: location.search }));
    checa(link.pagina === 'reincidencia' && link.busca === '', 'abrir pelo link do aviso (?pagina=) vai direto à página e limpa o endereço', 'link: ' + JSON.stringify(link));
    await ctxO.close();
  }

  // ---------- 35) Resumo do dia por cidade (enviado pelo administrador) ----------
  console.log('\n[35] Resumo do dia por cidade: montar, conferir o texto, escolher cidades e enviar');
  {
    const ctxU = await novoContexto(browser, { viewport: { width: 390, height: 900 } });
    const pu = await ctxU.newPage();
    const errosU = []; pu.on('pageerror', (e) => errosU.push(e.message));
    await pu.goto(base);
    await pu.waitForFunction(() => typeof goToPage === 'function');
    const r = await pu.evaluate(async () => {
      const esp = (ms) => new Promise(ok => setTimeout(ok, ms));
      const out = {};
      out.cidades = ['Araçuaí', 'Araçuai', 'ARAÇUAÍ', 'CORONEL MURTA - MG', 'ITAOBIM/MG', 'itaobim', 'ITNGA', 'Batalhão', ''].map(cidadeCanonica).join('|');
      const tabela = (t) => { const o = { select: () => o, eq: () => o, order: () => o, limit: () => o, in: () => o, is: () => o, gte: () => o, maybeSingle: async () => ({ data: null, error: null }), then: (ok) => ok({ data: t === 'perfis' ? [{ cidade: 'Araçuaí' }, { cidade: 'ARACUAI' }, { cidade: 'ITNGA' }, { cidade: 'Batalhão' }] : [], error: null }) }; return o; };
      const chamadas = [];
      ppvdSupa = { from: tabela, rpc: async () => ({ data: null, error: null }), auth: { getSession: async () => ({ data: { session: { access_token: 'eyJ.admin.jwt' } } }), signOut: async () => {} } };
      ppvdUser = { id: 'adm' }; ppvdPerfil = { aprovado: true, is_admin: true, nome: 'Eduardo', cargo: 'Ten', cidade: 'Araçuaí' }; ppvdRestritoCarregado = true;
      ppvdBuscarCasosVD = async () => ({});
      const nomeA = DATA.mv.municipios.find(m => normMun(m.nome) === 'ARACUAI');
      const ult = Math.min(MES_ATUAL_IDX, nomeA.realizado_mes.length - 1);
      nomeA.realizado_mes[ult] = 2;
      DATA.violencia_domestica.ocorrencias = { ARACUAI: [{ r: 'A1', d: '01/10/2026', m: 10, n: 'Ameaça', g: 'media' }, { r: 'A2', d: '02/10/2026', m: 10, n: 'Ameaça', g: 'media' }] };
      notifEstado = 'desligado'; notifResumo = { montando: false, enviando: false, dados: null, militares: {}, marcadas: {}, mensagem: '', resultado: null, erro: null };
      goToPage('notificacoes'); await esp(400);
      out.botao = !!Array.from(document.querySelectorAll('#notifResumoCard button')).find(b => /Montar o resumo de hoje/.test(b.textContent));
      await notifResumoMontar(); await esp(300);
      const linhas = [...document.querySelectorAll('#notifResumoTab tbody tr')];
      const linha = (nome) => linhas.find(t => t.children[1].textContent.trim() === nome);
      out.tabela = { linhas: linhas.length, aracuai: linha('Araçuaí') ? { militares: linha('Araçuaí').children[2].textContent, marcada: linha('Araçuaí').querySelector('input').checked, texto: linha('Araçuaí').children[3].textContent } : null, itinga: linha('Itinga') ? { militares: linha('Itinga').children[2].textContent, marcada: linha('Itinga').querySelector('input').checked } : null, medina: linha('Medina') ? { militares: linha('Medina').children[2].textContent, desabilitada: linha('Medina').querySelector('input').disabled } : null, aviso: /sem cidade reconhecida/.test(document.getElementById('notifResumoCard').textContent) };
      // enviar só Araçuaí + mensagem
      notifResumoMarcar('ITINGA', false);
      const campo = document.getElementById('notifResumoMsg'); campo.value = 'Reunião às 15h.'; campo.dispatchEvent(new Event('input'));
      window.confirm = () => true;
      window.fetch = async (url, init) => { chamadas.push({ url, auth: init.headers.Authorization, corpo: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ ok: true, enviados: 3, falhas: 0, removidas: 0, cidades: { ARACUAI: { militares: 2, destinatarios: 2, recebeu: 2 } } }) }; };
      await notifResumoEnviar(); await esp(200);
      out.envio = { n: chamadas.length, acao: chamadas[0] && chamadas[0].corpo.action, cidades: chamadas[0] && Object.keys(chamadas[0].corpo.resumos).join(), auth: chamadas[0] && chamadas[0].auth, texto: chamadas[0] && chamadas[0].corpo.resumos.ARACUAI, reds: chamadas[0] ? /\d{4}-\d{9}-\d{3}/.test(JSON.stringify(chamadas[0].corpo)) : null, resultado: /Resumo enviado: 3 aparelho/.test(document.getElementById('notifResumoCard').textContent) && /avisos ativos em 2 de 2/.test(document.getElementById('notifResumoCard').textContent) };
      // quem não é administrador não vê o cartão
      ppvdPerfil = { aprovado: true, is_admin: false, nome: 'Cb Fulano', cargo: 'Cb', cidade: 'Medina' };
      goToPage('notificacoes'); await esp(400);
      out.semCartaoParaComum = !document.getElementById('notifResumoCard');
      return out;
    });
    checa(r.cidades === 'ARACUAI|ARACUAI|ARACUAI|CORONEL MURTA|ITAOBIM|ITAOBIM|ITINGA||', 'cadastro de cidade digitado à mão é reconhecido (acento, caixa, "- MG", "/MG", uma letra errada)', 'cidades: ' + r.cidades);
    checa(r.botao && r.tabela.linhas === 13 && r.tabela.aracuai && r.tabela.aracuai.militares === '2' && r.tabela.aracuai.marcada && r.tabela.itinga.militares === '1' && r.tabela.itinga.marcada && r.tabela.medina.militares === '0' && r.tabela.medina.desabilitada && r.tabela.aviso, 'administrador monta o resumo: 13 cidades, militares por cidade (inclusive "ITNGA"), só quem tem militar vem marcado e o cadastro sem cidade é avisado', 'tabela: ' + JSON.stringify(r.tabela));
    checa(r.tabela.aracuai && /Metas até hoje \(dia \d+\): \d+ de \d+ em dia/.test(r.tabela.aracuai.texto) && /Em vermelho: .*2 casos de violência doméstica fora do prazo/.test(r.tabela.aracuai.texto) && /2 mortes violentas no mês/.test(r.tabela.aracuai.texto), 'texto de Araçuaí traz as metas até hoje (quantas em dia, quais atrasadas) e o que está em vermelho, na mesma conta da Auditoria', 'texto: ' + (r.tabela.aracuai && r.tabela.aracuai.texto));
    checa(r.envio.n === 1 && r.envio.acao === 'resumo' && r.envio.cidades === 'ARACUAI' && r.envio.auth === 'Bearer eyJ.admin.jwt' && /Reunião às 15h\.$/.test(r.envio.texto || '') && r.envio.reds === false && r.envio.resultado, 'enviar: só a cidade marcada, com a mensagem do administrador no fim, login dele no pedido, sem REDS, e mostra quantos receberam', 'envio: ' + JSON.stringify(r.envio));
    checa(r.semCartaoParaComum, 'quem não é administrador não vê o resumo do dia', 'cartão apareceu para usuário comum');
    checa(errosU.length === 0, 'resumo do dia sem erro de JavaScript', 'erros: ' + errosU.slice(0, 3).join(' | '));
    await ctxU.close();
  }

  // ---------- 36) POG e PPAG, onda 1: botões de mês, meta proporcional, subtotal por fração, ano com projeção, painel da cidade ----------
  console.log('\n[36] POG e PPAG no padrão das páginas de indicador');
  {
    const ctxO = await novoContexto(browser, { viewport: { width: 390, height: 900 } });
    const po = await ctxO.newPage();
    const errosO = []; po.on('pageerror', (e) => errosO.push(e.message));
    await po.goto(base);
    await po.waitForFunction(() => typeof goToPage === 'function');
    const r = await po.evaluate(async () => {
      const esp = (ms) => new Promise(ok => setTimeout(ok, ms));
      const out = {};
      const d = DATA.pog, ult = Math.min(MES_ATUAL_IDX, d.total_mes.length - 1);
      try { localStorage.removeItem('indMes_pog'); localStorage.removeItem('indPer_ppag'); localStorage.removeItem('indSub_ppag'); } catch (e) {}
      setMunFiltro('');
      goToPage('pog'); await esp(400);
      const linhas = [...document.querySelectorAll('#pogTable tbody tr')], tot = linhas[linhas.length - 1], f = fatorMesEmAndamento(d, ult);
      const num = (td) => parseInt(td.querySelector('b').textContent);
      out.pog = {
        semSelect: !document.getElementById('pogMonthSel'),
        pills: document.querySelectorAll('#pogMeses button').length === ult + 1 && document.querySelector('#pogMeses button.on').dataset.p === String(ult),
        subtotais: linhas.filter(t => t.classList.contains('cia-sub')).length,
        somaOk: linhas.filter(t => t.classList.contains('cia-sub')).reduce((a, t) => a + num(t.children[1]), 0) === d.total_mes[ult],
        metaProp: tot.children[1].textContent.includes(opNum(d.total_meta_mes[ult] * f)),
        fracao: f < 1,
        notaParcial: f < 1 ? /proporcional aos dias já fechados/.test(document.getElementById('pogNota').textContent) : true,
        faixa: /Verde de 95% a 105%/.test(document.getElementById('main').textContent),
        colunas: document.querySelectorAll('#pogTable thead th').length,
        ano: !!document.querySelector('#main svg.ano-svg') && /Projeção para o ano/.test(document.getElementById('main').textContent),
        quadro: document.querySelectorAll('#opQuadro tbody tr').length,
        cobertura: /Cobre \d+ de \d+ operações do ano/.test(document.getElementById('main').textContent),
        metodologiaFechada: !!document.querySelector('details.aud-como') && !document.querySelector('details.aud-como').open,
      };
      // outro mês: meta cheia, título acompanha
      document.querySelector('#pogMeses button[data-p="0"]').click(); await esp(100);
      const t0 = [...document.querySelectorAll('#pogTable tbody tr')].pop();
      out.pogJan = { titulo: /Janeiro/.test(document.getElementById('pogTitulo').textContent), metaCheia: t0.children[1].textContent.includes(opNum(d.total_meta_mes[0])), nota: document.getElementById('pogNota').textContent === '' };
      // cidade clicável
      document.querySelector('#pogTable tr.rank-clic').click(); await esp(400);
      out.pogCidade = { filtro: !!getMunFiltro(), painel: /— mês a mês/.test(document.getElementById('main').innerHTML) && document.querySelectorAll('#main svg.ano-svg').length >= 2 };
      setMunFiltro('');
      // PPAG
      goToPage('ppag'); await esp(400);
      const lp = [...document.querySelectorAll('#ppagTable tbody tr')];
      out.ppag = {
        linhas: lp.length, subtotais: lp.filter(t => t.classList.contains('cia-sub')).length, colunas: document.querySelectorAll('#ppagTable thead th').length,
        semSelect: !document.getElementById('ppagMonthSel') && !document.getElementById('ppagVdTable'),
        pills: document.querySelectorAll('#ppagPer button').length === ult + 2 && document.querySelector('#ppagPer button.on').dataset.p === 'acum',
        metaProp: f < 1 ? /proporcional aos dias já fechados/.test(document.getElementById('ppagNota').textContent) : true,
        tituloAcum: /acumulado até/.test(document.getElementById('ppagTitulo').textContent),
        sub1: /Y15001/.test(document.querySelector('#ppagSubCorpo h3').textContent),
      };
      document.querySelector('#ppagSubs button[data-p="y07012"]').click(); await esp(100);
      out.ppagSub = { titulo: /Y07012/.test(document.querySelector('#ppagSubCorpo h3').textContent), ano: !!document.querySelector('#ppagSubCorpo svg.ano-svg'), quadro: document.querySelectorAll('#opQuadro tbody tr').length };
      document.querySelector('#ppagPer button[data-p="0"]').click(); await esp(100);
      out.ppagJan = { titulo: /Janeiro/.test(document.getElementById('ppagTitulo').textContent), nota: document.getElementById('ppagNota').textContent === '' };
      out.largura = document.documentElement.scrollWidth <= window.innerWidth + 1;
      return out;
    });
    checa(r.pog.semSelect && r.pog.pills && r.pog.metodologiaFechada && r.pog.colunas === 4, 'POG: botões de mês (mês atual marcado), sem seletor antigo, metodologia recolhida', 'POG estrutura: ' + JSON.stringify(r.pog));
    checa(r.pog.subtotais === 3 && r.pog.somaOk, 'POG: subtotal por fração (3 companhias) e a soma bate com o total do batalhão', 'POG subtotais: ' + JSON.stringify(r.pog));
    checa(r.pog.metaProp && r.pog.notaParcial, 'POG: no mês em andamento a meta é proporcional aos dias fechados (e a nota explica)', 'POG meta proporcional: ' + JSON.stringify(r.pog));
    checa(r.pog.faixa && r.pog.ano && r.pog.quadro === 14 && r.pog.cobertura, 'POG: regra da faixa 95–105% explicada, ano com projeção, quadro município × mês e aviso de lista desatualizada', 'POG blocos: ' + JSON.stringify(r.pog));
    checa(r.pogJan.titulo && r.pogJan.metaCheia && r.pogJan.nota, 'POG: trocar de mês muda o título e usa a meta cheia', 'POG janeiro: ' + JSON.stringify(r.pogJan));
    checa(r.pogCidade.filtro && r.pogCidade.painel, 'POG: clicar numa cidade filtra e abre o painel da cidade', 'POG cidade: ' + JSON.stringify(r.pogCidade));
    checa(r.ppag.linhas === 17 && r.ppag.subtotais === 3 && r.ppag.colunas === 4 && r.ppag.semSelect && r.ppag.pills && r.ppag.metaProp && r.ppag.tituloAcum && r.ppag.sub1, 'PPAG: matriz município × 3 indicadores com subtotal por fração, botões de período e meta proporcional', 'PPAG: ' + JSON.stringify(r.ppag));
    checa(r.ppagSub.titulo && r.ppagSub.ano && r.ppagSub.quadro === 14 && r.ppagJan.titulo && r.ppagJan.nota, 'PPAG: trocar o indicador e o mês atualiza o detalhe, o título e a nota', 'PPAG troca: ' + JSON.stringify([r.ppagSub, r.ppagJan]));
    checa(r.largura, 'POG/PPAG no celular sem rolagem horizontal da página', 'a página passou da largura da tela');
    checa(errosO.length === 0, 'POG/PPAG sem erro de JavaScript', 'erros: ' + errosO.slice(0, 3).join(' | '));
    await ctxO.close();
  }

  // ---------- 37) Casos: só o primeiro nome da vítima e do autor, que já vai na mensagem do WhatsApp ----------
  console.log('\n[37] Casos: primeiro nome da vítima e do autor entra na mensagem do despacho');
  {
    const ctxN = await novoContexto(browser, { viewport: { width: 1280, height: 900 } });
    const pn = await ctxN.newPage();
    const errosN = []; pn.on('pageerror', (e) => errosN.push(e.message));
    await pn.goto(base);
    await pn.waitForFunction(() => typeof goToPage === 'function');
    const r = await pn.evaluate(async () => {
      const out = {}, gravados = [], abertos = [];
      out.helper = ['maria silva', 'JOÃO pereira', '  Ana ', 'M.A.S.', ''].map(ppvdPrimeiroNome).join('|');
      const casoBase = { id: 'c1', modalidade: 'violencia_domestica', municipio: 'Araçuaí', reds_numero: 'X1', reds_data: '2026-10-10', natureza: 'Ameaça', bairro: 'Centro', status: 'aberto', gravidade: 2, urgencia: 2, tendencia: 2, vitima_nome: 'Lúcia' };
      const mk = (t) => { const o = { _upd: null, _ins: null, select: () => o, eq: () => o, order: () => o, limit: () => o, in: () => o, is: () => o, gte: () => o, single: () => o, maybeSingle: () => o,
        insert: (d) => { gravados.push({ t, op: 'insert', d }); o._ins = d; return o; }, update: (d) => { gravados.push({ t, op: 'update', d }); o._upd = d; return o; },
        then: (ok) => ok(t === 'ppvd_visitas' ? (o._ins ? { data: { id: 'v9', token: 'tok9' }, error: null } : { data: [], error: null }) : { data: { ...casoBase, ...(o._upd || {}) }, error: null }) }; return o; };
      ppvdSupa = { from: mk }; ppvdUser = { id: 'u' }; ppvdPerfil = { aprovado: true, is_admin: true, pode_abrir_caso: true, nome: 'A' }; ppvdRestritoCarregado = true; ppvdMilitaresCache = [];
      window.open = (u) => { abertos.push(u); return null; }; window.alert = () => {};
      await ppvdRenderCaso(casoBase);
      out.campos = { vit: (document.getElementById('ppvdDespVit') || {}).value, aut: (document.getElementById('ppvdDespAut') || {}).value, rotulo: /Primeiro nome da vítima/.test(document.getElementById('main').textContent), semIniciais: !/Iniciais da vítima/.test(document.getElementById('main').textContent) };
      document.getElementById('ppvdDespVit').value = 'maria silva'; document.getElementById('ppvdDespAut').value = 'JOÃO pereira';
      document.getElementById('ppvdRespNome').value = 'Sd Fulano'; document.getElementById('ppvdRespWhats').value = '33999999999';
      await ppvdDespacharVD('c1', false);
      const upd = gravados.filter(x => x.t === 'ppvd_casos' && x.op === 'update').map(x => x.d)[0] || {};
      const msg = decodeURIComponent((abertos[0] || '').split('text=')[1] || '');
      out.despacho = { vit: upd.vitima_nome, aut: upd.autor_nome, msg: /visita ao autor \(João\) e à vítima \(Maria\)/.test(msg), bos: /BOS da visita ao autor \(João\) e à vítima \(Maria\)/.test(msg), semSobrenome: !/Silva|Pereira/i.test(msg) };
      // sem nomes: mensagem como antes
      const semNomes = ppvdMontarMensagemWhatsApp({ reds_numero: 'X', municipio: 'A' }, 't');
      out.semNomes = /visita ao autor e à vítima, no prazo/.test(semNomes) && /BOS da visita ao autor e à vítima, e preencha/.test(semNomes);
      // assistente dos casos de Crimes Violentos / Reincidência
      ppvdWizard = { modalidade: 'crimes_violentos', casoId: 'c2', step: 3, valores: { gravidade: 2, urgencia: 2, tendencia: 2 }, militar_responsavel: '', caso: { id: 'c2', reds_numero: 'R1', modalidade: 'crimes_violentos', vitima_nome: 'Ana' } };
      ppvdRenderWizard();
      out.wiz = { vit: (document.getElementById('ppvdWizVit') || {}).value, aut: (document.getElementById('ppvdWizAut') || {}).value };
      document.getElementById('ppvdWizVit').value = 'beatriz souza'; document.getElementById('ppvdWizAut').value = 'carlos';
      gravados.length = 0; await ppvdWizardSalvar();
      const u2 = gravados.filter(x => x.t === 'ppvd_casos' && x.op === 'update').map(x => x.d)[0] || {};
      out.wizSalvo = { vit: u2.vitima_nome, aut: u2.autor_nome };
      return out;
    });
    checa(r.helper === 'Maria|João|Ana|M.A.S.|', 'só o primeiro nome é guardado (sobrenome cortado, maiúscula certa, iniciais preservadas)', 'primeiro nome: ' + r.helper);
    checa(r.campos.vit === 'Lúcia' && r.campos.aut === '' && r.campos.rotulo && r.campos.semIniciais, 'cartão de despacho traz os campos de primeiro nome (já preenchidos com o que o caso tem)', 'campos: ' + JSON.stringify(r.campos));
    checa(r.despacho.vit === 'Maria' && r.despacho.aut === 'João' && r.despacho.msg && r.despacho.bos && r.despacho.semSobrenome, 'despachar grava os primeiros nomes no caso e a mensagem do WhatsApp já vem com eles', 'despacho: ' + JSON.stringify(r.despacho));
    checa(r.semNomes, 'sem nomes preenchidos a mensagem segue como antes', 'mensagem sem nomes mudou');
    checa(r.wiz.vit === 'Ana' && r.wiz.aut === '' && r.wizSalvo.vit === 'Beatriz' && r.wizSalvo.aut === 'Carlos', 'casos de Crimes Violentos/Reincidência: campos de primeiro nome na revisão e gravados ao salvar', 'assistente: ' + JSON.stringify([r.wiz, r.wizSalvo]));
    checa(errosN.length === 0, 'primeiro nome sem erro de JavaScript', 'erros: ' + errosN.slice(0, 3).join(' | '));
    await ctxN.close();
  }

  await browser.close();
  servidor.close();
  console.log('\n' + (falhas.length ? `✖ ${falhas.length} FALHA(S)` : '✔ TUDO CERTO'));
  process.exit(falhas.length ? 1 : 0);
})().catch((e) => { console.error('ERRO NO TESTE:', e); process.exit(2); });

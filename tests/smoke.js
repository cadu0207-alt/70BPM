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
    checa(r.linhas.join() === 'V2,V3,V4' || ['V2', 'V3', 'V4'].every(x => r.linhas.includes(x)) && !r.linhas.includes('V1'), `tabela mostra casos e recentes (${r.linhas.join(', ')}); a antiga sem caso (V1) vai pro histórico`, 'linhas da tabela: ' + r.linhas.join(', '));
    checa(r.historicoLinhas === 1, 'histórico anterior ao PPVD abre com a ocorrência antiga sem caso', `linhas no histórico: ${r.historicoLinhas}`);
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

  await browser.close();
  servidor.close();
  console.log('\n' + (falhas.length ? `✖ ${falhas.length} FALHA(S)` : '✔ TUDO CERTO'));
  process.exit(falhas.length ? 1 : 0);
})().catch((e) => { console.error('ERRO NO TESTE:', e); process.exit(2); });

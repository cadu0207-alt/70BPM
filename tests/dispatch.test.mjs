// Testa a lógica de envio dos avisos (Edge Function notificar-dispatch) com tabelas e servidor de push de mentira.
// Roda com: node --experimental-strip-types tests/dispatch.test.mjs   (Node 22+; sem Supabase, sem rede)
import { handle, montarAviso, quer } from '../supabase/functions/notificar-dispatch/dispatch.ts';

let falhas = 0;
const checa = (cond, ok, ruim) => { if (cond) console.log('  ✔ ' + ok); else { falhas++; console.log('  ✖ ' + (ruim || ok)); } };

function mundo({ prefs = [], subs = [], aprovados = [], eventos = [], jwts = {} } = {}) {
  const enviados = [], deletadas = [], vapid = {};
  let reservados = new Set();
  const deps = {
    async getPrivate(k) { return vapid[k] ?? null; },
    async saveVapid(pub, priv) { vapid.vapid_public_key ??= pub; vapid.vapid_private_key ??= priv; },
    gerarVapid() { return { publicKey: 'PUB-' + Math.random(), privateKey: 'PRIV-' + Math.random() }; },
    async tokenValido(t) { return t === 'token-bom'; },
    async userDoJwt(j) { return jwts[j] ?? null; },
    async reservarEventos(ids, soTesteDe) { const novos = eventos.filter((e) => ids.includes(e.id) && !reservados.has(e.id) && (!soTesteDe || (e.tipo === 'teste' && e.user_id === soTesteDe))); novos.forEach((e) => reservados.add(e.id)); return novos; },
    async getAprovados() { return aprovados; },
    async getPrefs(us) { return new Map(prefs.filter((p) => us.includes(p.user_id)).map((p) => [p.user_id, p])); },
    async getSubscriptions(us) { return subs.filter((s) => us.includes(s.user_id)); },
    async deleteSubscriptions(ids) { deletadas.push(...ids); },
    async enviar(sub, payload) { if (sub.endpoint.includes('morta')) { const e = new Error('gone'); e.statusCode = 410; throw e; } enviados.push({ user: sub.user_id, endpoint: sub.endpoint, payload: JSON.parse(payload) }); },
  };
  return { deps, enviados, deletadas, vapid };
}
const post = (corpo, headers = {}) => new Request('http://x/', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(corpo) });
const lerJson = async (r) => ({ status: r.status, ...(await r.json()) });

console.log('\n[1] Mensagem montada (sem REDS, com município e quantidade)');
{
  const a = montarAviso([{ id: 1, tipo: 'vd', municipio: 'MEDINA', qtd: 2 }, { id: 2, tipo: 'mv', municipio: 'ARACUAI', qtd: 1 }, { id: 3, tipo: 'atualizacao', municipio: null, qtd: 1 }]);
  checa(a.title === '70º BPM · Morte violenta registrada' && a.pagina === 'imv' && a.url === './?pagina=imv', 'o evento mais grave (morte violenta) dá o título e o destino', JSON.stringify(a));
  checa(a.body === '1 morte violenta em Araçuaí · 2 casos novos de violência doméstica em Medina · painel atualizado'.replace(/^./, (c) => c.toUpperCase()), 'texto com município acentuado, plural certo e primeira letra maiúscula', a.body);
  const b = montarAviso([{ id: 4, tipo: 'pm', municipio: 'PEDRA AZUL', qtd: 1 }]);
  checa(b.title.includes('Policial militar vítima') && b.pagina === 'cvpe', 'policial militar vítima tem prioridade máxima e abre o CVPE', JSON.stringify(b));
  const muitos = montarAviso(Array.from({ length: 7 }, (_, i) => ({ id: i, tipo: 'vd', municipio: 'ITAOBIM', qtd: 1 })));
  checa(/e mais 3$/.test(muitos.body), 'mais de 4 linhas viram "e mais N"', muitos.body);
  checa(!/\d{4}-\d{9}-\d{3}/.test(JSON.stringify([a, b, muitos])), 'nenhum nº de REDS no aviso');
}

console.log('\n[2] Preferências: tipo e município');
{
  const ev = { id: 1, tipo: 'vd', municipio: 'MEDINA', qtd: 1 };
  checa(quer(undefined, ev), 'sem preferência salva = recebe tudo');
  checa(!quer({ user_id: 'u', ativo: false, tipos: ['vd'], municipios: [] }, ev), 'desligado não recebe');
  checa(!quer({ user_id: 'u', ativo: true, tipos: ['mv'], municipios: [] }, ev), 'tipo não escolhido não recebe');
  checa(quer({ user_id: 'u', ativo: true, tipos: ['vd'], municipios: ['Medina'] }, ev), 'município escolhido (com acento/caixa diferentes) recebe');
  checa(!quer({ user_id: 'u', ativo: true, tipos: ['vd'], municipios: ['ITAOBIM'] }, ev), 'outro município não recebe');
  checa(quer({ user_id: 'u', ativo: true, tipos: ['atualizacao'], municipios: ['ITAOBIM'] }, { id: 2, tipo: 'atualizacao', municipio: null, qtd: 1 }), 'evento do batalhão (sem município) vai pra todo mundo que quer o tipo');
}

console.log('\n[3] Envio da rotina');
{
  const eventos = [{ id: 1, tipo: 'mv', municipio: 'ARACUAI', qtd: 1 }, { id: 2, tipo: 'vd', municipio: 'MEDINA', qtd: 2 }, { id: 3, tipo: 'atualizacao', municipio: null, qtd: 1 }];
  const w = mundo({
    aprovados: ['A', 'B', 'C'], eventos,
    prefs: [{ user_id: 'A', ativo: true, tipos: ['atualizacao', 'mv', 'pm', 'cvpe', 'cvpa', 'vd'], municipios: ['ARACUAI'] }, { user_id: 'B', ativo: true, tipos: ['vd'], municipios: [] }],
    subs: [{ id: 1, user_id: 'A', endpoint: 'https://push/a', p256dh_key: 'k', auth_key: 'a' }, { id: 2, user_id: 'B', endpoint: 'https://push/b', p256dh_key: 'k', auth_key: 'a' },
      { id: 3, user_id: 'C', endpoint: 'https://push/c-morta', p256dh_key: 'k', auth_key: 'a' }, { id: 4, user_id: 'C', endpoint: 'https://push/c2', p256dh_key: 'k', auth_key: 'a' },
      { id: 5, user_id: 'D', endpoint: 'https://push/d', p256dh_key: 'k', auth_key: 'a' }],
  });
  const sem = await lerJson(await handle(post({ ids: [1, 2, 3] }), w.deps));
  checa(sem.status === 401, 'sem token nem login: 401');
  const errado = await lerJson(await handle(post({ ids: [1] }, { 'x-pipeline-token': 'errado' }), w.deps));
  checa(errado.status === 401, 'token errado: 401');
  const vazio = await lerJson(await handle(post({ ids: [] }, { 'x-pipeline-token': 'token-bom' }), w.deps));
  checa(vazio.status === 400, 'ids vazio: 400');
  const get = await handle(new Request('http://x/', { method: 'GET' }), w.deps);
  checa(get.status === 405, 'GET: 405');

  const r = await lerJson(await handle(post({ ids: [1, 2, 3] }, { 'x-pipeline-token': 'token-bom' }), w.deps));
  checa(r.status === 200 && r.eventos === 3 && r.avisos === 3, 'três pessoas aprovadas recebem aviso (a não aprovada D não)', JSON.stringify(r));
  const por = Object.fromEntries(w.enviados.map((e) => [e.user + ':' + e.endpoint.split('/').pop(), e.payload]));
  checa(por['A:a'] && /Araçuaí/.test(por['A:a'].body) && !/Medina/.test(por['A:a'].body), 'A (só Araçuaí) recebe a morte violenta e o painel, não a violência doméstica de Medina', JSON.stringify(por['A:a']));
  checa(por['B:b'] && por['B:b'].pagina === 'violencia_domestica' && /Medina/.test(por['B:b'].body) && !/morte/i.test(por['B:b'].body), 'B (só violência doméstica) recebe só isso', JSON.stringify(por['B:b']));
  checa(por['C:c2'] && /morte violenta/.test(por['C:c2'].body) && /violência doméstica/.test(por['C:c2'].body) && /painel/i.test(por['C:c2'].body), 'C (sem preferência) recebe tudo no mesmo aviso', JSON.stringify(por['C:c2']));
  checa(!w.enviados.some((e) => e.user === 'D'), 'quem não está aprovado não recebe, mesmo com inscrição');
  checa(w.deletadas.length === 1 && w.deletadas[0] === 3, 'inscrição morta (410) é apagada');
  const outra = await lerJson(await handle(post({ ids: [1, 2, 3] }, { 'x-pipeline-token': 'token-bom' }), w.deps));
  checa(outra.avisos === 0 && w.enviados.length === 3, 'repetir a chamada (retry) não reenvia os mesmos eventos', JSON.stringify(outra));
  checa(w.enviados.every((e) => e.payload.tag === '70bpm-painel'), 'mesmo tag: o aviso novo substitui o anterior na bandeja');
}

console.log('\n[4] Chaves VAPID');
{
  const w = mundo();
  const a = await lerJson(await handle(post({ action: 'init' }, { 'x-pipeline-token': 'token-bom' }), w.deps));
  const b = await lerJson(await handle(post({ action: 'init' }, { 'x-pipeline-token': 'token-bom' }), w.deps));
  checa(a.status === 200 && a.vapid_public_key && a.vapid_public_key === b.vapid_public_key, 'init gera o par uma vez e repete o mesmo');
  const c = await lerJson(await handle(post({ action: 'init' }), w.deps));
  checa(c.status === 401 && !JSON.stringify(c).includes('PRIV'), 'init sem token: 401 e nunca devolve a chave privada');
  checa(!JSON.stringify(a).includes('PRIV'), 'a resposta traz só a chave pública');
}

console.log('\n[5] Teste de aviso pelo próprio usuário');
{
  const w = mundo({ eventos: [{ id: 9, tipo: 'teste', municipio: null, qtd: 1, user_id: 'X' }], jwts: { 'eyX': 'X', 'eyY': 'Y' }, subs: [{ id: 1, user_id: 'X', endpoint: 'https://push/x', p256dh_key: 'k', auth_key: 'a' }, { id: 2, user_id: 'Y', endpoint: 'https://push/y', p256dh_key: 'k', auth_key: 'a' }] });
  const outro = await lerJson(await handle(post({ ids: [9] }, { Authorization: 'Bearer eyY' }), w.deps));
  checa(outro.avisos === 0 && !w.enviados.length, 'usuário Y não consegue disparar o teste de X');
  const w2 = mundo({ eventos: [{ id: 9, tipo: 'teste', municipio: null, qtd: 1, user_id: 'X' }], jwts: { 'eyX': 'X' }, subs: [{ id: 1, user_id: 'X', endpoint: 'https://push/x', p256dh_key: 'k', auth_key: 'a' }] });
  const meu = await lerJson(await handle(post({ ids: [9] }, { Authorization: 'Bearer eyX' }), w2.deps));
  checa(meu.avisos === 1 && w2.enviados.length === 1 && /Teste/.test(w2.enviados[0].payload.title), 'X recebe o próprio teste');
  const semJwt = await lerJson(await handle(post({ ids: [9] }, { Authorization: 'Bearer eyZ' }), mundo({ jwts: {} }).deps));
  checa(semJwt.status === 401, 'JWT inválido: 401');
  const w3 = mundo({ eventos: [{ id: 5, tipo: 'vd', municipio: 'MEDINA', qtd: 1, user_id: null }], aprovados: ['X'], jwts: { eyX: 'X' }, subs: [{ id: 1, user_id: 'X', endpoint: 'https://push/x', p256dh_key: 'k', auth_key: 'a' }] });
  const abuso = await lerJson(await handle(post({ ids: [5] }, { Authorization: 'Bearer eyX' }), w3.deps));
  checa(abuso.avisos === 0 && !w3.enviados.length && abuso.eventos === 0, 'usuário comum não consegue disparar nem "queimar" evento da rotina (o evento continua livre pra rotina)');
  const depois = await lerJson(await handle(post({ ids: [5] }, { 'x-pipeline-token': 'token-bom' }), w3.deps));
  checa(depois.eventos === 1 && depois.avisos === 1 && w3.enviados.length === 1, 'e a rotina ainda consegue enviar esse evento depois');
}

console.log(falhas ? `\n✖ ${falhas} FALHA(S)` : '\n✔ TUDO CERTO (avisos)');
process.exit(falhas ? 1 : 0);

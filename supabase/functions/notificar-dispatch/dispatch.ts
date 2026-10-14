// ================================================================
// 70º BPM — notificar-dispatch: lógica de envio (sem Deno/Supabase aqui, pra testar em Node)
//
// Quem chama:
//   * a ROTINA de dados (header x-pipeline-token = o mesmo token de escrita que ela já usa) com {"ids":[...]} (eventos criados por
//     publicar_eventos) ou {"action":"init"} (gera as chaves VAPID uma vez);
//   * o USUÁRIO logado (Authorization: Bearer <JWT>) com {"ids":[<id do evento 'teste'>]} — só o aviso de teste dele mesmo.
// O aviso NUNCA leva REDS nem endereço: só tipo, município e quantidade. Quem toca entra no painel (com login) pra ver o detalhe.
// ================================================================

export interface Evento { id: number; tipo: string; municipio: string | null; qtd: number; user_id: string | null }
export interface Sub { id: number; user_id: string; endpoint: string; p256dh_key: string; auth_key: string }
export interface Prefs { user_id: string; ativo: boolean; tipos: string[]; municipios: string[] }
export interface Payload { title: string; body: string; url: string; pagina: string; tag: string }

export interface Deps {
  getPrivate(key: string): Promise<string | null>;
  saveVapid(publicKey: string, privateKey: string): Promise<void>;
  gerarVapid(): { publicKey: string; privateKey: string };
  tokenValido(token: string): Promise<boolean>;
  userDoJwt(jwt: string): Promise<string | null>;
  // marca processado_em e devolve só os reservados AGORA (retry não reenvia). Com `soTesteDe`, só mexe no evento 'teste' DESSE usuário
  // (um usuário comum não pode "queimar" os eventos da rotina passando os ids deles)
  reservarEventos(ids: number[], soTesteDe?: string): Promise<Evento[]>;
  getAprovados(): Promise<string[]>;                           // user_id de quem tem cadastro aprovado
  getPrefs(userIds: string[]): Promise<Map<string, Prefs>>;   // quem não tem linha = padrão (tudo ligado, todos os municípios)
  getSubscriptions(userIds: string[]): Promise<Sub[]>;
  deleteSubscriptions(ids: number[]): Promise<void>;
  enviar(sub: Sub, payload: string, vapid: { publicKey: string; privateKey: string }): Promise<void>; // lança {statusCode} se o push service recusar
}

export const TIPOS = ['atualizacao', 'mv', 'pm', 'cvpe', 'cvpa', 'vd'];
const PRIORIDADE = ['pm', 'mv', 'cvpe', 'cvpa', 'vd', 'atualizacao'];
const PAGINA: Record<string, string> = { pm: 'cvpe', mv: 'imv', cvpe: 'cvpe', cvpa: 'cvpa', vd: 'violencia_domestica', atualizacao: 'home' };
const NOMES: Record<string, string> = {
  'ARACUAI': 'Araçuaí', 'ITAOBIM': 'Itaobim', 'PEDRA AZUL': 'Pedra Azul', 'MEDINA': 'Medina', 'ITINGA': 'Itinga', 'AGUAS VERMELHAS': 'Águas Vermelhas',
  'DIVISA ALEGRE': 'Divisa Alegre', 'CORONEL MURTA': 'Coronel Murta', 'PADRE PARAISO': 'Padre Paraíso', 'PONTO DOS VOLANTES': 'Ponto dos Volantes',
  'CACHOEIRA DE PAJEU': 'Cachoeira de Pajeú', 'VIRGEM DA LAPA': 'Virgem da Lapa', 'COMERCINHO': 'Comercinho',
};
const CONCORRENCIA = 10;

export const norm = (s: string | null | undefined) => (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
const bonito = (m: string | null) => (m ? (NOMES[norm(m)] ?? m) : '');
const em = (m: string | null) => (m ? ` em ${bonito(m)}` : '');
const plural = (q: number, um: string, varios: string) => (q === 1 ? um : varios);

function linha(e: Evento): string {
  const q = e.qtd;
  switch (e.tipo) {
    case 'pm': return `${plural(q, 'policial militar vítima', q + ' policiais militares vítimas')}${em(e.municipio)}`;
    case 'mv': return `${q} ${plural(q, 'morte violenta', 'mortes violentas')}${em(e.municipio)}`;
    case 'cvpe': return `${q} ${plural(q, 'crime violento contra a pessoa', 'crimes violentos contra a pessoa')}${em(e.municipio)}`;
    case 'cvpa': return `${q} ${plural(q, 'crime violento contra o patrimônio', 'crimes violentos contra o patrimônio')}${em(e.municipio)}`;
    case 'vd': return `${q} ${plural(q, 'caso novo de violência doméstica', 'casos novos de violência doméstica')}${em(e.municipio)}`;
    default: return 'painel atualizado';
  }
}
const TITULO: Record<string, string> = {
  pm: 'Policial militar vítima', mv: 'Morte violenta registrada', cvpe: 'Crime violento contra a pessoa',
  cvpa: 'Crime violento contra o patrimônio', vd: 'Violência doméstica — caso novo', atualizacao: 'Painel atualizado',
};

// Um aviso por pessoa por publicação: o evento mais grave dá o título e o destino, o resto vira texto.
export function montarAviso(eventos: Evento[]): Payload | null {
  if (!eventos.length) return null;
  const ordenados = [...eventos].sort((a, b) => PRIORIDADE.indexOf(a.tipo) - PRIORIDADE.indexOf(b.tipo));
  const topo = ordenados[0];
  const linhas = ordenados.map(linha);
  const corpo = linhas.length > 4 ? [...linhas.slice(0, 4), `e mais ${linhas.length - 4}`].join(' · ') : linhas.join(' · ');
  const pagina = PAGINA[topo.tipo] ?? 'home';
  return {
    title: `70º BPM · ${TITULO[topo.tipo] ?? 'Aviso'}`,
    body: corpo.charAt(0).toUpperCase() + corpo.slice(1),
    url: `./?pagina=${pagina}`,
    pagina,
    tag: '70bpm-painel',
  };
}

export function quer(prefs: Prefs | undefined, e: Evento): boolean {
  const p = prefs ?? { user_id: '', ativo: true, tipos: TIPOS, municipios: [] };
  if (!p.ativo) return false;
  if (!p.tipos.includes(e.tipo)) return false;
  if (!e.municipio || !p.municipios.length) return true;
  return p.municipios.map(norm).includes(norm(e.municipio));
}

const json = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });

async function garantirVapid(deps: Deps) {
  let pub = await deps.getPrivate('vapid_public_key'), priv = await deps.getPrivate('vapid_private_key');
  if (pub && priv) return { publicKey: pub, privateKey: priv };
  const novo = deps.gerarVapid();
  await deps.saveVapid(novo.publicKey, novo.privateKey);
  pub = await deps.getPrivate('vapid_public_key'); priv = await deps.getPrivate('vapid_private_key'); // vale o que ficou gravado
  return { publicKey: pub ?? novo.publicKey, privateKey: priv ?? novo.privateKey };
}

async function enviarAvisos(deps: Deps, vapid: { publicKey: string; privateKey: string }, porUsuario: Map<string, Payload>, subs: Sub[]) {
  let enviados = 0, falhas = 0; const mortas: number[] = [];
  const fila = subs.filter((s) => porUsuario.has(s.user_id));
  let i = 0;
  async function trabalhador() {
    while (i < fila.length) {
      const sub = fila[i++];
      try { await deps.enviar(sub, JSON.stringify(porUsuario.get(sub.user_id)), vapid); enviados++; }
      catch (err) {
        const code = (err as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) mortas.push(sub.id); else falhas++; // 404/410: aparelho desinstalou/revogou
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCORRENCIA, fila.length) }, trabalhador));
  if (mortas.length) await deps.deleteSubscriptions(mortas);
  return { enviados, falhas, removidas: mortas.length };
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'método não permitido' }, 405);
  let corpo: { action?: string; ids?: unknown };
  try { corpo = await req.json(); } catch { return json({ error: 'JSON inválido' }, 400); }

  const token = req.headers.get('x-pipeline-token');
  const auth = req.headers.get('authorization') ?? '';
  let modo: 'rotina' | 'usuario' | null = null, userId: string | null = null;
  if (token && await deps.tokenValido(token)) modo = 'rotina';
  else if (/^Bearer\s+ey/i.test(auth)) { userId = await deps.userDoJwt(auth.replace(/^Bearer\s+/i, '')); if (userId) modo = 'usuario'; }
  if (!modo) return json({ error: 'não autorizado' }, 401);

  if (corpo.action === 'init') {
    if (modo !== 'rotina') return json({ error: 'não autorizado' }, 401);
    const v = await garantirVapid(deps);
    return json({ ok: true, vapid_public_key: v.publicKey });
  }

  const ids = Array.isArray(corpo.ids) ? corpo.ids.filter((x) => Number.isInteger(x)).slice(0, 200) as number[] : [];
  if (!ids.length) return json({ error: 'ids vazio' }, 400);
  const vapid = await garantirVapid(deps);

  const eventos = await deps.reservarEventos(ids, modo === 'usuario' ? userId! : undefined);
  const testes = eventos.filter((e) => e.tipo === 'teste');
  const normais = eventos.filter((e) => e.tipo !== 'teste');
  const porUsuario = new Map<string, Payload>();

  // teste: só o próprio usuário, e só no evento dele
  for (const t of testes) {
    if (modo === 'usuario' && t.user_id === userId) {
      porUsuario.set(t.user_id!, { title: '70º BPM · Teste de aviso', body: 'Funcionou: este aparelho vai receber os avisos do painel.', url: './?pagina=notificacoes', pagina: 'notificacoes', tag: '70bpm-teste' });
    }
  }
  if (modo === 'rotina' && normais.length) {
    const aprovados = await deps.getAprovados();
    const prefs = await deps.getPrefs(aprovados);
    for (const uid of aprovados) {
      const aviso = montarAviso(normais.filter((e) => quer(prefs.get(uid), e)));
      if (aviso) porUsuario.set(uid, aviso);
    }
  }
  if (!porUsuario.size) return json({ ok: true, eventos: eventos.length, avisos: 0, enviados: 0 });

  const subs = await deps.getSubscriptions([...porUsuario.keys()]);
  const r = await enviarAvisos(deps, vapid, porUsuario, subs);
  return json({ ok: true, eventos: eventos.length, avisos: porUsuario.size, ...r });
}

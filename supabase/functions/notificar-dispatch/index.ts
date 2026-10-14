// ================================================================
// 70º BPM — Supabase Edge Function: notificar-dispatch (Web Push)
// Deploy: verify_jwt DESLIGADO (a função mesmo confere o token da rotina ou o JWT do usuário — ver dispatch.ts).
// Não precisa de `supabase secrets set`: as chaves VAPID moram em app_private_config (privada) e app_public_config (pública)
// e a função gera o par sozinha na 1ª chamada com {"action":"init"}.
// ================================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';
import { type Deps, handle } from './dispatch.ts';

const sb = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { persistSession: false } });
const CHUNK = 150;
const partes = <T>(a: T[], n = CHUNK): T[][] => { const o: T[][] = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const VAPID_SUBJECT = 'https://cadu0207-alt.github.io/70BPM/'; // contato do push service (https:// ou mailto:)

const sha256hex = async (t: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))).map((b) => b.toString(16).padStart(2, '0')).join('');

const deps: Deps = {
  async getPrivate(key) {
    const { data, error } = await sb.from('app_private_config').select('value').eq('key', key).maybeSingle();
    if (error) throw new Error('app_private_config: ' + error.message);
    return data?.value ?? null;
  },
  async saveVapid(pub, priv) {
    const a = await sb.from('app_private_config').upsert([{ key: 'vapid_public_key', value: pub }, { key: 'vapid_private_key', value: priv }], { onConflict: 'key', ignoreDuplicates: true });
    if (a.error) throw new Error('saveVapid(private): ' + a.error.message);
    const b = await sb.from('app_public_config').upsert([{ key: 'vapid_public_key', value: pub }], { onConflict: 'key', ignoreDuplicates: true });
    if (b.error) throw new Error('saveVapid(public): ' + b.error.message);
  },
  gerarVapid: () => webpush.generateVAPIDKeys(),
  async tokenValido(token) {
    const { data, error } = await sb.from('pipeline_tokens').select('token_hash').eq('token_hash', await sha256hex(token)).limit(1);
    return !error && !!data && data.length > 0;
  },
  async userDoJwt(jwt) {
    const { data, error } = await sb.auth.getUser(jwt);
    return error || !data?.user ? null : data.user.id;
  },
  async reservarEventos(ids, soTesteDe) {
    // UPDATE ... WHERE processado_em IS NULL RETURNING: uma chamada repetida (retry) não reserva de novo
    let q = sb.from('notificacao_eventos').update({ processado_em: new Date().toISOString() }).in('id', ids).is('processado_em', null);
    if (soTesteDe) q = q.eq('tipo', 'teste').eq('user_id', soTesteDe);
    const { data, error } = await q.select('id,tipo,municipio,qtd,user_id');
    if (error) throw new Error('notificacao_eventos: ' + error.message);
    return data ?? [];
  },
  async getAprovados() {
    const { data, error } = await sb.from('perfis').select('user_id').eq('aprovado', true);
    if (error) throw new Error('perfis: ' + error.message);
    return (data ?? []).map((r: { user_id: string }) => r.user_id);
  },
  async getPrefs(userIds) {
    const m = new Map();
    for (const p of partes(userIds)) {
      const { data, error } = await sb.from('notificacao_prefs').select('user_id,ativo,tipos,municipios').in('user_id', p);
      if (error) throw new Error('notificacao_prefs: ' + error.message);
      for (const r of data ?? []) m.set(r.user_id, r);
    }
    return m;
  },
  async getSubscriptions(userIds) {
    const out = [];
    for (const p of partes(userIds)) {
      const { data, error } = await sb.from('push_subscriptions').select('id,user_id,endpoint,p256dh_key,auth_key').in('user_id', p);
      if (error) throw new Error('push_subscriptions: ' + error.message);
      out.push(...(data ?? []));
    }
    return out;
  },
  async deleteSubscriptions(ids) {
    const { error } = await sb.from('push_subscriptions').delete().in('id', ids);
    if (error) console.error('[notificar-dispatch] limpando inscrições mortas:', error.message);
  },
  async enviar(sub, payload, vapid) {
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh_key, auth: sub.auth_key } }, payload,
      { vapidDetails: { subject: VAPID_SUBJECT, publicKey: vapid.publicKey, privateKey: vapid.privateKey }, TTL: 12 * 3600, urgency: 'high' });
  },
};

Deno.serve(async (req) => {
  try { return await handle(req, deps); }
  catch (err) {
    console.error('[notificar-dispatch]', err);
    return new Response(JSON.stringify({ error: String((err as Error).message ?? err) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
});

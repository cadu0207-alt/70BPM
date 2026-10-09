#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
publicar_restrito.py — separa o que é PÚBLICO do que é RESTRITO no data.json.

Por quê (2026-10-09): o repositório/site é público e o data.json trazia, por ocorrência de
violência doméstica & afins, nº do REDS, data, bairro, RUA e NÚMERO da casa. Isso agora fica
só no Supabase (tabela `dados_restritos`, leitura só pra PPVD aprovado via RLS).

Fluxo:
  - `data_completo.json`  (ESTA PASTA, nunca vai pro repo): arquivo de trabalho com tudo —
    a rotina lê e grava nele (inclusive `ocorrencias_graves`, que é append-only e precisa do
    histórico completo).
  - `data.json`           : cópia PÚBLICA (blocos restritos viram `{}`) — é o que vai pro repo.
  - `data_restrito.json`  : só os blocos restritos (conferência local; nunca vai pro repo).
  - Supabase `dados_restritos`: recebe os blocos restritos pela função `publicar_dados_restritos`,
    autenticada por um TOKEN só de escrita (só o hash fica no banco). O token fica FORA do repo
    e do Drive: ~/.70bpm/pipeline_token.txt (ou variável de ambiente PIPELINE_TOKEN_70BPM).
"""
import copy, json, os, urllib.error, urllib.request
import leitura_csv as lc

_here = os.path.dirname(os.path.abspath(__file__))
PATH_COMPLETO = os.path.join(_here, 'data_completo.json')
PATH_PUBLICO = os.path.join(_here, 'data.json')
PATH_RESTRITO = os.path.join(_here, 'data_restrito.json')

# chave do bloco -> sub-chaves que saem do data.json público
RESTRITO = {
    'violencia_domestica': ['ocorrencias', 'enderecos_reincidentes'],
    'analise_preditiva': ['ocorrencias_graves', 'enderecos_reincidentes'],
    'reincidencia': ['enderecos'],
    'crimes_violentos': ['ocorrencias'],
}

SUPABASE_URL = 'https://qzhhuxzdilwdsulttdhq.supabase.co'
SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_rfrKp8UGRPMhOWI2-2jpbg_IS5ToAOK'  # pública por natureza (já está no index.html)


def _tem_restrito(d):
    return any(d.get(b, {}).get(s) for b, subs in RESTRITO.items() for s in subs)


def carregar():
    """Lê o arquivo de trabalho completo. Na 1ª vez (migração) parte do data.json antigo, que
    ainda tinha tudo. Se não achar dado restrito em lugar nenhum, PARA — seguir adiante
    apagaria o histórico append-only de ocorrencias_graves."""
    if os.path.exists(PATH_COMPLETO):
        return json.load(open(PATH_COMPLETO, encoding='utf-8'))
    d = json.load(open(PATH_PUBLICO, encoding='utf-8'))
    if not _tem_restrito(d):
        raise SystemExit('data_completo.json não existe e data.json já está sem os blocos restritos. '
                         'Restaure o completo (backup data.json.bak_* ou tabela dados_restritos) antes de rodar.')
    return d


def separar(data):
    """Devolve (publico, restrito) sem alterar `data`."""
    publico = copy.deepcopy(data)
    restrito = {}
    for bloco, subs in RESTRITO.items():
        if bloco not in publico:
            continue
        restrito[bloco] = {}
        for s in subs:
            if s in publico[bloco]:
                restrito[bloco][s] = publico[bloco][s]
                publico[bloco][s] = {}
    return publico, restrito


def _token():
    t = os.environ.get('PIPELINE_TOKEN_70BPM')
    if t:
        return t.strip()
    p = os.path.join(os.path.expanduser('~'), '.70bpm', 'pipeline_token.txt')
    return open(p).read().strip() if os.path.exists(p) else None


def _enviar(chave, conteudo, token):
    corpo = json.dumps({'p_token': token, 'p_chave': chave, 'p_conteudo': conteudo}, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(
        SUPABASE_URL + '/rest/v1/rpc/publicar_dados_restritos', data=corpo, method='POST',
        headers={'Content-Type': 'application/json', 'apikey': SUPABASE_PUBLISHABLE_KEY,
                 'Authorization': 'Bearer ' + SUPABASE_PUBLISHABLE_KEY})
    with urllib.request.urlopen(req, timeout=90) as r:
        r.read()
    return len(corpo)


def salvar(data, enviar=True):
    """Grava completo + público + restrito e (se houver token) envia o restrito ao Supabase.
    Nunca levanta erro de rede: devolve um dict de status pro relatório da rotina."""
    reparados = lc.reparar_arvore(data)  # rede de segurança contra acento quebrado (UTF-8 lido como latin-1)
    publico, restrito = separar(data)
    json.dump(data, open(PATH_COMPLETO, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    json.dump(publico, open(PATH_PUBLICO, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    json.dump(restrito, open(PATH_RESTRITO, 'w', encoding='utf-8'), ensure_ascii=False)
    status = {'publico': PATH_PUBLICO, 'enviado': {}, 'erros': {}, 'textos_reparados': reparados}
    if not enviar:
        status['aviso'] = 'envio ao Supabase desligado'
        return status
    token = _token()
    if not token:
        status['aviso'] = 'SEM TOKEN (~/.70bpm/pipeline_token.txt): dados restritos NÃO foram atualizados no Supabase'
        return status
    for chave, conteudo in restrito.items():
        for tentativa in (1, 2):
            try:
                status['enviado'][chave] = _enviar(chave, conteudo, token)
                status['erros'].pop(chave, None)
                break
            except (urllib.error.URLError, OSError) as e:
                detalhe = getattr(e, 'read', lambda: b'')().decode('utf-8', 'replace')[:200] if hasattr(e, 'read') else ''
                status['erros'][chave] = f'{type(e).__name__}: {e} {detalhe}'.strip()
    return status

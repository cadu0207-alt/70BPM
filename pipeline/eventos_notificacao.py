#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
eventos_notificacao.py — avisos no celular (Web Push) a cada publicação da rotina de dados. 2026-10-14

O que faz: compara o que ficou publicado agora com o que já tinha sido avisado da última vez (arquivo notificacao_estado.json,
NESTA pasta — nunca vai pro repo, tem nº de REDS) e manda ao Supabase só EVENTOS agregados:
    {tipo, municipio, qtd}  (tipos: mv, pm, cvpe, cvpa, vd, atualizacao)
Nada de REDS/endereço sai daqui: a Edge Function `notificar-dispatch` escolhe quem recebe (cadastro aprovado + preferências de
tipo/município) e manda um aviso por pessoa.

Regras de segurança contra aviso errado/spam:
  * 1ª execução (sem arquivo de estado) = só grava a linha de base, NÃO avisa (senão avisaria o ano inteiro).
  * se algo falhar (publicação restrita, rede, função), o estado NÃO avança: a próxima rodada tenta de novo os mesmos eventos.
  * muita coisa nova de uma vez (> LIMITE_SUSPEITO REDS) costuma ser reconstrução/restauração de dados: avisa só "painel atualizado".
  * PIPELINE_SEM_AVISOS=1 desliga tudo (rodada de teste).
"""
import hashlib, json, os, unicodedata

import publicar_restrito as pr

_here = os.path.dirname(os.path.abspath(__file__))
PATH_ESTADO = os.path.join(_here, 'notificacao_estado.json')
CATEGORIAS = ('mv', 'pm', 'cvpe', 'cvpa', 'vd')
LIMITE_SUSPEITO = 80


def _norm(s):
    return unicodedata.normalize('NFKD', s or '').encode('ascii', 'ignore').decode().upper().strip()


def _por_municipio(blocos, so_se=None):
    out = {}
    for muni, itens in (blocos or {}).items():
        reds = sorted({o['r'] for o in (itens or []) if o.get('r') and (so_se is None or o.get(so_se))})
        if reds:
            out[_norm(muni)] = reds
    return out


def assinatura(data):
    """Impressão digital dos totais publicados: muda quando QUALQUER indicador ganha dado novo (mesmo sem caso novo)."""
    tot = {}
    for chave, bloco in data.items():
        if isinstance(bloco, dict) and isinstance(bloco.get('total_acum'), list) and bloco['total_acum']:
            tot[chave] = bloco['total_acum'][-1]
    for chave in ('violencia_domestica', 'crimes_violentos', 'reincidencia'):
        b = data.get(chave) or {}
        if isinstance(b.get('panorama'), dict):
            tot[chave + ':panorama'] = json.dumps(b['panorama'], sort_keys=True, default=str)
    return hashlib.sha1(json.dumps(tot, sort_keys=True, default=str).encode('utf-8')).hexdigest()


def snapshot(data):
    cv = data.get('crimes_violentos') or {}
    return {
        'vd': _por_municipio((data.get('violencia_domestica') or {}).get('ocorrencias')),
        'mv': _por_municipio(cv.get('mv_ocorrencias')),
        'cvpe': _por_municipio(cv.get('cvpe_ocorrencias')),
        'cvpa': _por_municipio(cv.get('cvpa_ocorrencias')),
        'pm': _por_municipio(cv.get('cvpe_ocorrencias'), so_se='pm'),
        'sig': assinatura(data),
    }


def calcular_eventos(antes, depois):
    """(eventos, total_de_reds_novos). `antes` = estado já avisado; `depois` = snapshot atual."""
    eventos, total = [], 0
    for cat in CATEGORIAS:
        for muni, reds in sorted((depois.get(cat) or {}).items()):
            novos = set(reds) - set((antes.get(cat) or {}).get(muni, []))
            if novos:
                eventos.append({'tipo': cat, 'municipio': muni, 'qtd': len(novos)})
                if cat != 'pm':   # pm é subconjunto do cvpe: não conta duas vezes
                    total += len(novos)
    mudou = antes.get('sig') != depois.get('sig')
    return eventos, total, mudou


def carregar_estado():
    if os.path.exists(PATH_ESTADO):
        try:
            return json.load(open(PATH_ESTADO, encoding='utf-8'))
        except Exception:
            return None
    return None


def salvar_estado(snap):
    json.dump(snap, open(PATH_ESTADO, 'w', encoding='utf-8'), ensure_ascii=False)


def notificar(data, status_publicacao, enviar=True):
    """Chamada no fim da rotina (driver_grave.main), DEPOIS de pr.salvar(data). Devolve um dict pro relatório."""
    if os.environ.get('PIPELINE_SEM_AVISOS') == '1':
        return {'skipped': True, 'motivo': 'PIPELINE_SEM_AVISOS=1'}
    if status_publicacao.get('erros') or status_publicacao.get('aviso'):
        return {'skipped': True, 'motivo': 'a publicação dos dados restritos não fechou; estado não avançou'}
    atual = snapshot(data)
    antes = carregar_estado()
    if antes is None:
        salvar_estado(atual)
        return {'baseline': True, 'motivo': '1ª execução: linha de base gravada, nenhum aviso enviado'}
    eventos, total, mudou = calcular_eventos(antes, atual)
    suprimido = False
    if total > LIMITE_SUSPEITO:
        eventos, suprimido = [], True       # reconstrução/restauração de dados: não avisa caso por caso
    if mudou or suprimido:
        eventos.append({'tipo': 'atualizacao', 'municipio': None, 'qtd': 1})
    res = {'novos_reds': total, 'eventos': len(eventos), 'suprimido': suprimido}
    if not eventos:
        salvar_estado(atual)
        return res
    if not enviar:
        res['seco'] = True
        return res
    try:
        ids = pr.publicar_eventos(eventos)
        res['ids'] = len(ids)
        res['funcao'] = pr.disparar_notificacoes(ids) if ids else {}
    except Exception as e:   # rede/banco/função fora do ar: o estado NÃO avança, a próxima rodada tenta de novo
        res['erro'] = f'{type(e).__name__}: {e}'
        return res
    salvar_estado(atual)
    return res

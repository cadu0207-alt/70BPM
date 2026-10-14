#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Testes de eventos_notificacao.py (sem rede, sem Supabase). Rodar: python test_eventos_notificacao.py"""
import json, os, sys, tempfile

import eventos_notificacao as en

falhas = 0


def checa(cond, ok, ruim=''):
    global falhas
    if cond:
        print('  ✔ ' + ok)
    else:
        falhas += 1
        print('  ✖ ' + (ruim or ok))


def dado(vd=None, mv=None, cvpe=None, cvpa=None, total=10):
    return {
        'violencia_domestica': {'ocorrencias': vd or {}, 'panorama': {'total_mes': [1]}},
        'crimes_violentos': {'mv_ocorrencias': mv or {}, 'cvpe_ocorrencias': cvpe or {}, 'cvpa_ocorrencias': cvpa or {}},
        'mv': {'total_acum': [1, 2, total]},
    }


o = lambda r, **k: {'r': r, **k}

print('\n[1] Cálculo de eventos')
a = en.snapshot(dado(vd={'Araçuaí': [o('V1'), o('V2')]}, mv={'ARACUAI': [o('M1')]}, cvpe={'MEDINA': [o('C1', pm=False)]}))
b = en.snapshot(dado(vd={'ARACUAI': [o('V1'), o('V2'), o('V3'), o('V4')], 'ITAOBIM': [o('V9')]}, mv={'ARACUAI': [o('M1'), o('M2')]},
                     cvpe={'MEDINA': [o('C1', pm=False), o('C2', pm=True)]}, cvpa={'ITINGA': [o('P1')]}, total=11))
ev, total, mudou = en.calcular_eventos(a, b)
por = {(e['tipo'], e['municipio']): e['qtd'] for e in ev}
checa(por.get(('vd', 'ARACUAI')) == 2 and por.get(('vd', 'ITAOBIM')) == 1, 'caso novo de VD por município (nome normalizado: "Araçuaí" = ARACUAI)', str(por))
checa(por.get(('mv', 'ARACUAI')) == 1 and por.get(('cvpe', 'MEDINA')) == 1 and por.get(('cvpa', 'ITINGA')) == 1, 'MV, CVPE e CVPa novos')
checa(por.get(('pm', 'MEDINA')) == 1, 'policial militar vítima vira evento próprio')
checa(total == 2 + 1 + 1 + 1 + 1 and mudou, f'total de REDS novos sem contar o PM duas vezes ({total}) e painel mudou')
ev2, t2, m2 = en.calcular_eventos(b, b)
checa(not ev2 and t2 == 0 and not m2, 'sem mudança: nenhum evento')
checa(not any('V1' in json.dumps(e) or 'M1' in json.dumps(e) for e in ev), 'nenhum REDS dentro dos eventos')

print('\n[2] Fluxo da rotina (estado, baseline, falhas, limite)')
tmp = tempfile.mkdtemp()
en.PATH_ESTADO = os.path.join(tmp, 'estado.json')
enviados = []
en.pr.publicar_eventos = lambda ev: (enviados.append(ev), list(range(1, len(ev) + 1)))[1]
en.pr.disparar_notificacoes = lambda ids: {'ok': True, 'avisos': 1}
base = dado(vd={'ARACUAI': [o('V1')]})
r1 = en.notificar(base, {'erros': {}})
checa(r1.get('baseline') and not enviados and os.path.exists(en.PATH_ESTADO), '1ª execução grava a linha de base e NÃO avisa')
r2 = en.notificar(base, {'erros': {}})
checa(r2['eventos'] == 0 and not enviados, 'repetir sem mudança: nada a avisar')
novo = dado(vd={'ARACUAI': [o('V1'), o('V2')]}, total=12)
r3 = en.notificar(novo, {'erros': {'vd': 'x'}})
checa(r3.get('skipped') and not enviados, 'publicação restrita com erro: não avisa e não avança o estado')
r4 = en.notificar(novo, {'erros': {}})
tipos = sorted(e['tipo'] for e in enviados[0])
checa(r4['eventos'] == 2 and tipos == ['atualizacao', 'vd'] and r4['funcao'].get('ok'), 'caso novo + dado novo: evento de VD e "painel atualizado"', str(r4) + str(enviados))
r5 = en.notificar(novo, {'erros': {}})
checa(r5['eventos'] == 0 and len(enviados) == 1, 'depois de avisar, o estado avançou (não repete)')
en.pr.publicar_eventos = lambda ev: (_ for _ in ()).throw(OSError('rede fora'))
mais = dado(vd={'ARACUAI': [o('V1'), o('V2'), o('V3')]}, total=13)
r6 = en.notificar(mais, {'erros': {}})
checa('erro' in r6 and en.carregar_estado()['vd']['ARACUAI'] == ['V1', 'V2'], 'rede fora: estado NÃO avança (tenta de novo na próxima)', str(r6))
en.pr.publicar_eventos = lambda ev: (enviados.append(ev), [1])[1]
r7 = en.notificar(mais, {'erros': {}})
checa(r7['eventos'] == 2 and en.carregar_estado()['vd']['ARACUAI'] == ['V1', 'V2', 'V3'], 'na rodada seguinte os mesmos eventos saem e o estado avança', str(r7))
enorme = dado(vd={'ARACUAI': [o('X%03d' % i) for i in range(200)]}, total=99)
r8 = en.notificar(enorme, {'erros': {}})
ultimo = enviados[-1]
checa(r8['suprimido'] and [e['tipo'] for e in ultimo] == ['atualizacao'], 'avalanche de REDS novos (reconstrução de dados): avisa só "painel atualizado"', str(r8))
os.environ['PIPELINE_SEM_AVISOS'] = '1'
checa(en.notificar(enorme, {'erros': {}}).get('skipped'), 'PIPELINE_SEM_AVISOS=1 desliga tudo')

print(f'\n✖ {falhas} FALHA(S)' if falhas else '\n✔ TUDO CERTO (eventos)')
sys.exit(1 if falhas else 0)

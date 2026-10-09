#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ajustes_manuais.py — correções aprovadas em auditoria que a fonte (SiGOp) ainda não refletiu.

Caso de uso (2026-10-09): MV de Virgem da Lapa (REDS 2026-043622226-001, "lesão corporal" marcada
como MV por erro de cadastro do boletim). A auditoria aprovou a retirada, mas o export do SiGOp
continua trazendo o MV até alguém corrigir o REDS lá. Como a rotina SOBRESCREVE a célula com o que
vem da fonte, uma edição manual no data.json voltaria na próxima rodada.

Solução: lista de REDS com o sinal de MV (colunas IMV_*) NEUTRALIZADO nas linhas lidas, antes de
qualquer agregação (arquivo MV e TODOS OS B.O -> vale pra MV e Crimes Violentos). O ajuste se
DESLIGA SOZINHO: quando, no export de MV, o REDS some ou vem com IMV_TOTAL = 0, a fonte já foi
corrigida -> status vira "resolvido", a rotina avisa no relatório ("AJUSTE RESOLVIDO") e para de
mexer (se o REDS voltar a ser MV de verdade depois, passa a contar normalmente).

Arquivo de dados: ajustes_manuais.json (nesta pasta).
"""
import datetime, json, os

_here = os.path.dirname(os.path.abspath(__file__))
ARQUIVO = os.path.join(_here, 'ajustes_manuais.json')


def _carregar():
    if not os.path.exists(ARQUIVO):
        return []
    return json.load(open(ARQUIVO, encoding='utf-8'))


def _salvar(lista):
    json.dump(lista, open(ARQUIVO, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)


def neutralizar_mv(rows, fonte, report):
    """Zera as colunas IMV_* dos REDS com ajuste ATIVO (modifica `rows` no lugar).
    `fonte` = 'MV' (export dedicado: é ele que decide se o ajuste foi resolvido) ou outro nome
    (ex.: 'TODOS OS B.O': só neutraliza, não decide). Registra o que aconteceu em report."""
    ajustes = _carregar()
    if not ajustes:
        return
    ativos = [a for a in ajustes if a.get('tipo') == 'neutralizar_mv' and a.get('status') == 'ativo']
    if not ativos:
        return
    por_reds = {}
    for r in rows:
        por_reds.setdefault(r.get('NUMERO_REDS', ''), []).append(r)
    mudou = False
    eventos = report.setdefault('ajustes_manuais', [])
    for a in ativos:
        linhas = por_reds.get(a['reds'], [])
        com_mv = [r for r in linhas if int(r.get('IMV_TOTAL') or 0) > 0]
        if com_mv:
            for r in com_mv:
                for k in list(r.keys()):
                    if k.startswith('IMV_'):
                        r[k] = '0'
            eventos.append({'id': a['id'], 'fonte': fonte, 'situacao': 'APLICADO',
                            'detalhe': f"{a['reds']} ainda vem como MV no export de {fonte}; sinal de MV neutralizado (auditoria aprovada)."})
        elif fonte == 'MV':
            a['status'] = 'resolvido'
            a['resolvido_em'] = datetime.date.today().isoformat()
            mudou = True
            eventos.append({'id': a['id'], 'fonte': fonte, 'situacao': 'AJUSTE RESOLVIDO',
                            'detalhe': f"{a['reds']} não vem mais como MV no export de MV — a fonte já refletiu a retirada. Ajuste desligado."})
    if mudou:
        _salvar(ajustes)

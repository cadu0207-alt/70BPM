#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
driver_grave.py — persiste o "main()" que faltava em aggregate_grave.py (ver seu
docstring: "cada rodada da rotina diária reconstrói a lógica ad-hoc"). Criado em
2026-09-01 a pedido de Eduardo, junto com a mudança de política em aggregate.py
(remoção da proteção contra queda — ver CONTEXTO_DASHBOARD_70BPM.md seção 2026-09-01).

Cobre, sem proteção de queda (overwrite direto, igual aggregate.py agora):
  - Esforço-Furto/Prisões (fonte: TODOS OS B.O)
  - IDOB — quantidade de operações Boemia (fonte: entrada/IDOB, RAT)
  - IDOB-vítimas — MV/CVPe/CVPa em bar/boate (fonte: TODOS OS B.O, filtro de local bar/boate; desde 2026-10-09 — a pasta CRIMES VIOLENTOS BOEMIA ficou sem uso)
  - Cavalo de Aço Eficácia/Eficiência (fonte: TODOS OS RAT)

★ 2026-09-03: passou a cobrir também o bloco "rebuild completo" (fonte: TODOS OS B.O),
com proteção de queda de 2% de tolerância (export mais estreito não derruba o dado):
  - Análise Preditiva — só o subconjunto Homicídio/Feminicídio/Tentativa (panorama +
    municípios + ocorrencias_graves, este último em modo APPEND-ONLY por REDS novo —
    nunca sobrescreve a lista inteira, que também recebe outras naturezas por lógica
    ainda não automatizada).
  - Violência Doméstica (natureza U33004) — rebuild completo de panorama/municípios/
    ranking/ocorrencias/enderecos_reincidentes.
  - Crimes Violentos (MV+CVPe+CVPa union) — rebuild completo.
  - Reincidência de Endereço (janela 60 dias) — rebuild completo.
  Motivado por Eduardo perguntar se VD tava preparada pra receber os próximos meses
  sozinha — não estava (só rodava quando alguém pedia manualmente). Ver memória
  project_p3_vd_rebuild_automatizado_03set.

★ 2026-09-08 (pedido de Eduardo, política de "rodar tudo junto" — ver
CONTEXTO_DASHBOARD_70BPM.md seção 13): ligados mais 2 blocos que já tinham função pronta
e validada em aggregate_grave.py, mas nunca tinham sido chamados por main() — a ressalva
antiga aqui embaixo estava desatualizada em relação ao que a própria docstring de cada
função já confirmava:
  - Análise Preditiva — panorama geral completo (total_mes/prec_mes/mp_mes/armas_mes/
    pris_mes/vd_mes, fonte: TODOS OS B.O, mesma proteção de 2% dos outros 4 blocos de
    rebuild completo). Continua NÃO cobrindo a lista completa de `ocorrencias_graves`
    de naturezas além de Homicídio/Tentativa (só a fatia homic/tent é append-only).
  - ITVD — merge por célula (fonte: TODOS OS B.O, mesma linha do Esforço-Furto acima),
    confirmado por Eduardo em 2026-08-28 quando a fonte foi trocada pra TODOS OS B.O.

NÃO cobre ainda:
  - A lista completa `ocorrencias_graves` de naturezas precursoras além de Homicídio/
    Tentativa (só a fatia homic/tent tem append-only automático).

USO: python3 driver_grave.py  (roda a partir da pasta onde está data.json)
"""
import collections
import re
import csv, json, os, glob, datetime
import aggregate_grave as ag
import publicar_restrito as pr
import eventos_notificacao as en
import ajustes_manuais as aj
import leitura_csv as lc

_here = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.join(_here, "entrada")
DATA_PATH = os.path.join(_here, "data.json")
N_MESES = 12  # Jan..Dez (expandido em 03/09/2026)


def latest_csv(folder):
    files = glob.glob(os.path.join(BASE, folder, "*.csv"))
    if not files:
        return None
    files.sort(key=os.path.getmtime)
    return files[-1]


def read_csv(path, encoding='utf-8'):
    # `encoding` virou só o FALLBACK: a codificação real é detectada pelos bytes (leitura_csv.py).
    # Os exports relatorio_estatisticas_* são UTF-8; lê-los como latin-1 quebrava os acentos.
    with lc.abrir_texto(path, fallback=encoding) as f:
        return list(csv.DictReader(f, delimiter=';'))


def merge_cell_dict(old_municipios, new_by_muni, field_mes, field_acum, preservar_indices=None):
    """Overwrite direto célula-a-célula pra estrutura {nome: [mes0..mesN]} — mesma
    política do aggregate.py (merge_cell), sem proteção de queda. old_municipios é a
    lista já existente em data.json[chave]['municipios']; devolve lista nova.
    `preservar_indices` (opcional): conjunto de índices de mês que NUNCA são
    sobrescritos pelo recálculo — mantém o valor que já estava em data.json, igual
    pra todos os municípios (diferente do ROLEZINHO_FROZEN, que fixa um valor
    específico por município; aqui é "não toca nesse mês", seja qual for o valor)."""
    preservar_indices = preservar_indices or set()
    out = []
    changes, drops = [], []
    for m in old_municipios:
        nome = m['nome']
        key = nome.strip().upper()
        old_mes = m.get(field_mes, [0]*N_MESES)
        new_mes = new_by_muni.get(key, [0]*N_MESES)
        merged = []
        for i in range(N_MESES):
            o = old_mes[i] if i < len(old_mes) else 0
            if i in preservar_indices:
                merged.append(o)
                continue
            n = new_mes[i] if i < len(new_mes) else 0
            if n < o:
                drops.append((nome, i, o, n))
            elif n > o:
                changes.append((nome, i, o, n))
            merged.append(n)
        acum = []
        s = 0
        for v in merged:
            s += v
            acum.append(s)
        new_row = dict(m)
        new_row[field_mes] = merged
        new_row[field_acum] = acum
        out.append(new_row)
    return out, changes, drops


def recompute_totals(obj, mes_field, acum_field, total_mes_key, total_acum_key):
    munis = obj.get('municipios', [])
    if not munis:
        return
    n = len(munis[0].get(mes_field, []))
    tm, ta = [0]*n, [0]*n
    for m in munis:
        for i, v in enumerate(m.get(mes_field, [])):
            if i < n: tm[i] += v
        for i, v in enumerate(m.get(acum_field, [])):
            if i < n: ta[i] += v
    obj[total_mes_key] = tm
    obj[total_acum_key] = ta


def run_esforco_furto(data, report):
    f = latest_csv('TODOS OS B.O')
    if not f:
        return
    rows = read_csv(f, encoding='latin-1')
    municipios_order = [m['nome'].upper() for m in data['esforco_furto']['municipios']]
    reds_mes, prisoes_mes, by_muni = ag.build_esforco_furto(rows, municipios_order, N_MESES)
    new_reds = {k: v['reds'] for k, v in by_muni.items()}
    new_pris = {k: v['prisoes'] for k, v in by_muni.items()}
    munis, ch1, dr1 = merge_cell_dict(data['esforco_furto']['municipios'], new_reds, 'reds_mes', 'reds_acum')
    munis2, ch2, dr2 = merge_cell_dict(munis, new_pris, 'prisoes_mes', 'prisoes_acum')
    data['esforco_furto']['municipios'] = munis2
    recompute_totals(data['esforco_furto'], 'reds_mes', 'reds_acum', 'total_reds_mes', 'total_reds_acum')
    recompute_totals(data['esforco_furto'], 'prisoes_mes', 'prisoes_acum', 'total_prisoes_mes', 'total_prisoes_acum')
    report['esforco_furto'] = {'file': f, 'changes_reds': ch1, 'drops_reds': dr1, 'changes_prisoes': ch2, 'drops_prisoes': dr2}


def run_idob_boemia(data, report):
    f = latest_csv('IDOB')
    if not f:
        return
    # entrada/IDOB precisa do export RAT (colunas NOME_OPERACAO/MES_NUMERICO/MUNICIPIO, UTF-8).
    # Achado em 2026-09-08/09: às vezes cai lá um export REDS/BO comum (mesmo formato de
    # Cavalo de Aço/Rolezinho/Padrinhos, latin1, sem essas colunas) por engano — não dá pra
    # processar, mas também não deve travar o resto da rotina. Só pula esse bloco e avisa.
    try:
        rows = read_csv(f, encoding='utf-8')
    except UnicodeDecodeError:
        report['idob_boemia'] = {'file': f, 'skipped': True, 'reason': 'Arquivo não é UTF-8 — provável export do tipo errado (REDS/BO em vez de RAT com NOME_OPERACAO). Reexportar a tela certa do SiGOp.'}
        return
    if not rows or 'NOME_OPERACAO' not in rows[0]:
        report['idob_boemia'] = {'file': f, 'skipped': True, 'reason': 'Arquivo não tem a coluna NOME_OPERACAO — não é o export RAT esperado. Reexportar a tela certa do SiGOp.'}
        return
    municipios_order = [m['nome'].upper() for m in data['idob']['municipios']]
    qop_total, by_muni = ag.build_idob_boemia(rows, municipios_order, N_MESES)
    # Jan/Fev (índices 0 e 1) preservados por decisão de Eduardo em 2026-09-09: aqueles
    # meses foram apurados por outro método (fora dessa busca do SiGOp) e não devem ser
    # sobrescritos pelo recálculo — só Março em diante usa o valor novo.
    IDOB_BOEMIA_PRESERVAR = {0, 1}
    munis, ch, dr = merge_cell_dict(data['idob']['municipios'], by_muni, 'qop_mes', 'qop_acum', preservar_indices=IDOB_BOEMIA_PRESERVAR)
    data['idob']['municipios'] = munis
    recompute_totals(data['idob'], 'qop_mes', 'qop_acum', 'total_qtdeop_mes', 'total_qtdeop_acum')
    report['idob_boemia'] = {'file': f, 'changes': ch, 'drops': dr, 'preservados': sorted(IDOB_BOEMIA_PRESERVAR)}

    # "Meta de Operações Boemia do Batalhão" (data['boemia_meta'], tabela separada na página
    # IDOB, contagem x meta fixa por fração) usa a MESMA quantidade de operações do bloco
    # acima como "realizado" — só a meta_mes/meta_acum é diferente (fixa por fração/tier).
    # Achado por Eduardo em 2026-09-28: esse bloco nunca tinha sido ligado a nenhum script,
    # ficou congelado em Agosto (Setembro aparecia como 0 operações contra a meta, quando na
    # real já tinha 214). Sincroniza o "realizado" a partir do qop_mes/qop_acum recém-calculado.
    if 'boemia_meta' in data:
        idob_by_nome = {m['nome'].strip().upper(): m for m in data['idob']['municipios']}
        for m in data['boemia_meta']['municipios']:
            src = idob_by_nome.get(m['nome'].strip().upper())
            if src:
                m['realizado_mes'] = list(src['qop_mes'])
                m['realizado_acum'] = list(src['qop_acum'])
        recompute_totals(data['boemia_meta'], 'realizado_mes', 'realizado_acum', 'total_mes', 'total_acum')


def run_idob_vitimas(data, rows, f, report):
    # Fonte trocada em 2026-10-09: antes lia entrada/CRIMES VIOLENTOS BOEMIA (export separado, parado
    # desde 11/08, então as vítimas de set/out do IDOB nunca atualizavam). Agora usa o TODOS OS B.O
    # (mesmas colunas, em dia): validado célula a célula — reproduz EXATAMENTE os valores de jan-ago
    # que vieram do arquivo antigo (0 diferenças). A pasta CRIMES VIOLENTOS BOEMIA ficou sem uso.
    municipios_order = [m['nome'].upper() for m in data['idob']['municipios']]
    # ★ n_meses FIXO em 8 (não n_meses_atuais(rows)) — bug documentado em 2026-08-27:
    # esse export é pequeno/parado, se o mes mais recente dele não tiver linha o array
    # fica mais curto que o resto do painel (ver CONTEXTO_DASHBOARD_70BPM.md).
    mv, cvpe, cvpa, by_muni = ag.build_idob_vitimas(rows, municipios_order, N_MESES)
    new_mv = {k: v['mv'] for k, v in by_muni.items()}
    new_cvpe = {k: v['cvpe'] for k, v in by_muni.items()}
    new_cvpa = {k: v['cvpa'] for k, v in by_muni.items()}
    munis, ch1, dr1 = merge_cell_dict(data['idob']['municipios'], new_mv, 'mv_mes', 'mv_acum')
    munis, ch2, dr2 = merge_cell_dict(munis, new_cvpe, 'cvpe_mes', 'cvpe_acum')
    munis, ch3, dr3 = merge_cell_dict(munis, new_cvpa, 'cvpa_mes', 'cvpa_acum')
    data['idob']['municipios'] = munis
    recompute_totals(data['idob'], 'mv_mes', 'mv_acum', 'total_mv_mes', 'total_mv_acum')
    recompute_totals(data['idob'], 'cvpe_mes', 'cvpe_acum', 'total_cvpe_mes', 'total_cvpe_acum')
    recompute_totals(data['idob'], 'cvpa_mes', 'cvpa_acum', 'total_cvpa_mes', 'total_cvpa_acum')
    report['idob_vitimas'] = {'fonte': 'TODOS OS B.O', 'file': f, 'drops': dr1 + dr2 + dr3, 'changes': ch1 + ch2 + ch3}


def run_cavalo_eficacia(data, report):
    # Desde 2026-10-15 a Eficácia usa o MESMO conjunto da meta: o export oficial (entrada/Cavalo de aço, RAT Y01003 + Histórico).
    # Antes usava TODOS OS RAT com "CAVALO" no nome da operação (2.034 x 2.181 oficiais; só 1.718 RATs nos dois). Se o export oficial não
    # tiver as colunas de produtividade ou não fechar com o total da meta, cai no método antigo e avisa.
    municipios_order = [m['nome'].upper() for m in data['cavaloaco_eficacia']['municipios']]
    meta_total = data['cavaloaco']['total_acum'][-1] if data.get('cavaloaco', {}).get('total_acum') else None
    f_of = latest_csv('Cavalo de aço')
    novo = None
    universo = None
    if f_of:
        try:
            rows = read_csv(f_of, encoding='utf-8')
        except UnicodeDecodeError:
            rows = []
        if rows and 'PRODUTIVIDADE' in rows[0] and 'EFETIVOS' in rows[0]:
            cand = ag.build_cavalo_eficacia(rows, municipios_order, N_MESES, todas_as_linhas=True)
            if sum(cand['totais'].get('num_ops', [])) == meta_total:
                novo, universo, f = cand, 'oficial', f_of
            else:
                report['cavalo_eficacia_aviso'] = f'export oficial não fecha com a meta ({sum(cand["totais"].get("num_ops", []))} x {meta_total}) — usado o método antigo'
    if novo is None:
        f = latest_csv('TODOS OS RAT')
        if not f:
            return
        rows = read_csv(f, encoding='latin-1')
        novo = ag.build_cavalo_eficacia(rows, municipios_order, N_MESES)
        universo = 'nome_da_operacao'
    old_total_ops = sum(data['cavaloaco_eficacia']['totais'].get('num_ops', []))
    new_total_ops = sum(novo['totais'].get('num_ops', []))
    data['cavaloaco_eficacia']['municipios'] = novo['municipios']
    data['cavaloaco_eficacia']['totais'] = novo['totais']
    data['cavaloaco_eficacia']['naturezas_reds_geradas'] = novo['naturezas_reds_geradas']
    data['cavaloaco_eficacia']['universo'] = universo
    data['cavaloaco_eficacia']['fonte'] = ('entrada/Cavalo de aço (RAT, mesmo conjunto da meta)' if universo == 'oficial' else 'entrada/TODOS OS RAT (nome da operação contém CAVALO)')
    report['cavalo_eficacia'] = {'file': f, 'universo': universo, 'old_total_ops': old_total_ops, 'new_total_ops': new_total_ops}


MESES_LABEL = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']


def periodo_label(total_mes):
    """'jan-<último mês com dado>/2026' — deriva do último índice não-zero do array total_mes."""
    ultimo = 0
    for i, v in enumerate(total_mes):
        if v > 0:
            ultimo = i
    return f'jan-{MESES_LABEL[ultimo]}/2026'


def periodo_label_rows(rows):
    """'jan-<mês mais recente do export>/2026' — pros blocos que usam o export inteiro (sem array mensal)."""
    meses = [int(r['MES_NUMERICO']) for r in rows if (r.get('MES_NUMERICO') or '').strip().isdigit()]
    return f'jan-{MESES_LABEL[max(meses) - 1]}/2026' if meses else None


def pop_by_muni_from_data(data):
    return {m['nome'].upper(): m.get('pop', 0) for m in data['violencia_domestica']['municipios']}


def run_analise_preditiva_homicidios(data, rows, report):
    """Só o subconjunto Homicídio/Feminicídio/Tentativa — não mexe em prec_mes/vd_mes/
    mp_mes/armas_mes/pris_mes/total_mes nem na parte de ocorrencias_graves de outras
    naturezas (ver docstring do módulo)."""
    ap = data['analise_preditiva']
    municipios_order = [m['nome'].upper() for m in ap['municipios']]
    n_meses = len(ap['panorama']['total_mes'])
    homic_mes, tent_mes, by_muni_homic, by_muni_tent, ocorrencias_novas = ag.build_homicidios_tentativas(
        rows, municipios_order, n_meses)

    old_total = sum(ap['panorama']['homic_mes']) + sum(ap['panorama']['tent_hom_mes'])
    new_total = sum(homic_mes) + sum(tent_mes)
    if new_total < old_total:
        report['analise_preditiva_homicidios'] = {
            'skipped': True, 'reason': 'total caiu (export mais estreito?)',
            'old_total': old_total, 'new_total': new_total}
        return

    ap['panorama']['homic_mes'] = homic_mes
    ap['panorama']['tent_hom_mes'] = tent_mes
    for m in ap['municipios']:
        key = m['nome'].upper()
        m['homic_mes'] = by_muni_homic.get(key, [0] * n_meses)
        m['tent_hom_mes'] = by_muni_tent.get(key, [0] * n_meses)

    # append-only por REDS novo em ocorrencias_graves — NUNCA sobrescrever o dict inteiro
    og = ap.setdefault('ocorrencias_graves', {})
    existentes = {o['r'] for lista in og.values() for o in lista}
    n_novas = 0
    for muni, lista in ocorrencias_novas.items():
        for o in lista:
            if o['r'] not in existentes:
                og.setdefault(muni, []).append(o)
                existentes.add(o['r'])
                n_novas += 1
    report['analise_preditiva_homicidios'] = {
        'old_total': old_total, 'new_total': new_total, 'ocorrencias_novas_em_ocorrencias_graves': n_novas}


def run_analise_preditiva_panorama(data, rows, report):
    """Campos gerais do panorama (total/prec/mp/armas/pris/vd) além de Homicídio/Tentativa,
    que tem função própria acima. Ligado em 2026-09-08 (pedido de Eduardo) -- build_panorama_geral
    já estava pronta e validada (ver docstring dela em aggregate_grave.py, auditoria de 2026-08-21,
    bate 100% jan-jul) mas nunca tinha sido chamada por main(); a ressalva antiga no topo deste
    módulo ("não automatizar sem confirmar com Eduardo") ficou desatualizada depois dessa validação."""
    ap = data['analise_preditiva']
    municipios_order = [m['nome'].upper() for m in ap['municipios']]
    n_meses = len(ap['panorama']['total_mes'])
    panorama_novo, by_muni = ag.build_panorama_geral(rows, municipios_order, n_meses)

    old_total = sum(ap['panorama']['total_mes'])
    new_total = sum(panorama_novo['total_mes'])
    if new_total < old_total * 0.98:
        report['analise_preditiva_panorama'] = {
            'skipped': True, 'reason': 'total caiu >2% (export mais estreito?)',
            'old_total': old_total, 'new_total': new_total}
        return

    for campo in ('total_mes', 'prec_mes', 'mp_mes', 'armas_mes', 'pris_mes', 'vd_mes'):
        ap['panorama'][campo] = panorama_novo[campo]
    for m in ap['municipios']:
        key = m['nome'].upper()
        dados_muni = by_muni.get(key, {})
        for campo in ('total_mes', 'prec_mes', 'mp_mes', 'armas_mes', 'pris_mes', 'vd_mes'):
            m[campo] = dados_muni.get(campo, [0] * n_meses)
    ap['periodo_dados'] = periodo_label(panorama_novo['total_mes'])
    report['analise_preditiva_panorama'] = {'old_total': old_total, 'new_total': new_total}


def run_itvd(data, rows, report):
    """Ligado em 2026-09-08 -- build_itvd já estava pronta e confirmada por Eduardo em
    2026-08-28 (mesmo comentário no topo da função em aggregate_grave.py), só nunca tinha
    sido chamada por main(); a lista "NÃO cobre ainda" no topo deste módulo estava
    desatualizada. Merge por célula (mesma política de overwrite direto do aggregate.py
    desde 2026-09-01), não é bloco de rebuild completo."""
    itvd = data['itvd']
    municipios_order = [m['nome'].upper() for m in itvd['municipios']]
    n_meses = len(itvd['municipios'][0]['trafico_mes'])
    trafico_mes, vit_mes, by_muni = ag.build_itvd(rows, municipios_order, n_meses)
    new_trafico = {k: v['trafico'] for k, v in by_muni.items()}
    new_vit = {k: v['vit'] for k, v in by_muni.items()}
    munis, ch1, dr1 = merge_cell_dict(itvd['municipios'], new_trafico, 'trafico_mes', 'trafico_acum')
    munis, ch2, dr2 = merge_cell_dict(munis, new_vit, 'vit_mes', 'vit_acum')
    itvd['municipios'] = munis
    recompute_totals(itvd, 'trafico_mes', 'trafico_acum', 'total_trafico_mes', 'total_trafico_acum')
    recompute_totals(itvd, 'vit_mes', 'vit_acum', 'total_vit_mes', 'total_vit_acum')
    report['itvd'] = {'changes_trafico': ch1, 'drops_trafico': dr1, 'changes_vit': ch2, 'drops_vit': dr2}


def run_violencia_domestica(data, rows, report):
    vd = data['violencia_domestica']
    n_meses = len(vd['panorama']['total_mes'])
    old_total = sum(vd['panorama']['total_mes'])
    novo = ag.build_violencia_domestica(rows, pop_by_muni_from_data(data), n_meses)
    new_total = sum(novo['panorama']['total_mes'])
    if new_total < old_total * 0.98:
        report['violencia_domestica'] = {
            'skipped': True, 'reason': 'total caiu >2% (export mais estreito?)',
            'old_total': old_total, 'new_total': new_total}
        return
    vd['panorama'] = novo['panorama']
    vd['municipios'] = novo['municipios']
    vd['ranking'] = novo['ranking']
    vd['ocorrencias'] = novo['ocorrencias']
    vd['enderecos_reincidentes'] = novo['enderecos_reincidentes']
    vd['periodo_dados'] = periodo_label(novo['panorama']['total_mes'])
    report['violencia_domestica'] = {'old_total': old_total, 'new_total': new_total}


def run_crimes_violentos(data, rows, report):
    cv = data['crimes_violentos']
    n_meses = len(cv['panorama']['total_mes'])
    old_total = sum(cv['panorama']['total_mes'])
    novo = ag.build_crimes_violentos(rows, pop_by_muni_from_data(data), n_meses)
    new_total = sum(novo['panorama']['total_mes'])
    if new_total < old_total * 0.98:
        report['crimes_violentos'] = {
            'skipped': True, 'reason': 'total caiu >2% (export mais estreito?)',
            'old_total': old_total, 'new_total': new_total}
        return
    cv['panorama'] = novo['panorama']
    cv['municipios'] = novo['municipios']
    cv['ranking'] = novo['ranking']
    cv['ocorrencias'] = novo['ocorrencias']
    cv['periodo_dados'] = periodo_label(novo['panorama']['total_mes'])
    report['crimes_violentos'] = {'old_total': old_total, 'new_total': new_total}


def run_reincidencia(data, rows, report):
    rc = data['reincidencia']
    old_total = rc['panorama']['total_enderecos']
    novo = ag.build_reincidencia(rows, pop_by_muni_from_data(data))
    new_total = novo['panorama']['total_enderecos']
    if new_total < old_total * 0.98:
        report['reincidencia'] = {
            'skipped': True, 'reason': 'total caiu >2% (export mais estreito?)',
            'old_total': old_total, 'new_total': new_total}
        return
    rc['panorama'] = novo['panorama']
    rc['municipios'] = novo['municipios']
    rc['ranking'] = novo['ranking']
    rc['enderecos'] = novo['enderecos']
    rc['periodo_dados'] = periodo_label_rows(rows) or rc.get('periodo_dados')
    report['reincidencia'] = {'old_total': old_total, 'new_total': new_total}

# ---------------------------------------------------------------------------------------------
# Detalhamento por natureza de MV/CVPE/CVPA (mv_detalhado, cvpe_detalhado, cvpa_detalhado).
# Até 2026-10-09 eram uma FOTO FIXA ("Acumulado - Janeiro a Agosto") que ninguém atualizava. Agora a
# rotina refaz tudo a cada rodada a partir dos mesmos exports MV/CVPE/CVPA (colunas por natureza:
# IMV_B01121, ICVPE_B01121_MILITAR, ICVPA_C01157...), e guarda também a série mensal por município
# (`por_mes`) pra a apresentação da GDO poder montar "Janeiro a <mês escolhido>".
# ---------------------------------------------------------------------------------------------
MESES_NOME = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro']
DETALHADOS = {
    'mv_detalhado': ('MV', 'IMV_TOTAL', [('homicidio', 'IMV_B01121'), ('roubo_fatal', 'IMV_C01157'), ('lesao', 'IMV_B01129'),
                                         ('femi', 'IMV_B01504'), ('sequestro', 'IMV_B01148'), ('tortura', 'IMV_B02001')]),
    'cvpe_detalhado': ('CVPE', 'ICVPE_TOTAL', [('civil', 'ICVPE_B01121'), ('militar', 'ICVPE_B01121_MILITAR'), ('tortura', 'ICVPE_B02001'),
                                               ('sequestro', 'ICVPE_B01148'), ('femi', 'ICVPE_B01504')]),
    'cvpa_detalhado': ('CVPA', 'ICVPA_TOTAL', [('roubo', 'ICVPA_C01157'), ('extorsao', 'ICVPA_C01158'), ('extorsao_seq', 'ICVPA_C01159')]),
}


def _norm_nome(s):
    import unicodedata
    s = unicodedata.normalize('NFD', s or '')
    return ''.join(c for c in s if unicodedata.category(c) != 'Mn').upper().strip()


def _num(v):
    try:
        return int(float(v or 0))
    except ValueError:
        return 0


def run_detalhados(data, rows_bo, report):
    meses_bo = [_num(r.get('MES_NUMERICO')) for r in (rows_bo or []) if (r.get('MES_NUMERICO') or '').strip().isdigit()]
    ult_mes = max(meses_bo) if meses_bo else None
    for chave, (pasta, col_total, colunas) in DETALHADOS.items():
        f = latest_csv(pasta)
        if not f or chave not in data:
            report[chave] = {'skipped': True, 'reason': f'sem export em entrada/{pasta}' if not f else 'bloco inexistente'}
            continue
        rows = read_csv(f, encoding='latin-1')
        if pasta == 'MV':
            aj.neutralizar_mv(rows, 'MV (detalhado)', report)  # mesma correção aprovada; só neutraliza, quem decide é o bloco MV
        bloco = data[chave]
        idx = {}
        for c in bloco['cias']:
            for m in c['municipios']:
                idx[_norm_nome(m['nome'])] = m
        por_mes = {n: {k: [0] * N_MESES for k, _ in colunas} for n in idx}
        outros_mes = {n: [0] * N_MESES for n in idx}
        fora, soma_total, soma_fora = [], 0, 0
        for r in rows:
            tot = _num(r.get(col_total))
            if tot <= 0:
                continue
            soma_total += tot
            nome = _norm_nome(r.get('MUNICIPIO'))
            mes = _num(r.get('MES_NUMERICO')) - 1
            if nome not in idx or not (0 <= mes < N_MESES):
                fora.append(nome or '?'); soma_fora += tot
                continue
            classif = 0
            for k, col in colunas:
                v = _num(r.get(col))
                por_mes[nome][k][mes] += v
                classif += v
            if tot > classif:  # entra no indicador mas não é uma das naturezas das colunas (ex.: furto com extorsão secundária)
                outros_mes[nome][mes] += tot - classif
        antes = dict(bloco.get('total', {}))
        total = {k: 0 for k, _ in colunas}
        total_outros = 0
        for n, m in idx.items():
            for k, _ in colunas:
                m[k] = sum(por_mes[n][k])
                total[k] += m[k]
            m['outros'] = sum(outros_mes[n])
            total_outros += m['outros']
            m['total'] = sum(m[k] for k, _ in colunas) + m['outros']
            m['por_mes'] = dict(por_mes[n], outros=outros_mes[n])
        total['outros'] = total_outros
        total['total'] = sum(total[k] for k, _ in colunas) + total_outros
        bloco['total'] = total
        if ult_mes:
            bloco['periodo'] = f'Acumulado - Janeiro a {MESES_NOME[ult_mes - 1]}'
        bloco['atualizado_em'] = datetime.date.today().isoformat()
        report[chave] = {'file': f, 'total_antes': antes.get('total'), 'total_depois': total['total'], 'soma_indicador': soma_total,
                         'fora_da_lista': sorted(set(fora)), 'outros': total_outros,
                         'confere': total['total'] + soma_fora == soma_total}



# ---- Local imediato / faixa horária / causa (MV, CVPE, CVPA, Furto Rural) ----
# Até 2026-10-13 essas listas eram um retrato antigo, parado (MV somava 19 com 22 mortes; CVPE 13 de 19; CVPA 31 de 40; Furto 77 de 101).
# Agora saem do export de cada indicador a cada rodada, contando pela coluna de total do próprio indicador (vítimas no CVPE/CVPA).
# Só categorias agregadas — nenhum REDS nem endereço. Logradouro do Furto Rural: os nomes de propriedade/proprietário que o SiGOp
# grava no campo (ex.: "FAZENDA ... PROP. <nome de pessoa>") são dado pessoal e NÃO vão pro arquivo público: só rodovias
# (BR/MG/LMG...) ficam com o nome; o resto vira "PROPRIEDADE / COMUNIDADE RURAL".
LOCAL_FAIXA = {
    'mv': ('MV', 'IMV_TOTAL', [('mv_local', 'DESCRICAO_LOCAL_IMEDIATO', None), ('mv_faixa', 'FAIXA_HORA_6', None), ('mv_causa', 'CAUSA_PRESUMIDA', None), ('mv_meio', 'DESCRICAO_MEIO_UTILIZADO', None)]),
    'cvpe': ('CVPE', 'ICVPE_TOTAL', [('cvpe_local', 'DESCRICAO_LOCAL_IMEDIATO', None), ('cvpe_faixa', 'FAIXA_HORA_6', None), ('cvpe_causa', 'CAUSA_PRESUMIDA', None), ('cvpe_meio', 'DESCRICAO_MEIO_UTILIZADO', None)]),
    'cvpa': ('CVPA', 'ICVPA_TOTAL', [('cvpa_local', 'DESCRICAO_LOCAL_IMEDIATO', None), ('cvpa_faixa', 'FAIXA_HORA_6', None), ('cvpa_causa', 'CAUSA_PRESUMIDA', None), ('cvpa_meio', 'DESCRICAO_MEIO_UTILIZADO', None)]),
    'furto': ('FURTO RURAL', 'IFZR', [('furto_causa', 'CAUSA_PRESUMIDA', None), ('furto_logradouro', 'LOGRADOURO', 10)]),
}
_RODOVIA = re.compile(r'^(BR|MG|LMG|AMG|CMG|MGC)[\s-]?\d+')


def _rotulo_local(chave_dado, bruto):
    r = (bruto or '').strip()
    if chave_dado == 'furto_logradouro':
        up = r.upper()
        if not r or up.startswith('INV') or len(up) <= 2:
            return 'NAO INFORMADO'
        return r if _RODOVIA.match(up) else 'PROPRIEDADE / COMUNIDADE RURAL'
    return r or 'NAO INFORMADO'


def run_local_faixa(data, report):
    for chave, (pasta, col_total, saidas) in LOCAL_FAIXA.items():
        f = latest_csv(pasta)
        if not f:
            report['local_faixa_' + chave] = {'skipped': True, 'reason': f'sem export em entrada/{pasta}'}
            continue
        rows = read_csv(f, encoding='latin-1')
        if pasta == 'MV':
            aj.neutralizar_mv(rows, 'MV (local/faixa)', report)
        validas = [r for r in rows if _num(r.get(col_total)) > 0]
        soma = sum(_num(r.get(col_total)) for r in validas)
        res = {'file': f, 'soma_indicador': soma, 'saidas': {}}
        if chave in ('mv', 'cvpe', 'cvpa') and chave in data:
            # MV/CVPE/CVPA contam VÍTIMAS (uma ocorrência pode ter mais de uma): guarda também quantas ocorrências (REDS) e quantas
            # com autor preso, por mês — só números, nenhum REDS (página: 'N vítimas em M ocorrências', 'autor preso em X de M')
            reds_m = [set() for _ in range(N_MESES)]; pris_m = [set() for _ in range(N_MESES)]
            for r in validas:
                mi = _num(r.get('MES_NUMERICO')) - 1
                reds = (r.get('NUMERO_REDS') or '').strip()
                if 0 <= mi < N_MESES and reds:
                    reds_m[mi].add(reds)
                    if _num(r.get('QTDE_PRISAO')) > 0:
                        pris_m[mi].add(reds)
            # tentado x consumado (em vítimas) e quantas ocorrências têm 1, 2 ou 3+ vítimas — agregado, sem REDS
            tc = {'tentado': 0, 'consumado': 0}; vpo = {'1': 0, '2': 0, '3+': 0}; vistos_v = set()
            for r in validas:
                tot = _num(r.get(col_total)); reds = (r.get('NUMERO_REDS') or '').strip()
                tc['tentado' if (r.get('TENTADO_CONSUMADO_PRINCIPAL') or '').strip().upper() == 'TENTADO' else 'consumado'] += tot
                if reds and reds not in vistos_v:
                    vistos_v.add(reds); vpo['1' if tot <= 1 else ('2' if tot == 2 else '3+')] += 1
            data[chave]['tentado_consumado'] = tc
            data[chave]['vitimas_por_ocorrencia'] = vpo
            data[chave]['reds_mes'] = [len(x) for x in reds_m]
            data[chave]['reds_prisao_mes'] = [len(x) for x in pris_m]
            res['reds'] = sum(data[chave]['reds_mes']); res['reds_com_prisao'] = sum(data[chave]['reds_prisao_mes'])
        for dkey, col, limite in saidas:
            cont = collections.Counter()
            for r in validas:
                cont[_rotulo_local(dkey, r.get(col))] += _num(r.get(col_total))
            lista = sorted(cont.items(), key=lambda kv: (-kv[1], kv[0]))
            if limite:
                lista = lista[:limite]
            confere = limite is not None or sum(v for _, v in lista) == soma
            criavel = dkey.endswith('_causa') or dkey.endswith('_meio')
            if not confere or (dkey not in data and not criavel):
                res['saidas'][dkey] = {'skipped': True, 'reason': 'soma não confere com o total do indicador' if not confere else 'bloco inexistente'}
                continue
            antes = sum(x[1] for x in data.get(dkey, []))
            data[dkey] = [[k, v] for k, v in lista]
            res['saidas'][dkey] = {'total_antes': antes, 'total_depois': sum(v for _, v in lista), 'categorias': len(lista)}
        report['local_faixa_' + chave] = res



# ---- Ocorrências de MV (RESTRITO: REDS, data/hora, endereço) ----
# Alimenta a seção "Ocorrências de MV" da página de Mortes Violentas, só para PPVD aprovado. Vai em data['crimes_violentos']['mv_ocorrencias']
# (chave restrita: sai do data.json público e vai pro Supabase junto do bloco crimes_violentos).
def _lista_ocorrencias(data, report, pasta, col_total, chave_dado, chave_rep, col_pm=None, extras=None):
    f = latest_csv(pasta)
    if not f or 'crimes_violentos' not in data:
        report[chave_rep] = {'skipped': True, 'reason': f'sem export em entrada/{pasta}' if not f else 'bloco crimes_violentos inexistente'}
        return
    rows = read_csv(f, encoding='latin-1')
    if pasta == 'MV':
        aj.neutralizar_mv(rows, 'MV (ocorrências)', report)
    saida, vistos = {}, set()
    for r in rows:
        vit = _num(r.get(col_total))
        if vit <= 0:
            continue
        reds = (r.get('NUMERO_REDS') or '').strip()
        if not reds or reds in vistos:
            continue
        vistos.add(reds)
        mes = _num(r.get('MES_NUMERICO'))
        if not (1 <= mes <= N_MESES):
            continue
        nat = (r.get('DESCR_NATUREZA_PRINCIPAL') or '').strip().title()
        if (r.get('TENTADO_CONSUMADO_PRINCIPAL') or '').strip().upper() == 'TENTADO':
            nat = 'Tentativa de ' + nat
        meio = (r.get('DESCRICAO_MEIO_UTILIZADO') or '').strip()
        arma = _num(r.get('QTDE_ARMAS_FOGO')) > 0 or 'ARMA' in meio.upper() and 'FOGO' in meio.upper()
        item = {
            'r': reds, 'd': (r.get('DATA_FATO') or '').strip(), 'h': (r.get('HORARIO_FATO') or '').strip()[:5], 'm': mes, 'n': nat,
            'c': (r.get('CAUSA_PRESUMIDA') or '').strip(), 'meio': meio, 'loc': (r.get('DESCRICAO_LOCAL_IMEDIATO') or '').strip(),
            'b': (r.get('BAIRRO') or '').strip() or (r.get('BAIRRO_NAO_CADASTRADO') or '').strip(),
            'l': (r.get('LOGRADOURO') or '').strip() or (r.get('LOGRADOURO_NAO_CADASTRADO') or '').strip(),
            'nu': (r.get('NUMERO_LOGRADOURO') or '').strip() or (r.get('NUMERO_LOGRADOURO_NAO_CADASTRADO') or '').strip() or '0',
            'a': bool(arma), 'p': _num(r.get('QTDE_PRISAO')) > 0,
        }
        if col_pm:
            item['v'] = int(vit)
            item['pm'] = _num(r.get(col_pm)) > 0
        if extras:
            item.update(extras(r, vit))
        saida.setdefault((r.get('MUNICIPIO') or '').strip().upper(), []).append(item)
    total = sum(len(v) for v in saida.values())
    antes = sum(len(v) for v in (data['crimes_violentos'].get(chave_dado) or {}).values())
    data['crimes_violentos'][chave_dado] = saida
    chave_ind = {'MV': 'mv', 'CVPE': 'cvpe', 'CVPA': 'cvpa'}[pasta]
    esperado = sum(data[chave_ind]['reds_mes']) if 'reds_mes' in data.get(chave_ind, {}) else sum(data[chave_ind]['total_mes'])
    report[chave_rep] = {'file': f, 'antes': antes, 'depois': total, 'esperado': esperado, 'confere': total == esperado}


# ---- Ocorrências de MV e de CVPE (RESTRITO: REDS, data/hora, endereço) ----
# Alimentam as seções "Ocorrências de MV/CVPE" das páginas de Mortes Violentas e CVPE, só para PPVD aprovado. Ficam dentro do bloco restrito
# 'crimes_violentos' (a função do Supabase só aceita 4 chaves fixas) e saem do data.json público.
def run_mv_ocorrencias(data, report):
    _lista_ocorrencias(data, report, 'MV', 'IMV_TOTAL', 'mv_ocorrencias', 'mv_ocorrencias')


def run_cvpe_ocorrencias(data, report):
    _lista_ocorrencias(data, report, 'CVPE', 'ICVPE_TOTAL', 'cvpe_ocorrencias', 'cvpe_ocorrencias', col_pm='ICVPE_B01121_MILITAR')



# ---- Dia da semana x faixa horária, rodovias e (CVPA) alvo do roubo — MV, CVPE, CVPA ----
# Só agregados públicos (nenhum REDS nem endereço de casa: "rodovia" guarda só o nome da via, ex. "BR 116").
DIAS_SEMANA = [('SEG', 'Segunda'), ('TER', 'Terça'), ('QUA', 'Quarta'), ('QUI', 'Quinta'), ('SEX', 'Sexta'), ('SAB', 'Sábado'), ('DOM', 'Domingo')]
FAIXAS_6H = ['00h–06h', '06h–12h', '12h–18h', '18h–24h']


ALVOS_VEICULO_CARGA = ('CARGAS', 'VEICULO OU EMBARCACAO')  # alvo do roubo (CVPa) ligado ao Plano Motocicletas/Roubo de Carga (Memorando 012)


def run_extras_indicadores(data, report):
    for chave in ('mv', 'cvpe', 'cvpa'):
        pasta, col_total, _saidas = LOCAL_FAIXA[chave]
        f = latest_csv(pasta)
        if not f:
            report['extras_' + chave] = {'skipped': True, 'reason': f'sem export em entrada/{pasta}'}
            continue
        rows = read_csv(f, encoding='latin-1')
        if pasta == 'MV':
            aj.neutralizar_mv(rows, 'MV (extras)', report)
        validas = [r for r in rows if _num(r.get(col_total)) > 0]
        soma = sum(_num(r.get(col_total)) for r in validas)
        matriz = [[0] * 4 for _ in range(7)]
        rodov, alvo = collections.Counter(), collections.Counter()
        bairro_inv, alvo_mun = set(), {}
        veic_m = [[0] * 4 for _ in range(7)]  # CVPa: roubo de veículo e de carga (alvo), dia x faixa
        for r in validas:
            tot = _num(r.get(col_total))
            reds_b = (r.get('NUMERO_REDS') or '').strip(); bai = (r.get('BAIRRO') or '').strip().upper()
            if reds_b and (not bai or bai.startswith('INV')):
                bairro_inv.add(reds_b)  # bairro 'INVÁLIDO' no cadastro do SiGOp
            pref = (r.get('DIA_DA_SEMANA_FATO') or '').strip().upper()[:3]
            i_d = next((i for i, (pf, _) in enumerate(DIAS_SEMANA) if pf == pref), None)
            m = re.search(r'(\d\d):', r.get('FAIXA_HORA_6') or '')
            i_f = int(m.group(1)) // 6 if m else None
            if i_d is not None and i_f is not None and i_f < 4:
                matriz[i_d][i_f] += tot
            if (r.get('TIPO_LOGRADOURO') or '').strip().upper() == 'RODOVIA':
                via = re.sub(r'[\s-]+', ' ', (r.get('LOGRADOURO') or '').strip().upper())  # "BR-251" e "BR 251" são a mesma via
                rodov['NAO INFORMADO' if not via or via.startswith('INV') else via] += tot
            if chave == 'cvpa':
                rot = (r.get('COMPLEMENTO_NATUREZA') or '').strip() or 'NAO INFORMADO'
                rot2 = re.sub(r'^BENS/VALORES( DE)? ', '', rot.split(' (')[0])  # o SiGOp escreve a mesma categoria com e sem "BENS/VALORES DE"
                alvo[rot2] += tot
                alvo_mun.setdefault((r.get('MUNICIPIO') or '').strip().upper(), collections.Counter())[rot2] += tot
                if rot2 in ALVOS_VEICULO_CARGA and i_d is not None and i_f is not None and i_f < 4:
                    veic_m[i_d][i_f] += tot
        res = {'file': f, 'soma_indicador': soma, 'em_rodovia': sum(rodov.values())}
        if sum(sum(l) for l in matriz) == soma:
            data[chave + '_dia_faixa'] = {'dias': [n for _, n in DIAS_SEMANA], 'faixas': FAIXAS_6H, 'matriz': matriz}
            res['dia_faixa'] = 'ok'
        else:
            res['dia_faixa'] = f'não confere ({sum(sum(l) for l in matriz)} de {soma}) — mantido o anterior'
        data[chave + '_rodovia'] = [[k, v] for k, v in sorted(rodov.items(), key=lambda kv: (-kv[1], kv[0]))]
        data[chave]['reds_bairro_invalido'] = len(bairro_inv)
        res['bairro_invalido'] = len(bairro_inv)
        if chave == 'cvpa':
            ordenado = sorted(alvo.items(), key=lambda kv: (-kv[1], kv[0]))
            if sum(v for _, v in ordenado) == soma:
                data['cvpa_alvo'] = [[k, v] for k, v in ordenado]
                data['cvpa_alvo_municipio'] = {m: [[k, v] for k, v in sorted(c.items(), key=lambda kv: (-kv[1], kv[0]))] for m, c in alvo_mun.items()}
                res['alvo'] = 'ok'
                esp_v = sum(v for k, v in ordenado if k in ALVOS_VEICULO_CARGA)
                if sum(sum(l) for l in veic_m) == esp_v:
                    data['cvpa_veiculo_dia_faixa'] = {'dias': [n for _, n in DIAS_SEMANA], 'faixas': FAIXAS_6H, 'matriz': veic_m}
                    res['veiculo_dia_faixa'] = 'ok'
            else:
                res['alvo'] = 'não confere'
        report['extras_' + chave] = res

# ---- Operações (POG e PPAG): natureza, bairro, dia × faixa horária, esforço (duração/efetivo/viaturas) e qualidade do dado ----
# Tudo calculado do export 'POG E PPAG' a cada rodada (antes, bairro e natureza do POG eram um retrato antigo: 336 e 446 de 4.353 operações).
# PÚBLICO e só agregado: efetivo e viaturas são apenas CONTADOS (nomes, matrículas e prefixos nunca saem daqui), nenhum RAT/endereço.
POG_CODIGOS = {'Y04009', 'Y07001', 'Y07002', 'Y07003', 'Y07010', 'Y10001'}
PPAG_CODIGOS = {'y15001': ('Y15001',), 'y07012': ('Y07012',), 'y07014': ('Y07014', 'Y15010')}  # Zona Rural = Y07014 + Y15010 juntos (Eduardo, 2026-10-19)
DURACAO_MAX_MIN = 24 * 60  # acima de 24h é erro de preenchimento (há RAT com 62 dias): fora das médias, mas contado


def _contar_itens(txt):
    return len([x for x in (txt or '').split('|') if x.strip()])


def _top_com_outros(contador, limite):
    lista = sorted(contador.items(), key=lambda kv: (-kv[1], kv[0]))
    if len(lista) <= limite:
        return [[k, v] for k, v in lista]
    resto = sum(v for _, v in lista[limite:])
    return [[k, v] for k, v in lista[:limite]] + [['OUTROS BAIRROS', resto]]


def _agg_operacoes(rows, com_natureza, completo=False):
    nat, bai = collections.Counter(), collections.Counter()
    bai_mun, por_mun = {}, {}
    matriz = [[0] * 4 for _ in range(7)]
    sem_bairro_mun = collections.Counter()
    susp = sem_ef = sem_dur = 0
    for r in rows:
        mun = (r.get('MUNICIPIO') or '').strip().upper()
        b = (r.get('BAIRRO') or '').strip().upper()
        if not b or b.startswith('INV'):
            b = '(sem bairro)'
            sem_bairro_mun[mun] += 1
        bai[b] += 1
        bai_mun.setdefault(mun, collections.Counter())[b] += 1
        if com_natureza:
            nat[(r.get('DESCR_NATUREZA_PRINCIPAL') or '').strip() or 'NAO INFORMADO'] += 1
        pref = (r.get('DIA_DA_SEMANA_FATO') or '').strip().upper()[:3]
        i_d = next((i for i, (pf, _) in enumerate(DIAS_SEMANA) if pf == pref), None)
        m = re.search(r'(\d\d):', r.get('FAIXA_HORA_6') or '')
        i_f = int(m.group(1)) // 6 if m else None
        if i_d is not None and i_f is not None and i_f < 4:
            matriz[i_d][i_f] += 1
        mins, ef, vt = _num(r.get('OPR_TEMPO_TOTAL_MINUTOS')), _contar_itens(r.get('EFETIVOS')), _contar_itens(r.get('VIATURAS'))
        e = por_mun.setdefault(mun, {'ops': 0, 'dur': [], 'ef': [], 'vt': [], 'hp': 0.0})
        e['ops'] += 1
        if mins <= 0:
            sem_dur += 1
        elif mins > DURACAO_MAX_MIN:
            susp += 1
        else:
            e['dur'].append(mins)
            if ef > 0:
                e['hp'] += mins * ef / 60.0
        if ef > 0:
            e['ef'].append(ef)
        else:
            sem_ef += 1
        if vt > 0:
            e['vt'].append(vt)
    media = lambda xs: (sum(xs) / len(xs)) if xs else None
    esforco = []
    for mun in sorted(por_mun):
        e = por_mun[mun]
        esforco.append({'nome': mun, 'ops': e['ops'], 'dur_media_min': None if not e['dur'] else round(media(e['dur']), 1),
                        'dur_mediana_min': None if not e['dur'] else round(sorted(e['dur'])[len(e['dur']) // 2], 1),
                        'efetivo_medio': None if not e['ef'] else round(media(e['ef']), 2),
                        'vtr_media': None if not e['vt'] else round(media(e['vt']), 2), 'horas_policial': round(e['hp'], 1)})
    dur_tot = [x for e in por_mun.values() for x in e['dur']]
    ef_tot = [x for e in por_mun.values() for x in e['ef']]
    vt_tot = [x for e in por_mun.values() for x in e['vt']]
    total = {'ops': len(rows), 'dur_media_min': None if not dur_tot else round(media(dur_tot), 1),
             'dur_mediana_min': None if not dur_tot else round(sorted(dur_tot)[len(dur_tot) // 2], 1),
             'efetivo_medio': None if not ef_tot else round(media(ef_tot), 2), 'vtr_media': None if not vt_tot else round(media(vt_tot), 2),
             'horas_policial': round(sum(e['hp'] for e in por_mun.values()), 1)}
    res = {
        'total': len(rows),
        'bairro': _top_com_outros(bai, 15),
        'bairro_municipio': {m: _top_com_outros(c, 8) for m, c in bai_mun.items()},
        'dia_faixa': {'dias': [n for _, n in DIAS_SEMANA], 'faixas': FAIXAS_6H, 'matriz': matriz},
        'esforco': {'municipios': esforco, 'total': total, 'duracao_suspeita': susp, 'sem_duracao': sem_dur, 'sem_efetivo': sem_ef},
        'qualidade': {'sem_bairro': bai.get('(sem bairro)', 0), 'por_municipio': dict(sem_bairro_mun)},
    }
    if com_natureza or completo:
        # lista COMPLETA município × bairro (só contagem de operações): base do cruzamento com os crimes violentos (a parte que mostra bairro de crime é restrita, no painel)
        res['bairro_completo'] = {m: dict(sorted(c.items(), key=lambda kv: (-kv[1], kv[0]))) for m, c in sorted(bai_mun.items())}
    if com_natureza:
        res['natureza'] = [[k, v] for k, v in sorted(nat.items(), key=lambda kv: (-kv[1], kv[0]))]
    return res


def run_operacoes_detalhe(data, report):
    f = latest_csv('POG E PPAG')
    if not f:
        report['operacoes_detalhe'] = {'skipped': True, 'reason': 'sem export em entrada/POG E PPAG'}
        return
    rows = read_csv(f, encoding='utf-8')
    res = {'file': f}

    def valido(r):
        try:
            return 1 <= int(r.get('MES_NUMERICO') or 0) <= N_MESES
        except Exception:
            return False
    pog = [r for r in rows if (r.get('CODIGO_NATUREZA_PRINCIPAL') or '').strip() in POG_CODIGOS and valido(r)]
    esperado = data['pog']['total_acum'][-1] if data.get('pog', {}).get('total_acum') else None
    if esperado == len(pog):
        det = _agg_operacoes(pog, True)
        data['pog_detalhe'] = det
        data['pog_bairros'] = det['bairro']      # chaves antigas (retrato) passam a refletir o ano todo
        data['pog_natureza'] = det['natureza']
        res['pog'] = {'ops': len(pog), 'sem_bairro': det['qualidade']['sem_bairro'], 'duracao_suspeita': det['esforco']['duracao_suspeita'], 'sem_efetivo': det['esforco']['sem_efetivo']}
    else:
        res['pog'] = f'não confere ({len(pog)} no export x {esperado} no indicador) — mantido o anterior'
    ppag = {}
    for chave, cod in PPAG_CODIGOS.items():
        sub = [r for r in rows if (r.get('CODIGO_NATUREZA_PRINCIPAL') or '').strip() in cod and valido(r)]
        esp = data['ppag'][chave]['total_acum'][-1] if data.get('ppag', {}).get(chave, {}).get('total_acum') else None
        if esp == len(sub):
            ppag[chave] = _agg_operacoes(sub, False)
            res['ppag_' + chave] = {'ops': len(sub), 'sem_bairro': ppag[chave]['qualidade']['sem_bairro']}
        else:
            res['ppag_' + chave] = f'não confere ({len(sub)} no export x {esp} no indicador) — mantido o anterior'
    if len(ppag) == len(PPAG_CODIGOS):
        data['ppag_detalhe'] = ppag
    report['operacoes_detalhe'] = res


# ---- IDOB / Operação Boemia: mesmo detalhamento do POG + local (bar x fora), qualidade da localização e REGULARIDADE por fim de semana ----
# Regularidade (informativa, não entra na nota): a meta mensal de Boemia é sempre cumprida (23/mês contra ~230 feitas); aqui se vê se cada cidade
# operou em TODO fim de semana (sexta a domingo, só os já encerrados). Tudo agregado: contagem por cidade e fim de semana, nada pessoal.
def _fins_de_semana(rows, municipios):
    datas = []
    for r in rows:
        try:
            datas.append(datetime.datetime.strptime((r.get('DATA_FATO') or '').strip(), '%d/%m/%Y').date())
        except ValueError:
            continue
    if not datas:
        return None
    ref = max(datas)
    d0 = datetime.date(datetime.date.today().year, 1, 1)
    sextas = []
    d = d0 + datetime.timedelta(days=(4 - d0.weekday()) % 7)
    while d + datetime.timedelta(days=2) <= ref:
        sextas.append(d)
        d += datetime.timedelta(days=7)
    por = {m: [0] * len(sextas) for m in municipios}
    for r in rows:
        try:
            dt = datetime.datetime.strptime((r.get('DATA_FATO') or '').strip(), '%d/%m/%Y').date()
        except ValueError:
            continue
        mun = (r.get('MUNICIPIO') or '').strip().upper()
        if mun not in por:
            continue
        for i, f in enumerate(sextas):
            if 0 <= (dt - f).days <= 2:
                por[mun][i] += 1
                break
    return {'rotulos': [f.strftime('%d/%m') for f in sextas], 'municipios': por, 'ate': ref.strftime('%d/%m/%Y')}


def run_idob_detalhe(data, report):
    f = latest_csv('IDOB')
    if not f or 'idob' not in data:
        report['idob_detalhe'] = {'skipped': True, 'reason': 'sem export em entrada/IDOB'}
        return
    try:
        rows = read_csv(f, encoding='utf-8')
    except UnicodeDecodeError:
        report['idob_detalhe'] = {'skipped': True, 'reason': 'arquivo não é UTF-8 (export do tipo errado)'}
        return
    if not rows or 'NOME_OPERACAO' not in rows[0]:
        report['idob_detalhe'] = {'skipped': True, 'reason': 'arquivo sem a coluna NOME_OPERACAO'}
        return

    def valido(r):
        try:
            return 'BOEMIA' in (r.get('NOME_OPERACAO') or '').upper() and 1 <= int(r.get('MES_NUMERICO') or 0) <= N_MESES
        except Exception:
            return False
    boemia = [r for r in rows if valido(r)]
    esperado = data['idob']['total_qtdeop_acum'][-1] if data['idob'].get('total_qtdeop_acum') else None
    if esperado != len(boemia):
        report['idob_detalhe'] = {'skipped': True, 'reason': f'não confere ({len(boemia)} no export x {esperado} no indicador) — mantido o anterior'}
        return
    det = _agg_operacoes(boemia, False, completo=True)
    bar_locais = {'BAR / LANCHONETE / RESTAURANTE / SIMILAR', 'BOATE / CASA DE SHOW / SIMILAR'}
    loc = collections.Counter((r.get('LOCAL_IMEDIATO') or '').strip() or 'NAO INFORMADO' for r in boemia)
    em_bar = sum(v for k, v in loc.items() if k in bar_locais)
    det['local'] = {'em_bar': em_bar, 'fora_bar': len(boemia) - em_bar, 'lista': _top_com_outros_rot(loc, 6)}
    det['qualidade']['localizacao_erro'] = sum(1 for r in boemia if 'ERRO' in (r.get('DESCRICAO_LOCALIZACAO') or '').upper())
    det['qualidade']['zona_rural'] = sum(1 for r in boemia if 'RURAL' in (r.get('DESCRICAO_LOCALIZACAO') or '').upper())
    nomes = [m['nome'].upper() for m in data['idob']['municipios']]
    fs = _fins_de_semana(boemia, nomes)
    if fs:
        det['fins_de_semana'] = fs
    data['idob_detalhe'] = det
    report['idob_detalhe'] = {'file': f, 'ops': len(boemia), 'em_bar': em_bar, 'sem_bairro': det['qualidade']['sem_bairro'], 'fins_de_semana': len(fs['rotulos']) if fs else 0}


def _top_com_outros_rot(contador, limite):
    lista = sorted(contador.items(), key=lambda kv: (-kv[1], kv[0]))
    if len(lista) <= limite:
        return [[k, v] for k, v in lista]
    return [[k, v] for k, v in lista[:limite]] + [['OUTROS LOCAIS', sum(v for _, v in lista[limite:])]]


# ---- IDOB onda 3: operações Boemia x vítimas em bar/boate ----
# PÚBLICO (`idob_dia_faixa`): dia da semana x faixa de 6h das vítimas em bar/boate (as que derrubam o IDOB), só números.
# RESTRITO (`crimes_violentos.idob_ocorrencias`, só PPVD aprovado): cada ocorrência em bar/boate com REDS/data/bairro e quanta Boemia houve ao redor
# (no dia, nos 7 dias antes, última antes, no bairro). Os RATs de Boemia só entram como contagem/data — nunca nome de policial.
def _sem_acento_up(t):
    import unicodedata
    return ''.join(c for c in unicodedata.normalize('NFD', (t or '')) if unicodedata.category(c) != 'Mn').upper().strip()


def run_idob_cruzamento(data, rows_bo, report):
    f = latest_csv('IDOB')
    if not f or 'idob' not in data:
        report['idob_cruzamento'] = {'skipped': True, 'reason': 'sem export em entrada/IDOB'}
        return
    ops_rows = read_csv(f, encoding='utf-8')
    if not ops_rows or 'NOME_OPERACAO' not in ops_rows[0]:
        report['idob_cruzamento'] = {'skipped': True, 'reason': 'export de IDOB sem NOME_OPERACAO'}
        return
    bar = ag.BAR_LOCAIS
    matriz = [[0] * 4 for _ in range(7)]
    eventos = {}
    for r in rows_bo:
        if (r.get('DESCRICAO_LOCAL_IMEDIATO') or '').strip() not in bar:
            continue
        mv, pe, pa = _num(r.get('IMV_TOTAL')), _num(r.get('ICVPE_TOTAL')), _num(r.get('ICVPA_TOTAL'))
        tot = mv + pe + pa
        if tot <= 0:
            continue
        pref = (r.get('DIA_DA_SEMANA_FATO') or '').strip().upper()[:3]
        i_d = next((i for i, (pf, _) in enumerate(DIAS_SEMANA) if pf == pref), None)
        m = re.search(r'(\d\d):', r.get('FAIXA_HORA_6') or '')
        i_f = int(m.group(1)) // 6 if m else None
        if i_d is not None and i_f is not None and i_f < 4:
            matriz[i_d][i_f] += tot
        eventos[(r.get('NUMERO_REDS') or '').strip()] = (r, mv, pe, pa)
    esperado = sum(data['idob'].get(k, [0])[-1] for k in ('total_mv_acum', 'total_cvpe_acum', 'total_cvpa_acum'))
    soma = sum(sum(l) for l in matriz)
    res = {'file': f, 'vitimas_em_bar': soma, 'esperado': esperado}
    if soma == esperado:
        data['idob_dia_faixa'] = {'dias': [n for _, n in DIAS_SEMANA], 'faixas': FAIXAS_6H, 'matriz': matriz}
        res['dia_faixa'] = 'ok'
    else:
        res['dia_faixa'] = f'não confere ({soma} x {esperado}) — mantido o anterior'
    # Boemia por cidade/data e por bairro
    def dia(t):
        try:
            return datetime.datetime.strptime((t or '').strip(), '%d/%m/%Y').date()
        except ValueError:
            return None
    por_cid, por_bairro = collections.defaultdict(list), collections.defaultdict(list)
    for r in ops_rows:
        if 'BOEMIA' not in (r.get('NOME_OPERACAO') or '').upper():
            continue
        d = dia(r.get('DATA_FATO'))
        if not d:
            continue
        cid = (r.get('MUNICIPIO') or '').strip().upper()
        por_cid[cid].append(d)
        b = _sem_acento_up(r.get('BAIRRO'))
        if b and not b.startswith('INV'):
            por_bairro[(cid, b)].append(d)
    # natureza/causa/meio vêm das listas restritas já montadas (MV/CVPE/CVPA), pelo nº do REDS
    info = {}
    for k in ('mv', 'cvpe', 'cvpa'):
        for cid, lst in (data.get('crimes_violentos', {}).get(k + '_ocorrencias') or {}).items():
            for o in lst:
                if o.get('r') and o['r'] not in info:
                    info[o['r']] = o
    saida = {}
    for reds, (r, mv, pe, pa) in eventos.items():
        d = dia(r.get('DATA_FATO'))
        cid = (r.get('MUNICIPIO') or '').strip().upper()
        if not d:
            continue
        ds = por_cid.get(cid, [])
        antes = [x for x in ds if x < d]
        b = _sem_acento_up(r.get('BAIRRO'))
        db = por_bairro.get((cid, b), []) if b and not b.startswith('INV') else None
        o = info.get(reds, {})
        saida.setdefault(cid, []).append({
            'r': reds, 'd': d.strftime('%d/%m/%Y'), 'h': (r.get('HORARIO_FATO') or '')[:5], 'b': (r.get('BAIRRO') or '').strip(),
            'n': o.get('n'), 'c': o.get('c'), 'meio': o.get('meio'), 'mv': mv, 'cvpe': pe, 'cvpa': pa,
            'ops_dia': sum(1 for x in ds if x == d), 'ops_7d': sum(1 for x in ds if 0 < (d - x).days <= 7),
            'ultima': max(antes).strftime('%d/%m/%Y') if antes else None, 'dias_ultima': (d - max(antes)).days if antes else None,
            'ops_bairro_30d': None if db is None else sum(1 for x in db if 0 < (d - x).days <= 30),
            'ops_bairro_ano': None if db is None else len(db),
            'ops_cidade_ano': len(ds),
        })
    for lst in saida.values():
        lst.sort(key=lambda x: x['d'].split('/')[::-1])
    data.setdefault('crimes_violentos', {})['idob_ocorrencias'] = saida
    res['ocorrencias'] = sum(len(v) for v in saida.values())
    report['idob_cruzamento'] = res


# ---- Cavalo de Aço: detalhamento do conjunto oficial (esforço, dia × faixa, bairro, local, qualidade) + regularidade SEMANAL ----
# Regularidade (informativa): a meta de verdade é semanal (mínimo 1 por destacamento, 2 por pelotão, 4 por sede de companhia); a meta mensal
# do painel é sempre cumprida. Semana = segunda a domingo, só as já encerradas. Só contagem por cidade e semana, nada pessoal.
def _semanas(rows, municipios, ref=None):
    datas = []
    for r in rows:
        try:
            datas.append(datetime.datetime.strptime((r.get('DATA_FATO') or '').strip(), '%d/%m/%Y').date())
        except ValueError:
            continue
    if not datas:
        return None
    ref = ref or max(datas)
    d0 = datetime.date(datetime.date.today().year, 1, 1)
    seg = d0 - datetime.timedelta(days=d0.weekday())
    segundas = []
    while seg + datetime.timedelta(days=6) <= ref:
        segundas.append(seg)
        seg += datetime.timedelta(days=7)
    por = {m: [0] * len(segundas) for m in municipios}
    for r in rows:
        try:
            dt = datetime.datetime.strptime((r.get('DATA_FATO') or '').strip(), '%d/%m/%Y').date()
        except ValueError:
            continue
        mun = (r.get('MUNICIPIO') or '').strip().upper()
        if mun not in por or not segundas:
            continue
        i = (dt - segundas[0]).days // 7
        if 0 <= i < len(segundas):
            por[mun][i] += 1
    return {'rotulos': [s.strftime('%d/%m') for s in segundas], 'municipios': por, 'ate': ref.strftime('%d/%m/%Y')}


def run_cavalo_detalhe(data, report):
    f = latest_csv('Cavalo de aço')
    if not f or 'cavaloaco' not in data:
        report['cavalo_detalhe'] = {'skipped': True, 'reason': 'sem export em entrada/Cavalo de aço'}
        return
    try:
        rows = read_csv(f, encoding='utf-8')
    except UnicodeDecodeError:
        report['cavalo_detalhe'] = {'skipped': True, 'reason': 'arquivo não é UTF-8 (export do tipo errado)'}
        return
    if not rows or 'PRODUTIVIDADE' not in rows[0]:
        report['cavalo_detalhe'] = {'skipped': True, 'reason': 'arquivo sem as colunas do RAT'}
        return
    sel = [r for r in rows if 'Y01003' in (r.get('CODIGO_NATUREZA_PRINCIPAL') or '') and '70 BPM' in (r.get('UNID_AREA_NIVEL_5') or '70 BPM')]
    esperado = data['cavaloaco']['total_acum'][-1] if data['cavaloaco'].get('total_acum') else None
    if esperado != len(sel):
        report['cavalo_detalhe'] = {'skipped': True, 'reason': f'não confere ({len(sel)} no export x {esperado} na meta) — mantido o anterior'}
        return
    det = _agg_operacoes(sel, False, completo=True)
    loc = collections.Counter((r.get('LOCAL_IMEDIATO') or '').strip() or 'NAO INFORMADO' for r in sel)
    det['local'] = {'lista': _top_com_outros_rot(loc, 6)}
    det['qualidade']['localizacao_erro'] = sum(1 for r in sel if 'ERRO' in (r.get('DESCRICAO_LOCALIZACAO') or '').upper())
    det['qualidade']['zona_rural'] = sum(1 for r in sel if 'RURAL' in (r.get('DESCRICAO_LOCALIZACAO') or '').upper())
    nomes = [_sem_acento_up(m['nome']) for m in data['cavaloaco']['municipios']]  # o export grafa AGUAS/ARACUAI sem acento
    sem = _semanas(sel, nomes)
    if sem:
        # meta semanal por cidade (1 destacamento, 2 pelotão, 4 sede de companhia) a partir da meta mensal do painel (4, 8, 15)
        meta_sem = {}
        for m in data['cavaloaco']['municipios']:
            mm = max(m.get('meta_mes') or [0])
            meta_sem[_sem_acento_up(m['nome'])] = max(1, -(-mm // 4))
        sem['meta_semanal'] = meta_sem
        det['semanas'] = sem
    data['cavaloaco_detalhe'] = det
    report['cavalo_detalhe'] = {'file': f, 'ops': len(sel), 'sem_bairro': det['qualidade']['sem_bairro'], 'semanas': len(sem['rotulos']) if sem else 0}


# ---- Rolezinho: regularidade SEMANAL (a meta é 1 operação por semana em cada município; o painel mensal soma 4 ou 5 por mês) ----
# Semana = segunda a domingo, só as encerradas até o dia anterior à atualização. Só contagem por cidade e semana, nada pessoal.
# Os valores corrigidos à mão no painel mensal (ROLEZINHO_FROZEN) não entram aqui: a regularidade usa só o que está no export.
def run_rolezinho_semanas(data, report):
    f = latest_csv('Rolezinho')
    if not f or 'rolezinho' not in data:
        report['rolezinho_semanas'] = {'skipped': True, 'reason': 'sem export em entrada/Rolezinho'}
        return
    try:
        rows = read_csv(f, encoding='latin-1')
    except UnicodeDecodeError:
        report['rolezinho_semanas'] = {'skipped': True, 'reason': 'arquivo ilegível'}
        return
    if not rows or 'Município do Fato' not in rows[0]:
        report['rolezinho_semanas'] = {'skipped': True, 'reason': 'arquivo sem as colunas do export de Rolezinho'}
        return
    sel = []
    for r in rows:
        if 'Y01003' not in (r.get('Natureza Principal') or '') or '70 BPM' not in (r.get('Unidade Responsável pelo Registro') or ''):
            continue
        sel.append({'DATA_FATO': (r.get('Data/Hora do Fato') or '').strip()[:10], 'MUNICIPIO': _sem_acento_up(r.get('Município do Fato'))})
    nomes = [_sem_acento_up(m['nome']) for m in data['rolezinho']['municipios']]
    ref = datetime.date.today() - datetime.timedelta(days=1)
    sem = _semanas(sel, nomes, ref=ref)
    if not sem:
        report['rolezinho_semanas'] = {'skipped': True, 'reason': 'sem datas válidas'}
        return
    sem['meta_semanal'] = {n: 1 for n in nomes}
    sem['ate'] = ref.strftime('%d/%m/%Y')
    data['rolezinho']['semanas'] = sem
    report['rolezinho_semanas'] = {'file': f, 'ops': len(sel), 'semanas': len(sem['rotulos'])}


# ---- Cavalo de Aço onda 3: roubos de veículo e de carga (CVPa) com o Cavalo de Aço ao redor (RESTRITO: REDS, data, bairro) ----
# `crimes_violentos.cavalo_ocorrencias` ({município: [ocorrências]}, só PPVD aprovado): para cada roubo cujo alvo é veículo ou carga (ou que tem
# motocicleta roubada), quantas operações de Cavalo de Aço houve na cidade no dia, nos 7 dias antes, a última antes e as do bairro.
# Só contagem/data de operação; nunca nome de policial.
def run_cavalo_cruzamento(data, report):
    f = latest_csv('Cavalo de aço')
    if not f or 'cavaloaco' not in data:
        report['cavalo_cruzamento'] = {'skipped': True, 'reason': 'sem export em entrada/Cavalo de aço'}
        return
    try:
        ops_rows = read_csv(f, encoding='utf-8')
    except UnicodeDecodeError:
        report['cavalo_cruzamento'] = {'skipped': True, 'reason': 'arquivo não é UTF-8'}
        return
    if not ops_rows or 'PRODUTIVIDADE' not in ops_rows[0]:
        report['cavalo_cruzamento'] = {'skipped': True, 'reason': 'arquivo sem as colunas do RAT'}
        return

    def dia(t):
        try:
            return datetime.datetime.strptime((t or '').strip(), '%d/%m/%Y').date()
        except ValueError:
            return None
    por_cid, por_bairro = collections.defaultdict(list), collections.defaultdict(list)
    for r in ops_rows:
        if 'Y01003' not in (r.get('CODIGO_NATUREZA_PRINCIPAL') or ''):
            continue
        d = dia(r.get('DATA_FATO'))
        if not d:
            continue
        cid = (r.get('MUNICIPIO') or '').strip().upper()
        por_cid[cid].append(d)
        b = _sem_acento_up(r.get('BAIRRO'))
        if b and not b.startswith('INV'):
            por_bairro[(cid, b)].append(d)
    saida = {}
    for cid, lst in (data.get('crimes_violentos', {}).get('cvpa_ocorrencias') or {}).items():
        cidn = _sem_acento_up(cid)
        for o in lst:
            alvo = _sem_acento_up(o.get('alvo'))
            veic = ' '.join(o.get('veic') or [])
            moto = 'MOTOCICLETA' in veic.upper() and 'ROUBADO' in veic.upper()
            if alvo not in ALVOS_VEICULO_CARGA and not moto:
                continue
            d = dia(o.get('d'))
            if not d:
                continue
            ds = por_cid.get(cidn, [])
            antes = [x for x in ds if x < d]
            b = _sem_acento_up(o.get('b'))
            db = por_bairro.get((cidn, b), []) if b and not b.startswith('INV') else None
            saida.setdefault(cidn, []).append({
                'r': o.get('r'), 'd': o.get('d'), 'h': o.get('h'), 'b': o.get('b'), 'alvo': o.get('alvo'), 'veic': o.get('veic') or [], 'moto': moto, 'v': o.get('v') or 1,
                'ops_dia': sum(1 for x in ds if x == d), 'ops_7d': sum(1 for x in ds if 0 < (d - x).days <= 7),
                'ultima': max(antes).strftime('%d/%m/%Y') if antes else None, 'dias_ultima': (d - max(antes)).days if antes else None,
                'ops_bairro_30d': None if db is None else sum(1 for x in db if 0 < (d - x).days <= 30),
                'ops_bairro_ano': None if db is None else len(db), 'ops_cidade_ano': len(ds),
            })
    for lst in saida.values():
        lst.sort(key=lambda x: (x['d'] or '').split('/')[::-1])
    data.setdefault('crimes_violentos', {})['cavalo_ocorrencias'] = saida
    report['cavalo_cruzamento'] = {'file': f, 'ocorrencias': sum(len(v) for v in saida.values())}


# ---- Comunicação organizacional: números para divulgar (dias sem ocorrência, presos, motos do Rolezinho, recordes do ano) ----
# PÚBLICO e só agregado: dias desde a última ocorrência por indicador e cidade, totais por mês e recordes. Nenhum REDS, data de ocorrência,
# endereço ou nome entra aqui (a data da última ocorrência fica só no bloco restrito de onde o número vem).
def _chave_terr(nome):
    return _sem_acento_up(nome)


def _dias_sem(datas, ref, inicio_ano):
    """dias desde a última ocorrência, maior sequência do ano e se a atual é a maior. Sem ocorrência no ano: conta desde 1º de janeiro."""
    ds = sorted(set(datas))
    if not ds:
        d = (ref - inicio_ano).days + 1
        return {'dias': d, 'nenhum_no_ano': True, 'maior': d, 'em_andamento': True}
    pontos = [inicio_ano] + ds + [ref]
    lacunas = [(pontos[i + 1] - pontos[i]).days for i in range(len(pontos) - 1)]
    atual = (ref - ds[-1]).days
    maior = max(lacunas)
    return {'dias': atual, 'nenhum_no_ano': False, 'maior': maior, 'em_andamento': atual >= maior}


def run_comunicacao(data, rows_bo, report):
    hoje = datetime.date.today()
    inicio = datetime.date(hoje.year, 1, 1)
    terr = [_chave_terr(m['nome']) for m in data['mv']['municipios']]
    saida = {'referencia': hoje.isoformat()}

    def dia(t):
        try:
            return datetime.datetime.strptime((t or '').strip()[:10], '%d/%m/%Y').date()
        except ValueError:
            return None

    # 1) dias sem morte violenta / roubo (CVPa) / CVPE, por cidade e para o Batalhão (a partir das listas restritas já montadas)
    ds = {}
    for chave in ('mv', 'cvpa', 'cvpe'):
        lista = (data.get('crimes_violentos', {}).get(chave + '_ocorrencias') or {})
        por = {t: [] for t in terr}
        for cid, lst in lista.items():
            t = _chave_terr(cid)
            for o in lst:
                d = dia(o.get('d'))
                if d and t in por:
                    por[t].append(d)
        ds[chave] = {t: _dias_sem(v, hoje, inicio) for t, v in por.items()}
        ds[chave]['BATALHAO'] = _dias_sem([d for v in por.values() for d in v], hoje, inicio)
    saida['dias_sem'] = ds

    # 2) presos (QTDE_PRISAO dos REDS) por cidade e mês
    pres = {t: [0] * N_MESES for t in terr}
    pres_oc = {t: [0] * N_MESES for t in terr}
    for r in rows_bo:
        t = _chave_terr(r.get('MUNICIPIO'))
        try:
            mi = int(r.get('MES_NUMERICO') or 0) - 1
        except ValueError:
            continue
        q = int(_num(r.get('QTDE_PRISAO')))
        if t in pres and 0 <= mi < N_MESES and q > 0:
            pres[t][mi] += q
            pres_oc[t][mi] += 1
    pres['BATALHAO'] = [sum(pres[t][i] for t in terr) for i in range(N_MESES)]
    pres_oc['BATALHAO'] = [sum(pres_oc[t][i] for t in terr) for i in range(N_MESES)]
    saida['presos'] = pres
    saida['presos_ocorrencias'] = pres_oc

    # 3) Rolezinho: motos apreendidas/removidas/fiscalizadas/autuadas (produtividade do RAT das operações do Rolezinho)
    rol = None
    f_rol, f_rat = latest_csv('Rolezinho'), latest_csv('TODOS OS RAT')
    if f_rol and f_rat:
        import re as _re
        rows_rol = read_csv(f_rol, encoding='latin-1')
        rats = {r.get('NUMERO_RAT'): r for r in read_csv(f_rat, encoding='latin-1')}
        chaves = {'apreendidas': lambda du: 'MOTOCICLETA' in du and 'APREENDID' in du and 'FISCALIZ' not in du,
                  'removidas': lambda du: 'MOTOCICLETA' in du and 'REMOVID' in du,
                  'fiscalizadas': lambda du: 'MOTOCICLETAS FISCALIZADAS' in du,
                  'autuadas': lambda du: 'MOTOCICLETAS AUTUADAS' in du}
        rol = {k: {t: [0] * N_MESES for t in terr} for k in chaves}
        n_ok = 0
        for r in rows_rol:
            rat = rats.get((r.get('Número do REDS') or '').strip())
            d = dia(r.get('Data/Hora do Fato'))
            t = _chave_terr(r.get('Município do Fato'))
            if not rat or not d or t not in rol['apreendidas']:
                continue
            n_ok += 1
            for m in _re.finditer(r'idIndicador:(\d+)/descricao:([^/]*)/quantidade:(\d+)/', rat.get('PRODUTIVIDADE') or ''):
                du, qtd = m.group(2).upper(), int(m.group(3))
                for k, fn in chaves.items():
                    if fn(du):
                        rol[k][t][d.month - 1] += qtd
                        break
        for k in rol:
            rol[k]['BATALHAO'] = [sum(rol[k][t][i] for t in terr) for i in range(N_MESES)]
        saida['rolezinho_motos'] = rol
        saida['rolezinho_ops_cruzadas'] = {'rolezinho': len(rows_rol), 'com_rat': n_ok}

    # 3b) mais números: proximidade/prevenção (BOS), resultados (REDS) e abordagem/esforço (RAT) — por cidade e mês, só contagens
    import re as _re2
    series = {}

    def nova():
        return {t: [0] * N_MESES for t in terr}

    def soma_bat(sr):
        sr['BATALHAO'] = [sum(sr[t][i] for t in terr) for i in range(N_MESES)]
        return sr

    def mes_de(r):
        try:
            mm = int(r.get('MES_NUMERICO') or 0) - 1
        except ValueError:
            return None
        return mm if 0 <= mm < N_MESES else None
    f_bos = latest_csv('TODOS OS B.O.S')
    if f_bos:
        vt, vp, ru, eg = nova(), nova(), nova(), nova()
        for r in read_csv(f_bos, encoding='latin-1'):
            t, mm = _chave_terr(r.get('MUNICIPIO')), mes_de(r)
            if t not in vt or mm is None:
                continue
            cod, desc = (r.get('CODIGO_NATUREZA') or '').strip(), _sem_acento_up(r.get('DESC_NATUREZA'))
            if desc.startswith('VISITA TRANQUILIZADORA'):
                vt[t][mm] += 1
            elif cod == 'A21007':
                vp[t][mm] += 1
            elif cod.startswith('A19') or desc.startswith('REUNIAO'):
                ru[t][mm] += 1
            elif cod == 'A23001':
                eg[t][mm] += 1
        series.update({'visitas_tranq': soma_bat(vt), 'visitas_prev': soma_bat(vp), 'reunioes': soma_bat(ru), 'egressos': soma_bat(eg)})
    rec_v, ret_v, dro, forag, oco = nova(), nova(), nova(), nova(), nova()
    tipos = {t: collections.Counter() for t in terr}
    DROGA = _re2.compile('MACONHA|COCAINA|CRACK|PAPELOTE|PINO|BUCHA|SKUNK|HAXIXE')
    for r in rows_bo:
        t, mm = _chave_terr(r.get('MUNICIPIO')), mes_de(r)
        if t not in rec_v or mm is None:
            continue
        oco[t][mm] += 1
        for e in (r.get('VEICULOS') or '').split('|'):
            sit = _re2.search(r'situacaoPlacaDescricao:([^/]*)/', e)
            if not sit:
                continue
            sit = sit.group(1).strip().upper()
            if sit == 'RECUPERADO':
                rec_v[t][mm] += 1
                tp = _re2.search(r'tipoVeiculoDescricao:([^/]*)/', e)
                tp = _sem_acento_up(tp.group(1)) if tp else ''
                tipos[t]['motos' if 'MOTO' in tp else ('automoveis' if ('AUTOMOVEL' in tp or 'CAMIONETA' in tp or 'CAMINHONETE' in tp) else ('caminhoes' if 'CAMINH' in tp else 'outros'))] += 1
            elif sit in ('APREENDIDO', 'REMOVIDO'):
                ret_v[t][mm] += 1
        for e in (r.get('MATERIAIS') or '').split('|'):
            if 'unidadeMedidaDescricao:UNIDADE' in e:
                up = _sem_acento_up(e)
                if DROGA.search(up) and 'EQUIPAMENTOS' not in up:
                    q = _re2.search(r'quantidadeMaterial:([^/]*)/', e)
                    dro[t][mm] += int(q.group(1)) if q and q.group(1).isdigit() else 1
        nats = _sem_acento_up(' '.join((r.get(k) or '') for k in ('DESCR_NATUREZA_PRINCIPAL', 'DESCR_NATUREZA_SECUNDARIA1', 'DESCR_NATUREZA_SECUNDARIA2', 'DESCR_NATUREZA_SECUNDARIA3')))
        if 'FORAGIDO DA JUSTICA' in nats:
            forag[t][mm] += 1
    series.update({'veic_recuperados': soma_bat(rec_v), 'veic_retirados': soma_bat(ret_v), 'drogas': soma_bat(dro), 'foragidos': soma_bat(forag), 'ocorrencias': soma_bat(oco)})
    tp_bat = collections.Counter()
    for t in terr:
        tp_bat.update(tipos[t])
    saida['veic_recuperados_tipos'] = {**{t: dict(tipos[t]) for t in terr}, 'BATALHAO': dict(tp_bat)}
    f_rat2 = latest_csv('TODOS OS RAT')
    if f_rat2:
        pa, vf, lf, hp, ait, etl = nova(), nova(), nova(), nova(), nova(), nova()
        for r in read_csv(f_rat2, encoding='latin-1'):
            t, mm = _chave_terr(r.get('MUNICIPIO')), mes_de(r)
            if t not in pa or mm is None:
                continue
            for mt in _re2.finditer(r'idIndicador:(\d+)/descricao:([^/]*)/quantidade:(\d+)/', r.get('PRODUTIVIDADE') or ''):
                du, q = _sem_acento_up(mt.group(2)), int(mt.group(3))
                if 'PESSOAS ABORDADAS' in du:
                    pa[t][mm] += q
                elif 'VEICULOS FISCALIZADOS' in du:
                    vf[t][mm] += q
                elif 'LOCAIS FISCALIZADOS' in du:
                    lf[t][mm] += q
                elif du.endswith('QDE DE AIT'):
                    ait[t][mm] += q
                elif 'SOPRARAM O ETILOMETRO' in du:
                    etl[t][mm] += q
            minutos, efe = _num(r.get('OPR_TEMPO_TOTAL_MINUTOS')), _contar_itens(r.get('EFETIVOS'))
            if 0 < minutos <= DURACAO_MAX_MIN and efe:
                hp[t][mm] += minutos * efe / 60.0
        for t in terr:
            hp[t] = [int(round(v)) for v in hp[t]]
        series.update({'pessoas_abordadas': soma_bat(pa), 'veic_fiscalizados': soma_bat(vf), 'locais_fiscalizados': soma_bat(lf), 'horas_policiamento': soma_bat(hp), 'ait': soma_bat(ait), 'etilometro': soma_bat(etl)})
    saida['series'] = series

    # 4) recordes do ano (Batalhão)
    rec = []
    meses = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']

    def melhor_mes(serie, ate):
        v = serie[:ate + 1]
        i = max(range(len(v)), key=lambda k: v[k])
        return i, v[i]
    ult = min(hoje.month - 1, N_MESES - 1)
    if data.get('pog', {}).get('total_mes'):
        i, v = melhor_mes(data['pog']['total_mes'], ult)
        rec.append({'id': 'ops_mes', 'titulo': 'Mês com mais operações', 'valor': v, 'unidade': 'operações de POG', 'detalhe': meses[i].capitalize() + (' (em andamento)' if i == ult else '')})
    ef = data.get('cavaloaco_eficacia', {}).get('totais', {})
    if ef.get('motos_fisc'):
        i, v = melhor_mes(ef['motos_fisc'], ult)
        rec.append({'id': 'motos_mes', 'titulo': 'Mês com mais motos fiscalizadas', 'valor': v, 'unidade': 'motos (Cavalo de Aço)', 'detalhe': meses[i].capitalize() + (' (em andamento)' if i == ult else '')})
    i, v = melhor_mes(pres['BATALHAO'], ult)
    if v:
        rec.append({'id': 'presos_mes', 'titulo': 'Mês com mais presos', 'valor': v, 'unidade': 'presos', 'detalhe': meses[i].capitalize() + (' (em andamento)' if i == ult else '')})
    if data.get('armas', {}).get('total_mes'):
        i, v = melhor_mes(data['armas']['total_mes'], ult)
        if v:
            rec.append({'id': 'armas_mes', 'titulo': 'Mês com mais armas de fogo apreendidas', 'valor': v, 'unidade': 'armas', 'detalhe': meses[i].capitalize() + (' (em andamento)' if i == ult else '')})
    f_pog = latest_csv('POG E PPAG')
    if f_pog:
        c = collections.Counter()
        for r in read_csv(f_pog, encoding='utf-8'):
            if (r.get('CODIGO_NATUREZA_PRINCIPAL') or '').strip() in POG_CODIGOS:
                d = dia(r.get('DATA_FATO'))
                if d:
                    c[d] += 1
        if c:
            d, v = max(c.items(), key=lambda kv: (kv[1], kv[0]))
            rec.append({'id': 'ops_dia', 'titulo': 'Dia com mais operações', 'valor': v, 'unidade': 'operações de POG em um só dia', 'detalhe': d.strftime('%d/%m')})
    mv_b = ds['mv']['BATALHAO']
    rec.append({'id': 'mv_sequencia', 'titulo': 'Maior sequência sem morte violenta no Batalhão', 'valor': mv_b['maior'], 'unidade': 'dias', 'detalhe': 'em andamento' if mv_b['em_andamento'] else 'no ano'})
    for rid, chave_s, titulo_r, unid in (('visitas_mes', 'visitas_prev', 'Mês com mais visitas preventivas', 'visitas preventivas'), ('abordados_mes', 'pessoas_abordadas', 'Mês com mais pessoas abordadas', 'pessoas abordadas'),
                                         ('drogas_mes', 'drogas', 'Mês com mais porções de droga apreendidas', 'porções de droga'), ('horas_mes', 'horas_policiamento', 'Mês com mais horas de policiamento', 'horas de policiamento')):
        if series.get(chave_s):
            i, v = melhor_mes(series[chave_s]['BATALHAO'], ult)
            if v:
                rec.append({'id': rid, 'titulo': titulo_r, 'valor': v, 'unidade': unid, 'detalhe': meses[i].capitalize() + (' (em andamento)' if i == ult else '')})
    saida['recordes'] = rec
    data['comunicacao'] = saida
    report['comunicacao'] = {'dias_sem_mv_batalhao': mv_b['dias'], 'recordes': len(rec), 'presos_ano': sum(pres['BATALHAO']), 'rolezinho': rol is not None}



def _extras_cvpa(r, vit):
    """CVPA: o alvo do roubo, o que foi levado (objetos FURTADO/ROUBADO) e os veículos roubados/liberados — campos de texto do SiGOp."""
    alvo = re.sub(r'^BENS/VALORES( DE)? ', '', ((r.get('COMPLEMENTO_NATUREZA') or '').strip() or 'NAO INFORMADO').split(' (')[0])
    objs, vistos = [], set()
    for item in (r.get('MATERIAIS') or '').split('|'):
        m = re.search(r'situacaoDescricao:(.*?)/tipoObjetoDescricao:(.*?)/marcaPadrao', item)
        if m and m.group(1).strip().upper().startswith('FURTADO / ROUBADO'):
            t = m.group(2).strip().title()
            if t and t not in vistos:
                vistos.add(t); objs.append(t)
    veic = []
    for item in (r.get('VEICULOS') or '').split('|'):
        m = re.search(r'situacaoPlacaDescricao:(.*?)/motivoApreensao.*?tipoVeiculoDescricao:(.*?)/marcaModelo', item)
        if m:
            sit = m.group(1).strip().upper()
            if not (sit == 'ROUBADO' or 'RECUPER' in sit or 'LIBERADO' in sit):
                continue  # só veículo da vítima (roubado/recuperado/liberado); apreendido e "sem providência" são do autor ou do local
            txt = f"{m.group(2).strip().title()} ({'roubado' if sit == 'ROUBADO' else ('recuperado' if 'RECUPER' in sit else 'liberado')})"
            if txt not in veic:
                veic.append(txt)
    return {'v': int(vit), 'alvo': alvo.title() if alvo.isupper() else alvo, 'obj': objs[:5], 'veic': veic[:3]}


def run_cvpa_ocorrencias(data, report):
    _lista_ocorrencias(data, report, 'CVPA', 'ICVPA_TOTAL', 'cvpa_ocorrencias', 'cvpa_ocorrencias', extras=_extras_cvpa)


def main():
    data = pr.carregar()  # data_completo.json (com blocos restritos); ver publicar_restrito.py
    report = {}
    run_esforco_furto(data, report)
    run_idob_boemia(data, report)
    run_cavalo_eficacia(data, report)

    f_bo = latest_csv('TODOS OS B.O')
    if f_bo:
        rows_bo = read_csv(f_bo, encoding='latin-1')
        aj.neutralizar_mv(rows_bo, 'TODOS OS B.O', report)  # correções aprovadas em auditoria (ver ajustes_manuais.py)
        run_idob_vitimas(data, rows_bo, f_bo, report)
        run_analise_preditiva_homicidios(data, rows_bo, report)
        run_analise_preditiva_panorama(data, rows_bo, report)
        run_itvd(data, rows_bo, report)
        run_violencia_domestica(data, rows_bo, report)
        run_crimes_violentos(data, rows_bo, report)
        run_reincidencia(data, rows_bo, report)
        run_detalhados(data, rows_bo, report)

    run_local_faixa(data, report)
    run_extras_indicadores(data, report)
    run_operacoes_detalhe(data, report)
    run_idob_detalhe(data, report)
    run_cavalo_detalhe(data, report)
    run_rolezinho_semanas(data, report)
    run_mv_ocorrencias(data, report)
    run_cvpe_ocorrencias(data, report)
    run_cvpa_ocorrencias(data, report)
    run_cavalo_cruzamento(data, report)  # usa a lista de ocorrências do CVPa já montada
    if f_bo:
        run_comunicacao(data, rows_bo, report)
        run_idob_cruzamento(data, rows_bo, report)  # precisa das listas de ocorrências (natureza/causa) já montadas

    # Carimba atualizado_em em todo bloco tocado (e não pulado) nesta rodada — mesmo
    # motivo do aggregate.py (ver 2026-09-28): sem isso o campo ficava parado na última
    # data em que alguém mexeu na mão, e o acompanhamento diário da Auditoria ponderava
    # a meta contra uma data errada.
    HOJE = datetime.date.today().isoformat()
    REPORT_PARA_DATA_KEY = {
        'esforco_furto': 'esforco_furto',
        'cavalo_eficacia': 'cavaloaco_eficacia',
        'itvd': 'itvd',
        'violencia_domestica': 'violencia_domestica',
        'crimes_violentos': 'crimes_violentos',
        'reincidencia': 'reincidencia',
    }
    for report_key, data_key in REPORT_PARA_DATA_KEY.items():
        rv = report.get(report_key)
        if rv and not rv.get('skipped'):
            data[data_key]['atualizado_em'] = HOJE
    if (report.get('idob_boemia') and not report['idob_boemia'].get('skipped')) or report.get('idob_vitimas'):
        data['idob']['atualizado_em'] = HOJE
    if report.get('idob_boemia') and not report['idob_boemia'].get('skipped') and 'boemia_meta' in data:
        data['boemia_meta']['atualizado_em'] = HOJE
    if (report.get('analise_preditiva_homicidios') and not report['analise_preditiva_homicidios'].get('skipped')) or \
       (report.get('analise_preditiva_panorama') and not report['analise_preditiva_panorama'].get('skipped')):
        data['analise_preditiva']['atualizado_em'] = HOJE

    # indent=2 desde 2026-09-08: antes gravava compacto e alguém tinha que reformatar na
    # mão antes de levar pro repo "pra bater o padrão" (ver CONTEXTO_DASHBOARD_70BPM.md,
    # entrada de 04/09) -- grava já formatado, elimina esse passo manual.
    report['publicacao_restrita'] = pr.salvar(data)
    # avisos no celular: eventos novos desde a última rodada (só agregados; ver eventos_notificacao.py). Falha aqui NUNCA derruba a rotina.
    try:
        report['notificacoes'] = en.notificar(data, report['publicacao_restrita'])
    except Exception as e:
        report['notificacoes'] = {'erro': f'{type(e).__name__}: {e}'}
    json.dump(report, open(os.path.join(_here, 'report_grave.json'), 'w', encoding='utf-8'),
               ensure_ascii=False, default=str, indent=1)
    print("DONE", {k: 'ok' for k in report})


if __name__ == '__main__':
    main()

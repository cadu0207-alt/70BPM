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
  - IDOB-vítimas — MV/CVPe/CVPa em bar/boate (fonte: entrada/CRIMES VIOLENTOS BOEMIA, REDS)
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
import csv, json, os, glob, datetime
import aggregate_grave as ag

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
    with open(path, encoding=encoding) as f:
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


def run_idob_vitimas(data, report):
    f = latest_csv('CRIMES VIOLENTOS BOEMIA')
    if not f:
        return
    rows = read_csv(f, encoding='latin-1')
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
    report['idob_vitimas'] = {'file': f, 'drops': dr1 + dr2 + dr3, 'changes': ch1 + ch2 + ch3}


def run_cavalo_eficacia(data, report):
    f = latest_csv('TODOS OS RAT')
    if not f:
        return
    rows = read_csv(f, encoding='latin-1')
    municipios_order = [m['nome'].upper() for m in data['cavaloaco_eficacia']['municipios']]
    novo = ag.build_cavalo_eficacia(rows, municipios_order, N_MESES)
    # rebuild completo (sem proteção de queda) — total_mes_key não existe nessa estrutura,
    # é dict de campos diretos (num_ops etc.), então só substitui e reporta o delta do total.
    old_total_ops = sum(data['cavaloaco_eficacia']['totais'].get('num_ops', []))
    new_total_ops = sum(novo['totais'].get('num_ops', []))
    data['cavaloaco_eficacia']['municipios'] = novo['municipios']
    data['cavaloaco_eficacia']['totais'] = novo['totais']
    data['cavaloaco_eficacia']['naturezas_reds_geradas'] = novo['naturezas_reds_geradas']
    report['cavalo_eficacia'] = {'file': f, 'old_total_ops': old_total_ops, 'new_total_ops': new_total_ops}


MESES_LABEL = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']


def periodo_label(total_mes):
    """'jan-<último mês com dado>/2026' — deriva do último índice não-zero do array total_mes."""
    ultimo = 0
    for i, v in enumerate(total_mes):
        if v > 0:
            ultimo = i
    return f'jan-{MESES_LABEL[ultimo]}/2026'


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
    report['reincidencia'] = {'old_total': old_total, 'new_total': new_total}


def main():
    data = json.load(open(DATA_PATH, encoding='utf-8'))
    report = {}
    run_esforco_furto(data, report)
    run_idob_boemia(data, report)
    run_idob_vitimas(data, report)
    run_cavalo_eficacia(data, report)

    f_bo = latest_csv('TODOS OS B.O')
    if f_bo:
        rows_bo = read_csv(f_bo, encoding='latin-1')
        run_analise_preditiva_homicidios(data, rows_bo, report)
        run_analise_preditiva_panorama(data, rows_bo, report)
        run_itvd(data, rows_bo, report)
        run_violencia_domestica(data, rows_bo, report)
        run_crimes_violentos(data, rows_bo, report)
        run_reincidencia(data, rows_bo, report)

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
    json.dump(data, open(DATA_PATH, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    json.dump(report, open(os.path.join(_here, 'report_grave.json'), 'w', encoding='utf-8'),
               ensure_ascii=False, default=str, indent=1)
    print("DONE", {k: 'ok' for k in report})


if __name__ == '__main__':
    main()

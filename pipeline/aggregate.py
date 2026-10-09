import csv, json, unicodedata, glob, os, sys, datetime
import publicar_restrito as pr
import ajustes_manuais as aj

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "entrada")
DATA_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data.json")
N_MESES = 12  # Jan..Dez (expandido em 03/09/2026)

def norm(s):
    s = unicodedata.normalize('NFD', s or '')
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')
    return s.upper().strip()

def latest_csv(folder, exclude_desktop=True):
    files = [f for f in glob.glob(os.path.join(BASE, folder, "*.csv"))]
    if not files:
        return None
    files.sort(key=os.path.getmtime)
    return files[-1]

def read_utf8_reds(path):
    with open(path, encoding='utf-8') as fh:
        r = csv.DictReader(fh, delimiter=';')
        return list(r)

def empty_month_dict(muns):
    return {m: [0]*N_MESES for m in muns}

# ★★ 2026-09-01: Eduardo decidiu remover a proteção "nunca aceita queda" (merge_max).
# Decisão dele: "o certo é cair" quando o export novo trouxer menos — a proteção estava
# travando dados ERRADOS pra sempre (ver caso CVPe/CVPa forçados em 31/08, POG Águas
# Vermelhas em 28/08) e mascarando reclassificações reais no SiGOp. A partir de agora
# TODOS os indicadores de merge-por-célula fazem OVERWRITE DIRETO com o valor mais novo
# (sobe ou desce), sem nenhum bloqueio automático. `merge_cell` ainda calcula e devolve
# `changes`/`drops` no `report.json` só pra VISIBILIDADE (Eduardo revisa depois), nunca
# pra bloquear.
#
# ÚNICA EXCEÇÃO: Rolezinho tem 4 células CONGELADAS (frozen) — município/mês que Eduardo
# corrigiu manualmente com evidência de RAT específico (ver project_p3_dashboard_html_70bpm,
# 2026-08-04) e que o export oficial (natureza Y01003 + histórico "ROLEZINHO") nunca capturou
# de volta. Essas células ficam fixas pra sempre, mesmo que o export continue trazendo menos;
# TODO o resto de Rolezinho (outros municípios, outros meses, meses futuros) segue o overwrite
# normal sem proteção nenhuma.
ROLEZINHO_FROZEN = {
    'AGUAS VERMELHAS': {6: 4},     # Julho — corrigido manualmente em 2026-08-04
    'CACHOEIRA DE PAJEU': {6: 4},  # Julho — corrigido manualmente em 2026-08-04
    'PADRE PARAISO': {6: 4},       # Julho — corrigido manualmente em 2026-08-04
    'PEDRA AZUL': {6: 10},         # Julho — corrigido manualmente em 2026-08-04
}

def merge_cell(old_list, new_dict_by_norm_name, frozen=None):
    """Overwrite direto (sem proteção de queda). `frozen` (opcional) é um dict
    {NOME_NORMALIZADO: {indice_mes: valor}} de células que NUNCA são sobrescritas,
    nem pra cima nem pra baixo — usado só pra Rolezinho (ver ROLEZINHO_FROZEN acima)."""
    frozen = frozen or {}
    changes = []
    drops = []
    out = []
    for m in old_list:
        nome = m['nome']
        key = norm(nome)
        old_mes = m['realizado_mes']
        new_mes = new_dict_by_norm_name.get(key, [0]*N_MESES)
        fz = frozen.get(key, {})
        merged = []
        for i in range(N_MESES):
            if i in fz:
                merged.append(fz[i])
                continue
            o = old_mes[i] if i < len(old_mes) else 0
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
        out.append({
            'nome': nome,
            'realizado_mes': merged,
            'meta_mes': m['meta_mes'],
            'realizado_acum': acum,
            'meta_acum': m['meta_acum'],
        })
    return out, changes, drops

# alias de compatibilidade (nome antigo, comportamento novo) — não usar merge_max
# como "protege contra queda" a partir de agora, é só overwrite.
merge_max = merge_cell


def recompute_totals(obj, mes_field='realizado_mes', acum_field='realizado_acum',
                      total_mes_key='total_mes', total_acum_key='total_acum'):
    """Recalcula total_mes/total_acum como SOMA simples dos municípios — sempre chamar
    depois de qualquer merge_cell(). Bug de 2026-08-21: total ficava fora de sincronia
    da lista por município (ver memória project_p3_bug_totais_dessincronizados) porque
    esse recálculo nunca era feito automaticamente."""
    munis = obj.get('municipios', [])
    if not munis:
        return
    n = len(munis[0].get(mes_field, []))
    total_mes = [0]*n
    total_acum = [0]*n
    for m in munis:
        for i, v in enumerate(m.get(mes_field, [])):
            if i < n:
                total_mes[i] += v
        for i, v in enumerate(m.get(acum_field, [])):
            if i < n:
                total_acum[i] += v
    if total_mes_key in obj:
        obj[total_mes_key] = total_mes
    if total_acum_key in obj:
        obj[total_acum_key] = total_acum

def agg_simulacro_field(rows, materiais_col='MATERIAIS', mun_col='MUNICIPIO', mes_col='MES_NUMERICO'):
    """Conta simulacros de arma de fogo apreendidos, registrados no campo de materiais
    (nao no campo QTDE_ARMAS_FOGO). Achado em 2026-08-27 (ver memoria
    project_p3_armas_simulacro): SiGOp guarda simulacro como objeto apreendido no historico
    de materiais, nao como arma, entao agg_sum_field('QTDE_ARMAS_FOGO') sozinho sempre
    subcontava o indicador Armas de Fogo. Eduardo confirmou que simulacro deve contar
    1 pra 1 igual arma de fogo real."""
    import re, unicodedata
    def _norm(s):
        s = unicodedata.normalize('NFD', s or '')
        s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')
        return s.upper().strip()
    d = {}
    for row in rows:
        mat = row.get(materiais_col, '') or ''
        if 'SIMULACRO' not in _norm(mat):
            continue
        for m in re.finditer(r'tipoObjetoDescricao:([^/]*SIMULACRO[^/]*)/[^|]*?quantidadeMaterial:([^/]*)/', mat):
            qtd_raw = m.group(2)
            try:
                qtd = int(qtd_raw)
            except Exception:
                qtd = 1
            mun = _norm(row.get(mun_col, ''))
            try:
                mes = int(row.get(mes_col, 0))
            except Exception:
                continue
            if 1 <= mes <= N_MESES:
                d.setdefault(mun, [0]*N_MESES)
                d[mun][mes-1] += qtd
    return d

def merge_add(base_dict, add_dict):
    """Soma add_dict em base_dict celula a celula (usado pra somar simulacro em cima
    da soma de QTDE_ARMAS_FOGO, antes do merge_cell contra o data.json existente)."""
    out = {k: list(v) for k, v in base_dict.items()}
    for mun, arr in add_dict.items():
        if mun not in out:
            out[mun] = [0]*N_MESES
        for i, v in enumerate(arr):
            out[mun][i] += v
    return out

def agg_flag_count(rows, flag_col, mun_col='MUNICIPIO', mes_col='MES_NUMERICO'):
    d = {}
    for row in rows:
        try:
            if str(row.get(flag_col, '0')).strip() not in ('', '0'):
                mun = norm(row.get(mun_col, ''))
                mes = int(row.get(mes_col, 0))
                if 1 <= mes <= N_MESES:
                    d.setdefault(mun, [0]*N_MESES)
                    d[mun][mes-1] += 1
        except Exception:
            pass
    return d

def agg_sum_field(rows, sum_col, mun_col='MUNICIPIO', mes_col='MES_NUMERICO'):
    """★ 2026-08-31/09-01: soma o VALOR do campo (ex. IMV_TOTAL), não conta 1 por REDS.
    IMV_TOTAL/ICVPE_TOTAL/ICVPA_TOTAL são quantidade de VÍTIMAS daquele REDS, não uma flag
    0/1 — um REDS com 2 vítimas do mesmo tipo soma 2, não 1. Eduardo confirmou explicitamente
    em 2026-09-01 que essa é a contagem certa (vítimas, não REDS) e que isso continua valendo
    mesmo agora que a proteção contra queda foi removida — uma queda de MV/CVPe/CVPa reflete
    queda real de vítimas contadas, não é sinal de bug de metodologia."""
    d = {}
    for row in rows:
        try:
            val = row.get(sum_col, '0')
            val = int(str(val).strip() or 0)
            if val > 0:
                mun = norm(row.get(mun_col, ''))
                mes = int(row.get(mes_col, 0))
                if 1 <= mes <= N_MESES:
                    d.setdefault(mun, [0]*N_MESES)
                    d[mun][mes-1] += val
        except Exception:
            pass
    return d

def agg_bos_filter(path, natureza_code, historico_substr=None, unidade_substr='70 BPM'):
    """Exports do tipo 'relatorio' (pasta dedicada Cavalo de aço/Rolezinho/Padrinhos/Saque Seguro)
    já vêm pré-filtrados pelo SiGOp pela busca (Natureza+Histórico aplicados no servidor) e NÃO têm
    coluna de Histórico livre — colunas: Número do REDS, Tipo de Relatório, Data/Hora de Criação,
    Data/Hora do Fato, Natureza Principal, Endereço do Fato, Município do Fato, Unidade Responsável,
    Número do BO. Contamos todas as linhas (checando Natureza contém o código, e Unidade contém '70 BPM'
    como filtro de segurança pra excluir registros fora da área, ex. 'JUIZ DE FORA').
    ★ 2026-09-01: confirmado que a pasta TRAFICO NÃO segue esse padrão pré-filtrado (ver
    aggregate_grave.py/build_itvd — TRAFICO vem no formato REDS completo tipo TODOS OS B.O,
    com naturezas misturadas, precisa do filtro por código igual ao geral). Não usar
    agg_bos_filter pra TRAFICO.

    ★ 2026-09-03: achado no export de Cavalo de Aço — SiGOp às vezes gera esse relatório
    num formato SEM a coluna 'UNIDADE_RESPONS...' (schema com UNID_REGISTRO/UNID_AREA_MILITAR/
    UNID_AREA_NIVEL_4/5/6 em vez dela). Sem fallback, isso zerava 100% das linhas (1732/1732)
    porque c_unid virava None → string vazia → nunca contém '70 BPM'. Confirmado que
    UNID_AREA_NIVEL_5 tem exatamente essa informação ('70 BPM' em todas as linhas do 70º BPM)
    nesse formato alternativo — usado como fallback só quando a coluna antiga não existe."""
    with open(path, encoding='latin1') as fh:
        r = csv.DictReader(fh, delimiter=';')
        header = r.fieldnames
        def col(*subs):
            for h in header:
                hn = norm(h)
                if all(norm(s) in hn for s in subs):
                    return h
            return None
        c_nat = col('NATUREZA', 'PRINCIPAL') or col('NATUREZA')
        c_data = col('DATA', 'FATO')
        c_mun = col('MUNIC', 'FATO') or next((h for h in header if norm(h) == 'MUNICIPIO'), None)
        c_unid_fallback = next((h for h in header if norm(h) == 'UNID_AREA_NIVEL_5'), None)
        c_unid = col('UNIDADE', 'RESPONS') or c_unid_fallback
        rows = list(r)
    d = {}
    matched = 0
    skipped_natureza = 0
    skipped_unidade = 0
    for row in rows:
        nat = row.get(c_nat, '') if c_nat else ''
        if natureza_code not in norm(nat):
            skipped_natureza += 1
            continue
        if unidade_substr:
            unid = row.get(c_unid, '') if c_unid else ''
            if unidade_substr not in norm(unid):
                skipped_unidade += 1
                continue
        data = row.get(c_data, '') if c_data else ''
        mun = norm(row.get(c_mun, '')) if c_mun else ''
        try:
            mes = int(data.strip()[3:5])
        except Exception:
            continue
        if not (1 <= mes <= N_MESES):
            continue
        d.setdefault(mun, [0]*N_MESES)
        d[mun][mes-1] += 1
        matched += 1
    return d, matched, {'header': header, 'skipped_natureza': skipped_natureza, 'skipped_unidade': skipped_unidade, 'total_rows': len(rows)}

def agg_rat_natureza(rows, codes, mun_col='MUNICIPIO', mes_col='MES_NUMERICO', nat_col='CODIGO_NATUREZA_PRINCIPAL'):
    d = {}
    for row in rows:
        nat = (row.get(nat_col) or '').strip()
        if nat in codes:
            mun = norm(row.get(mun_col, ''))
            try:
                mes = int(row.get(mes_col, 0))
            except Exception:
                continue
            if 1 <= mes <= N_MESES:
                d.setdefault(mun, [0]*N_MESES)
                d[mun][mes-1] += 1
    return d

def main():
    # Trabalha no data_completo.json (com os blocos restritos); ao final grava o data.json PÚBLICO
    # sem endereço/REDS e envia o restrito ao Supabase (ver publicar_restrito.py).
    data = pr.carregar()
    report = {}

    f = latest_csv('MV')
    rows = read_utf8_reds(f)
    aj.neutralizar_mv(rows, 'MV', report)  # correções aprovadas em auditoria (ver ajustes_manuais.py)
    new_d = agg_sum_field(rows, 'IMV_TOTAL')
    new_list, ch, dr = merge_cell(data['mv']['municipios'], new_d)
    data['mv']['municipios'] = new_list
    recompute_totals(data['mv'])
    report['mv'] = {'file': f, 'n_rows': len(rows), 'changes': ch, 'drops': dr}

    f = latest_csv('CVPE')
    rows = read_utf8_reds(f)
    new_d = agg_sum_field(rows, 'ICVPE_TOTAL')
    new_list, ch, dr = merge_cell(data['cvpe']['municipios'], new_d)
    data['cvpe']['municipios'] = new_list
    recompute_totals(data['cvpe'])
    report['cvpe'] = {'file': f, 'n_rows': len(rows), 'changes': ch, 'drops': dr}

    f = latest_csv('CVPA')
    rows = read_utf8_reds(f)
    new_d = agg_sum_field(rows, 'ICVPA_TOTAL')
    new_list, ch, dr = merge_cell(data['cvpa']['municipios'], new_d)
    data['cvpa']['municipios'] = new_list
    recompute_totals(data['cvpa'])
    report['cvpa'] = {'file': f, 'n_rows': len(rows), 'changes': ch, 'drops': dr}

    f = latest_csv('FURTO RURAL')
    rows = read_utf8_reds(f)
    new_d = agg_flag_count(rows, 'IFZR')
    new_list, ch, dr = merge_cell(data['furto']['municipios'], new_d)
    data['furto']['municipios'] = new_list
    recompute_totals(data['furto'])
    report['furto_rural'] = {'file': f, 'n_rows': len(rows), 'changes': ch, 'drops': dr}

    f = latest_csv('ARMAS DE FOGO')
    rows = read_utf8_reds(f)
    new_d = agg_sum_field(rows, 'QTDE_ARMAS_FOGO')
    new_d_simulacro = agg_simulacro_field(rows)
    new_d = merge_add(new_d, new_d_simulacro)
    new_list, ch, dr = merge_cell(data['armas']['municipios'], new_d)
    data['armas']['municipios'] = new_list
    recompute_totals(data['armas'])
    report['armas'] = {'file': f, 'n_rows': len(rows), 'changes': ch, 'drops': dr, 'simulacros': new_d_simulacro}

    f = latest_csv('Cavalo de aço')
    new_d, matched, header = agg_bos_filter(f, 'Y01003', historico_substr='CAVALO DE ACO')
    new_list, ch, dr = merge_cell(data['cavaloaco']['municipios'], new_d)
    data['cavaloaco']['municipios'] = new_list
    recompute_totals(data['cavaloaco'])
    report['cavaloaco'] = {'file': f, 'n_matched': matched, 'changes': ch, 'drops': dr}

    f = latest_csv('Rolezinho')
    new_d, matched, header = agg_bos_filter(f, 'Y01003', historico_substr='ROLEZINHO')
    new_list, ch, dr = merge_cell(data['rolezinho']['municipios'], new_d, frozen=ROLEZINHO_FROZEN)
    data['rolezinho']['municipios'] = new_list
    recompute_totals(data['rolezinho'])
    report['rolezinho'] = {'file': f, 'n_matched': matched, 'changes': ch, 'drops': dr, 'frozen': ROLEZINHO_FROZEN}

    f = latest_csv('Padrinhos da Escola')
    new_d, matched, header = agg_bos_filter(f, 'A21007', historico_substr='PADRINHOS DA ESCOLA')
    new_list, ch, dr = merge_cell(data['padesc']['municipios'], new_d)
    data['padesc']['municipios'] = new_list
    recompute_totals(data['padesc'])
    report['padesc'] = {'file': f, 'n_matched': matched, 'changes': ch, 'drops': dr}

    f = latest_csv('SAQUE SEGURO')
    new_d, matched, header = agg_bos_filter(f, 'A21007', historico_substr='SAQUE SEGURO')
    new_list, ch, dr = merge_cell(data['saque_seguro']['municipios'], new_d)
    data['saque_seguro']['municipios'] = new_list
    recompute_totals(data['saque_seguro'])
    report['saque_seguro'] = {'file': f, 'n_matched': matched, 'changes': ch, 'drops': dr}

    f = latest_csv('POG E PPAG')
    with open(f, encoding='utf-8') as fh:
        rat_rows = list(csv.DictReader(fh, delimiter=';'))
    POG_CODES = {'Y04009','Y07001','Y07002','Y07003','Y07010','Y10001'}
    new_d = agg_rat_natureza(rat_rows, POG_CODES)
    new_list, ch, dr = merge_cell(data['pog']['municipios'], new_d)
    data['pog']['municipios'] = new_list
    recompute_totals(data['pog'])
    report['pog'] = {'file': f, 'n_rows': len(rat_rows), 'changes': ch, 'drops': dr}

    ppag_report = {}
    for code, key in [('Y15001','y15001'), ('Y07012','y07012'), ('Y07014','y07014')]:
        new_d = agg_rat_natureza(rat_rows, {code})
        new_list, ch, dr = merge_cell(data['ppag'][key]['municipios'], new_d)
        data['ppag'][key]['municipios'] = new_list
        recompute_totals(data['ppag'][key])
        ppag_report[key] = {'changes': ch, 'drops': dr}
    report['ppag'] = ppag_report

    # Carimba atualizado_em em todo bloco tocado nesta rodada — achado por Eduardo em
    # 2026-09-28: como isso nunca era escrito automaticamente, o campo ficava parado na
    # última data em que alguém tinha mexido na mão, e o acompanhamento diário da
    # Auditoria acabava ponderando a meta contra uma data errada (velha). Passa a refletir
    # sempre o dia em que a rotina realmente rodou, não o dia do arquivo de origem.
    HOJE = datetime.date.today().isoformat()
    for key in ('mv', 'cvpe', 'cvpa', 'furto', 'armas', 'cavaloaco', 'rolezinho', 'padesc', 'saque_seguro', 'pog'):
        data[key]['atualizado_em'] = HOJE
    for key in data['ppag']:
        data['ppag'][key]['atualizado_em'] = HOJE

    out_dir = os.path.dirname(os.path.abspath(__file__))
    report['publicacao_restrita'] = pr.salvar(data)
    json.dump(report, open(os.path.join(out_dir, 'report.json'), 'w', encoding='utf-8'), ensure_ascii=False, default=str, indent=1)
    print("DONE")

if __name__ == '__main__':
    main()

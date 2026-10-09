#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
aggregate_grave.py — agregação persistida das 4 páginas que dependem de REBUILD COMPLETO
(não merge incremental) a partir do export "TODOS OS B.O": Análise Preditiva de Crimes
(bloco Homicídios/Feminicídios/Tentativas), Violência Doméstica, Crimes Violentos e
Preditiva por Reincidência de Endereço.

Por que este script existe: essas 4 páginas foram sempre reconstruídas do zero, na hora,
via script Python ad-hoc dentro da conversa — nunca persistidas. Isso significa que toda
rodada da rotina diária (`atualizacao-diaria-dashboard-70bpm`) pulava essas 4 páginas
("fora de escopo por tempo"), mesmo quando o export TODOS OS B.O já tinha dado novo — foi
exatamente esse gap que deixou o homicídio de Medina (14/08/2026, REDS 2026-037389458-001)
de fora do painel por alguns dias. Ver memórias:
  - project_p3_vd_metodologia_u33004.md (Violência Doméstica via natureza U33004)
  - project_p3_gut_crimes_violentos_reincidencia.md (Crimes Violentos + Reincidência)
  - project_p3_gap_homicidio_medina_14ago.md (o incidente que expôs esse gap)
  - project_p3_dashboard_bug_cavaloaco_motos.md (split Homicídio vs Tentativa)

USO: chamado pela rotina diária depois de copiar o `data.json` atual pra sessão. Cada
função abaixo recebe o caminho do CSV "TODOS OS B.O" mais recente e o dict `data` (já
carregado de data.json) e devolve um NOVO dict pros campos daquela página — quem chama
decide se aplica (a regra de segurança é: comparar total geral antes/depois; se o total
CAIU mais que uma tolerância pequena — ex. >2% — é sinal de export mais estreito/incompleto,
não dado real caindo, então NÃO aplicar e sinalizar pra revisão do Eduardo, igual já é
feito pros outros ~12 indicadores. Diferente do merge-por-célula deles, aqui é rebuild
completo: se o total bater ou subir, aplica tudo; se cair, pausa tudo e avisa).

IMPORTANTE: cobre só os campos de Homicídio/Feminicídio/Tentativa da Análise Preditiva
(panorama.homic_mes/tent_hom_mes, municipios[].homic_mes/tent_hom_mes, e as entradas
correspondentes em ocorrencias_graves). NÃO reconstrói prec_mes/vd_mes(proxy)/mp_mes/
armas_mes/pris_mes/total_mes da Análise Preditiva nem a lista completa de ocorrências
graves de outras naturezas — a lógica original completa desses campos (de 2026-08-11) não
está com certeza suficiente pra reproduzir sem risco de mismatch silencioso (ver histórico
de incidentes CVPA/CVPE/SAQUE_SEGURO na memória principal do projeto). Se precisar cobrir
o resto, pedir a Eduardo pra confirmar o critério original antes de mexer.
"""

import csv
from datetime import datetime, date

MESES_LABEL = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto',
               'Setembro', 'Outubro', 'Novembro', 'Dezembro']


def _f1(v):
    return str(v).strip() == '1'


def read_todos_os_bo(csv_path):
    rows = []
    with open(csv_path, encoding='latin-1') as f:
        reader = csv.DictReader(f, delimiter=';')
        for row in reader:
            rows.append(row)
    return rows


def n_meses_atuais(rows):
    """Quantos meses tem dado no export (pra dimensionar os arrays igual ao resto do painel)."""
    max_mes = 0
    for r in rows:
        try:
            mi = int(r['MES_NUMERICO'])
        except (ValueError, KeyError):
            continue
        if 1 <= mi <= 12:
            max_mes = max(max_mes, mi)
    return max_mes


# ---------- Análise Preditiva — bloco Homicídio/Feminicídio/Tentativa ----------

def build_homicidios_tentativas(rows, municipios_order, n_meses):
    """
    Retorna (panorama_homic_mes, panorama_tent_hom_mes, por_municipio, ocorrencias_por_municipio)
    Critério (validado 2026-08-20): natureza B01121 (Homicídio) ou B01504 (Feminicídio),
    separado por TENTADO_CONSUMADO_PRINCIPAL — só CONSUMADO conta como Homicídio/Feminicídio
    de verdade (bate com IMV_TOTAL, o flag oficial do SiGOp); TENTADO vira "Tentativa de X".
    CASO CONSUMADO exige também IMV_TOTAL=='1' (mesmo critério do indicador oficial) — existe
    pelo menos 1 REDS (2026-016952692-001, Pedra Azul, 14/04/2026, causa "Sofrimento Mental")
    com natureza Homicídio consumado mas IMV_TOTAL=0 (provável óbito não classificado como
    homicídio pela PM apesar da natureza registrada assim) — ele fica de fora do KPI oficial
    mas segue aparecendo na lista de ocorrências como "Homicídio" pra não sumir da visão
    situacional (ver project_p3_dashboard_bug_cavaloaco_motos.md).
    """
    homic_mes = [0] * n_meses
    tent_mes = [0] * n_meses
    by_muni_homic = {m: [0] * n_meses for m in municipios_order}
    by_muni_tent = {m: [0] * n_meses for m in municipios_order}
    ocorrencias = {m: [] for m in municipios_order}

    for row in rows:
        cod = row['CODIGO_NATUREZA_PRINCIPAL'].strip()
        if cod not in ('B01121', 'B01504'):
            continue
        try:
            mi = int(row['MES_NUMERICO']) - 1
        except (ValueError, KeyError):
            continue
        if mi < 0 or mi >= n_meses:
            continue
        muni = row['MUNICIPIO'].strip().upper()
        if muni not in by_muni_homic:
            by_muni_homic[muni] = [0] * n_meses
            by_muni_tent[muni] = [0] * n_meses
            ocorrencias[muni] = []

        tentado = row['TENTADO_CONSUMADO_PRINCIPAL'].strip().upper() == 'TENTADO'
        nat_label = 'Feminicídio' if cod == 'B01504' else 'Homicídio'
        conta_no_kpi = True
        if tentado:
            tent_mes[mi] += 1
            by_muni_tent[muni][mi] += 1
            nat_label = f'Tentativa de {nat_label}'
        else:
            if _f1(row['IMV_TOTAL']):
                homic_mes[mi] += 1
                by_muni_homic[muni][mi] += 1
            else:
                conta_no_kpi = False  # ex.: Pedra Azul 2026-016952692-001 — fica fora do KPI, mas aparece na lista

        arma = False
        try:
            arma = int(row['QTDE_ARMAS_FOGO'] or 0) > 0
        except ValueError:
            pass
        pris = False
        try:
            pris = int(row['QTDE_PRISAO'] or 0) > 0
        except ValueError:
            pass

        natcodes = [row['CODIGO_NATUREZA_PRINCIPAL'], row.get('CODIGO_NATUREZA_SECUNDARIA1', ''),
                    row.get('CODIGO_NATUREZA_SECUNDARIA2', ''), row.get('CODIGO_NATUREZA_SECUNDARIA3', '')]
        vd = 'U33004' in natcodes

        ocorrencias[muni].append({
            'r': row['NUMERO_REDS'], 'd': row['DATA_FATO'], 'm': mi + 1, 'n': nat_label,
            'b': row['BAIRRO'].strip() or row['BAIRRO_NAO_CADASTRADO'].strip(),
            'l': row['LOGRADOURO'].strip() or row['LOGRADOURO_NAO_CADASTRADO'].strip(),
            'nu': (row['NUMERO_LOGRADOURO'].strip() or row['NUMERO_LOGRADOURO_NAO_CADASTRADO'].strip() or '0'),
            'c': row['CAUSA_PRESUMIDA'].strip(), 'a': arma, 'p': pris, 'g': 'critica',
            'vd': vd, 'ri': False,
        })

    return homic_mes, tent_mes, by_muni_homic, by_muni_tent, ocorrencias


PREC_CODES = {'B01147', 'B01129', 'B08021', 'G02024'}  # Ameaça, Lesão Corporal, Vias de Fato, Descumprimento MP


def _eh_vd_real(row):
    natcodes = [row['CODIGO_NATUREZA_PRINCIPAL'], row.get('CODIGO_NATUREZA_SECUNDARIA1', ''),
                row.get('CODIGO_NATUREZA_SECUNDARIA2', ''), row.get('CODIGO_NATUREZA_SECUNDARIA3', '')]
    return 'U33004' in natcodes


def build_panorama_geral(rows, municipios_order, n_meses):
    """
    Campos gerais do panorama da Análise Preditiva além de Homicídio/Tentativa (que tem
    função própria acima). Critérios confirmados por auditoria em 2026-08-21, cruzando
    contra o CSV bruto e batendo 100% (jan-jul) com os valores já publicados:
      - total_mes: TODA linha do REDS, sem filtro de natureza.
      - prec_mes: só os 4 códigos precursores de escalada (PREC_CODES).
      - mp_mes: subconjunto de prec_mes com natureza G02024 (Descumprimento de MP).
      - armas_mes: REDS do universo precursor+homicídio/feminicídio com QTDE_ARMAS_FOGO>0.
      - pris_mes: SOMA de QTDE_PRISAO em TODA linha do REDS (não filtrado por natureza,
        mesma lógica de "soma quantidade" já usada no indicador ARMAS de fogo).
      - vd_mes: **mudou em 2026-08-21** — antes usava proxy (Causa Presumida "Atrito
        Familiar"/"Passional" dentro do universo precursor); Eduardo confirmou trocar pra
        marcação real do SiGOp (natureza U33004), mesmo critério já usado na aba Violência
        Doméstica dedicada, restrito ao universo precursor pra continuar sendo um
        subconjunto comparável (não o total geral de VD, que é maior e tem naturezas fora
        das 4 precursoras — ver DATA.violencia_domestica). Valor validado: 574→512 no ano.
    """
    GRAVE_CODES = PREC_CODES | {'B01121', 'B01504'}

    total_mes = [0] * n_meses
    prec_mes = [0] * n_meses
    mp_mes = [0] * n_meses
    armas_mes = [0] * n_meses
    pris_mes = [0] * n_meses
    vd_mes = [0] * n_meses

    by_muni = {m: {'total_mes': [0] * n_meses, 'prec_mes': [0] * n_meses, 'mp_mes': [0] * n_meses,
                    'armas_mes': [0] * n_meses, 'pris_mes': [0] * n_meses, 'vd_mes': [0] * n_meses}
               for m in municipios_order}

    for row in rows:
        try:
            mi = int(row['MES_NUMERICO']) - 1
        except (ValueError, KeyError):
            continue
        if mi < 0 or mi >= n_meses:
            continue
        muni = row['MUNICIPIO'].strip().upper()
        if muni not in by_muni:
            by_muni[muni] = {'total_mes': [0] * n_meses, 'prec_mes': [0] * n_meses, 'mp_mes': [0] * n_meses,
                              'armas_mes': [0] * n_meses, 'pris_mes': [0] * n_meses, 'vd_mes': [0] * n_meses}

        cod = row['CODIGO_NATUREZA_PRINCIPAL'].strip()

        # total_mes: toda linha
        total_mes[mi] += 1
        by_muni[muni]['total_mes'][mi] += 1

        # pris_mes: soma QTDE_PRISAO em toda linha
        try:
            q_pris = int(row['QTDE_PRISAO'] or 0)
        except ValueError:
            q_pris = 0
        pris_mes[mi] += q_pris
        by_muni[muni]['pris_mes'][mi] += q_pris

        if cod in PREC_CODES:
            prec_mes[mi] += 1
            by_muni[muni]['prec_mes'][mi] += 1
            if cod == 'G02024':
                mp_mes[mi] += 1
                by_muni[muni]['mp_mes'][mi] += 1
            if _eh_vd_real(row):
                vd_mes[mi] += 1
                by_muni[muni]['vd_mes'][mi] += 1

        if cod in GRAVE_CODES:
            try:
                arma = int(row['QTDE_ARMAS_FOGO'] or 0) > 0
            except ValueError:
                arma = False
            if arma:
                armas_mes[mi] += 1
                by_muni[muni]['armas_mes'][mi] += 1

    panorama = {'total_mes': total_mes, 'prec_mes': prec_mes, 'mp_mes': mp_mes,
                'armas_mes': armas_mes, 'pris_mes': pris_mes, 'vd_mes': vd_mes}
    return panorama, by_muni


# ---------- Violência Doméstica (natureza U33004) ----------

def build_violencia_domestica(rows, pop_by_muni, n_meses, hoje=None):
    hoje = hoje or date.today()

    def eh_vd(row):
        natcodes = [row['CODIGO_NATUREZA_PRINCIPAL'], row.get('CODIGO_NATUREZA_SECUNDARIA1', ''),
                    row.get('CODIGO_NATUREZA_SECUNDARIA2', ''), row.get('CODIGO_NATUREZA_SECUNDARIA3', '')]
        return 'U33004' in natcodes

    vd_rows = {}
    for row in rows:
        if eh_vd(row):
            vd_rows[row['NUMERO_REDS']] = row  # dedup por REDS

    total_mes = [0] * n_meses
    homic_mes = [0] * n_meses
    tent_mes = [0] * n_meses
    by_muni_total = {}
    ocorrencias = {}
    enderecos_por_endereco = {}

    for row in vd_rows.values():
        muni = row['MUNICIPIO'].strip().upper()
        try:
            mi = int(row['MES_NUMERICO']) - 1
        except (ValueError, KeyError):
            continue
        if mi < 0 or mi >= n_meses:
            continue
        by_muni_total.setdefault(muni, [0] * n_meses)
        ocorrencias.setdefault(muni, [])
        by_muni_total[muni][mi] += 1
        total_mes[mi] += 1

        cod = row['CODIGO_NATUREZA_PRINCIPAL'].strip()
        vd_homic = cod in ('B01121', 'B01504')
        if vd_homic:
            if row['TENTADO_CONSUMADO_PRINCIPAL'].strip().upper() == 'TENTADO':
                tent_mes[mi] += 1
            else:
                homic_mes[mi] += 1

        arma = False
        try:
            arma = int(row['QTDE_ARMAS_FOGO'] or 0) > 0
        except ValueError:
            pass
        pris = False
        try:
            pris = int(row['QTDE_PRISAO'] or 0) > 0
        except ValueError:
            pass

        nat = row['DESCR_NATUREZA_PRINCIPAL'].strip().title()
        gravidade = 'media'
        if vd_homic or arma:
            gravidade = 'critica'
        elif cod in ('G02024', 'B01129'):  # descumprimento MP, lesão corporal
            gravidade = 'alta'

        ocorrencias[muni].append({
            'r': row['NUMERO_REDS'], 'd': row['DATA_FATO'], 'm': mi + 1, 'n': nat,
            'b': row['BAIRRO'].strip() or row['BAIRRO_NAO_CADASTRADO'].strip(),
            'l': row['LOGRADOURO'].strip() or row['LOGRADOURO_NAO_CADASTRADO'].strip(),
            'nu': (row['NUMERO_LOGRADOURO'].strip() or row['NUMERO_LOGRADOURO_NAO_CADASTRADO'].strip() or '0'),
            'c': row['CAUSA_PRESUMIDA'].strip(), 'a': arma, 'p': pris, 'g': gravidade,
            'vd': True, 'ri': False, 'vd_homic': vd_homic,
        })

        # reincidência de endereço (dentro do universo VD)
        bai = (row['BAIRRO'].strip() or row['BAIRRO_NAO_CADASTRADO'].strip()).upper()
        log = (row['LOGRADOURO'].strip() or row['LOGRADOURO_NAO_CADASTRADO'].strip()).upper()
        num = (row['NUMERO_LOGRADOURO'].strip() or row['NUMERO_LOGRADOURO_NAO_CADASTRADO'].strip() or '0')
        key = (muni, bai, log, num)
        enderecos_por_endereco.setdefault(key, []).append(mi + 1)

    enderecos_reincidentes = {m: [] for m in by_muni_total}
    for (muni, bai, log, num), meses in enderecos_por_endereco.items():
        if len(meses) >= 2:
            enderecos_reincidentes.setdefault(muni, []).append({
                'b': bai, 'l': log, 'nu': num, 'q': len(meses), 'meses': sorted(set(meses)),
            })
        # marca ri=True nas ocorrencias desse endereco
        if len(meses) >= 2:
            for o in ocorrencias.get(muni, []):
                if o['b'].upper() == bai and o['l'].upper() == log and o['nu'] == num:
                    o['ri'] = True

    municipios = []
    for muni, mes in by_muni_total.items():
        acum = []
        running = 0
        for v in mes:
            running += v
            acum.append(running)
        pop = pop_by_muni.get(muni, 0)
        total_periodo = sum(mes)
        taxa = (total_periodo / pop * 100000) if pop else 0
        municipios.append({
            'nome': muni, 'pop': pop, 'vd_mes': mes, 'vd_acum': acum,
            'total_periodo': total_periodo, 'taxa_100k': taxa,
            'enderecos_reincidentes': len(enderecos_reincidentes.get(muni, [])),
        })
    ranking = [m['nome'] for m in sorted(municipios, key=lambda x: -x['taxa_100k'])]

    return {
        'panorama': {'total_mes': total_mes, 'homic_mes': homic_mes, 'tent_hom_mes': tent_mes},
        'municipios': municipios, 'ranking': ranking,
        'ocorrencias': ocorrencias, 'enderecos_reincidentes': enderecos_reincidentes,
    }


# ---------- Crimes Violentos (IMV_TOTAL ou ICVPE_TOTAL ou ICVPA_TOTAL) ----------

def build_crimes_violentos(rows, pop_by_muni, n_meses):
    seen = set()
    cv_rows = []
    for row in rows:
        if _f1(row['IMV_TOTAL']) or _f1(row['ICVPE_TOTAL']) or _f1(row['ICVPA_TOTAL']):
            r = row['NUMERO_REDS']
            if r in seen:
                continue
            seen.add(r)
            cv_rows.append(row)

    total_mes = [0] * n_meses
    by_muni = {}
    ocorrencias = {}

    for row in cv_rows:
        muni = row['MUNICIPIO'].strip().upper()
        try:
            mi = int(row['MES_NUMERICO']) - 1
        except (ValueError, KeyError):
            continue
        if mi < 0 or mi >= n_meses:
            continue
        by_muni.setdefault(muni, [0] * n_meses)
        ocorrencias.setdefault(muni, [])
        total_mes[mi] += 1
        by_muni[muni][mi] += 1

        arma = False
        try:
            arma = int(row['QTDE_ARMAS_FOGO'] or 0) > 0
        except ValueError:
            pass
        pris = False
        try:
            pris = int(row['QTDE_PRISAO'] or 0) > 0
        except ValueError:
            pass
        nat = row['DESCR_NATUREZA_PRINCIPAL'].strip().title()
        tentado = row['TENTADO_CONSUMADO_PRINCIPAL'].strip().upper() == 'TENTADO'
        if tentado and ('Homic' in nat or 'Feminic' in nat):
            nat = f'Tentativa de {nat}'

        if arma or _f1(row['IMV_TOTAL']):
            gravidade = 'critica'
        elif _f1(row['ICVPA_TOTAL']) or _f1(row['ICVPE_TOTAL']):
            gravidade = 'alta'
        else:
            gravidade = 'media'

        ocorrencias[muni].append({
            'r': row['NUMERO_REDS'], 'd': row['DATA_FATO'], 'm': mi + 1, 'n': nat,
            'b': row['BAIRRO'].strip() or row['BAIRRO_NAO_CADASTRADO'].strip(),
            'l': row['LOGRADOURO'].strip() or row['LOGRADOURO_NAO_CADASTRADO'].strip(),
            'nu': (row['NUMERO_LOGRADOURO'].strip() or row['NUMERO_LOGRADOURO_NAO_CADASTRADO'].strip() or '0'),
            'c': row['CAUSA_PRESUMIDA'].strip(), 'a': arma, 'p': pris, 'g': gravidade,
        })

    municipios = []
    for muni, mes in by_muni.items():
        acum = []
        running = 0
        for v in mes:
            running += v
            acum.append(running)
        pop = pop_by_muni.get(muni, 0)
        total_periodo = sum(mes)
        taxa = (total_periodo / pop * 100000) if pop else 0
        municipios.append({'nome': muni, 'pop': pop, 'cv_mes': mes, 'cv_acum': acum,
                            'total_periodo': total_periodo, 'taxa_100k': taxa})
    ranking = [m['nome'] for m in sorted(municipios, key=lambda x: -x['taxa_100k'])]

    return {'panorama': {'total_mes': total_mes}, 'municipios': municipios,
            'ranking': ranking, 'ocorrencias': ocorrencias}


# ---------- Preditiva por Reincidência de Endereço (janela de 60 dias) ----------

ELIGIBLE_NAT_CODES = {'B01147', 'B01129', 'B08021', 'G02024', 'C01155'}


def build_reincidencia(rows, pop_by_muni, hoje=None):
    hoje = hoje or datetime.today()

    def eligible(row):
        natcodes = [row['CODIGO_NATUREZA_PRINCIPAL'], row.get('CODIGO_NATUREZA_SECUNDARIA1', ''),
                    row.get('CODIGO_NATUREZA_SECUNDARIA2', ''), row.get('CODIGO_NATUREZA_SECUNDARIA3', '')]
        if 'U33004' in natcodes:
            return True
        if row['CODIGO_NATUREZA_PRINCIPAL'] in ELIGIBLE_NAT_CODES:
            return True
        if _f1(row['IMV_TOTAL']) or _f1(row['ICVPE_TOTAL']) or _f1(row['ICVPA_TOTAL']):
            return True
        return False

    addr_groups = {}
    for row in rows:
        if not eligible(row):
            continue
        muni = row['MUNICIPIO'].strip().upper()
        bai = (row['BAIRRO'].strip() or row['BAIRRO_NAO_CADASTRADO'].strip()).upper()
        log = (row['LOGRADOURO'].strip() or row['LOGRADOURO_NAO_CADASTRADO'].strip()).upper()
        num = (row['NUMERO_LOGRADOURO'].strip() or row['NUMERO_LOGRADOURO_NAO_CADASTRADO'].strip() or '0')
        if not log or not muni:
            continue
        try:
            dt = datetime.strptime(row['DATA_FATO'], '%d/%m/%Y')
        except ValueError:
            continue
        addr_groups.setdefault((muni, bai, log, num), []).append((dt, row))

    reincidentes = {}
    for key, evs in addr_groups.items():
        evs.sort(key=lambda x: x[0])
        if len(evs) >= 2 and any((evs[i + 1][0] - evs[i][0]).days <= 60 for i in range(len(evs) - 1)):
            reincidentes[key] = evs

    enderecos_by_muni = {}
    count_by_muni = {}
    for (muni, bai, log, num), evs in reincidentes.items():
        enderecos_by_muni.setdefault(muni, [])
        count_by_muni.setdefault(muni, 0)
        meses = sorted(set(int(row['MES_NUMERICO']) for _, row in evs if row['MES_NUMERICO'].strip().isdigit()))
        arma_fogo = any((int(row['QTDE_ARMAS_FOGO'] or 0) > 0) for _, row in evs)
        naturezas = sorted(set(row['DESCR_NATUREZA_PRINCIPAL'].strip().title() for _, row in evs))
        reds_list = [row['NUMERO_REDS'] for _, row in evs]
        intervalos = [(evs[i + 1][0] - evs[i][0]).days for i in range(len(evs) - 1)]
        intervalo_min = min(intervalos) if intervalos else None
        dias_desde_ultimo = (hoje - evs[-1][0]).days
        enderecos_by_muni[muni].append({
            'b': bai, 'l': log, 'nu': num, 'q': len(evs), 'meses': meses,
            'reds': reds_list, 'naturezas': naturezas, 'arma_fogo': arma_fogo,
            'intervalo_min_dias': intervalo_min, 'dias_desde_ultimo': dias_desde_ultimo,
        })
        count_by_muni[muni] += 1

    municipios = [{'nome': m, 'pop': pop_by_muni.get(m, 0), 'enderecos_reincidentes': count_by_muni[m]}
                  for m in count_by_muni]
    ranking = [m['nome'] for m in sorted(municipios, key=lambda x: -x['enderecos_reincidentes'])]

    return {'panorama': {'total_enderecos': sum(count_by_muni.values())},
            'municipios': municipios, 'ranking': ranking, 'enderecos': enderecos_by_muni}


# ============================================================
# GRUPO A (2026-08-21): IDOB (Qtde Operações Boemia), IDOB-vítimas
# (MV/CVPe/CVPa em bar) e Cavalo de Aço Eficácia/Eficiência.
# Historicamente processados manualmente a cada novo export; aqui
# ficam disponíveis como funções reutilizáveis pela rotina diária.
# Regra de segurança: total geral não pode cair (mesmo padrão do
# bloco 4b) — se caiu, não aplicar e sinalizar (export mais estreito).
# ============================================================

def build_idob_boemia(rows, municipios_order, n_meses):
    """rows = CSV de entrada/IDOB (RAT), filtro NOME_OPERACAO contém BOEMIA."""
    qop_total = [0] * n_meses
    by_muni = {m: [0] * n_meses for m in municipios_order}
    for r in rows:
        if 'BOEMIA' not in r.get('NOME_OPERACAO', '').upper():
            continue
        try:
            mi = int(r['MES_NUMERICO']) - 1
        except (ValueError, KeyError):
            continue
        if mi < 0 or mi >= n_meses:
            continue
        muni = r['MUNICIPIO'].strip().upper()
        if muni not in by_muni:
            by_muni[muni] = [0] * n_meses
        qop_total[mi] += 1
        by_muni[muni][mi] += 1
    return qop_total, by_muni


BAR_LOCAIS = {'BAR / LANCHONETE / RESTAURANTE / SIMILAR', 'BOATE / CASA DE SHOW / SIMILAR'}


def build_idob_vitimas(rows, municipios_order, n_meses):
    """rows = CSV de entrada/CRIMES VIOLENTOS BOEMIA (REDS).
    Filtro: DESCRICAO_LOCAL_IMEDIATO em bar/boate, soma IMV_TOTAL/ICVPE_TOTAL/ICVPA_TOTAL."""
    mv = [0] * n_meses; cvpe = [0] * n_meses; cvpa = [0] * n_meses
    by_muni = {m: {'mv': [0]*n_meses, 'cvpe': [0]*n_meses, 'cvpa': [0]*n_meses} for m in municipios_order}
    for r in rows:
        if r.get('DESCRICAO_LOCAL_IMEDIATO', '').strip() not in BAR_LOCAIS:
            continue
        try:
            mi = int(r['MES_NUMERICO']) - 1
        except (ValueError, KeyError):
            continue
        if mi < 0 or mi >= n_meses:
            continue
        muni = r['MUNICIPIO'].strip().upper()
        if muni not in by_muni:
            by_muni[muni] = {'mv': [0]*n_meses, 'cvpe': [0]*n_meses, 'cvpa': [0]*n_meses}
        try: imv = int(r.get('IMV_TOTAL') or 0)
        except ValueError: imv = 0
        try: icvpe = int(r.get('ICVPE_TOTAL') or 0)
        except ValueError: icvpe = 0
        try: icvpa = int(r.get('ICVPA_TOTAL') or 0)
        except ValueError: icvpa = 0
        mv[mi] += imv; by_muni[muni]['mv'][mi] += imv
        cvpe[mi] += icvpe; by_muni[muni]['cvpe'][mi] += icvpe
        cvpa[mi] += icvpa; by_muni[muni]['cvpa'][mi] += icvpa
    return mv, cvpe, cvpa, by_muni


def _fix_mojibake(s):
    try:
        return s.encode('latin-1').decode('utf-8')
    except (UnicodeDecodeError, UnicodeEncodeError):
        return s


def build_cavalo_eficacia(rows, municipios_order, n_meses):
    """rows = CSV de entrada/TODOS OS RAT, filtro NOME_OPERACAO contém CAVALO (Y01003).
    Retorna dict pronto pra substituir DATA.cavaloaco_eficacia['municipios'/'totais'/'naturezas_reds_geradas'].
    Campos extraídos do PRODUTIVIDADE (idIndicador:X/descricao:Y/quantidade:Z/):
      motos_fisc, veic_fisc, motos_autu, inabilitados, veic_retidos,
      veic_removidos (== "Qde de veículos para os quais foi solicitada remoção" —
      NÃO usar as categorias MOTOCICLETA/AUTOMOVEL/CICLOMOTOR-REMOVIDO, que são outra coisa),
      motofretes_fisc. Tempo mediana exclui outliers >480min (RAT esquecido aberto).
    """
    import re, statistics

    FIELDS = ['num_ops', 'efetivo_sum', 'viaturas_sum', 'reds_gerado', 'motos_fisc', 'veic_fisc',
              'motos_autu', 'inabilitados', 'veic_retidos', 'veic_removidos', 'motofretes_fisc']

    def zeros():
        return {f: [0]*n_meses for f in FIELDS} | {'tempos': {i: [] for i in range(n_meses)}}

    def parse_produtividade(s):
        out = {}
        for m in re.finditer(r'idIndicador:(\d+)/descricao:([^/]*)/quantidade:(\d+)/', s or ''):
            desc, qtd = m.group(2), int(m.group(3))
            out[desc.strip()] = out.get(desc.strip(), 0) + qtd
        return out

    totais = zeros()
    by_muni = {m: zeros() for m in municipios_order}
    nat_reds_count = {}

    for r in rows:
        if 'CAVALO' not in r.get('NOME_OPERACAO', '').upper():
            continue
        try:
            mi = int(r['MES_NUMERICO']) - 1
        except (ValueError, KeyError):
            continue
        if mi < 0 or mi >= n_meses:
            continue
        muni = r['MUNICIPIO'].strip().upper()
        if muni not in by_muni:
            by_muni[muni] = zeros()
        for tgt in (totais, by_muni[muni]):
            tgt['num_ops'][mi] += 1
            tgt['efetivo_sum'][mi] += r.get('EFETIVOS', '').count('postGrad:')
            tgt['viaturas_sum'][mi] += r.get('VIATURAS', '').count('prefixo:')
        reds_entries = [x for x in r.get('REDS_RELACIONADOS', '').split('|') if x.strip()]
        for tgt in (totais, by_muni[muni]):
            tgt['reds_gerado'][mi] += len(reds_entries)
        for entry in reds_entries:
            m = re.search(r'naturezaCodigo:([^/]*)/naturezaDescricao:([^/]*)/', entry)
            if m:
                cod, desc = m.group(1).strip(), m.group(2).strip()
                nat_reds_count.setdefault(cod, {'codigo': cod, 'descricao': _fix_mojibake(desc), 'qtd': 0})
                nat_reds_count[cod]['qtd'] += 1
        prod = parse_produtividade(r.get('PRODUTIVIDADE', ''))
        for desc, qtd in prod.items():
            du = desc.upper()
            key = None
            if 'MOTOCICLETA' in du and 'FISCALIZAD' in du: key = 'motos_fisc'
            elif 'VE' in du and 'FISCALIZAD' in du and 'MOTO' not in du: key = 'veic_fisc'
            elif 'MOTOCICLETA' in du and 'AUTUAD' in du: key = 'motos_autu'
            elif 'INABILITAD' in du: key = 'inabilitados'
            elif 'RETID' in du: key = 'veic_retidos'
            elif 'SOLICITADA' in du and 'REMO' in du: key = 'veic_removidos'
            elif 'MOTOFRETE' in du: key = 'motofretes_fisc'
            if key:
                for tgt in (totais, by_muni[muni]):
                    tgt[key][mi] += qtd
        try:
            t = int(r['OPR_TEMPO_TOTAL_MINUTOS'])
            if t <= 480:
                totais['tempos'][mi].append(t)
                by_muni[muni]['tempos'][mi].append(t)
        except (ValueError, KeyError):
            pass

    def mediana(lst):
        return round(statistics.median(lst)) if lst else 0

    municipios_final = []
    for m in municipios_order:
        bm = by_muni.get(m, zeros())
        entry = {'nome': m}
        for k in FIELDS:
            entry[k] = bm[k]
        entry['tempo_mediana_min'] = [mediana(bm['tempos'][i]) for i in range(n_meses)]
        municipios_final.append(entry)
    for m in by_muni:
        if m not in municipios_order:
            bm = by_muni[m]
            entry = {'nome': m}
            for k in FIELDS:
                entry[k] = bm[k]
            entry['tempo_mediana_min'] = [mediana(bm['tempos'][i]) for i in range(n_meses)]
            municipios_final.append(entry)

    totais_final = {k: totais[k] for k in FIELDS}
    totais_final['tempo_mediana_min'] = [mediana(totais['tempos'][i]) for i in range(n_meses)]
    naturezas_reds_geradas = sorted(nat_reds_count.values(), key=lambda x: -x['qtd'])

    return {
        'municipios': municipios_final,
        'totais': totais_final,
        'naturezas_reds_geradas': naturezas_reds_geradas,
    }


# ---------- Esforço-Furto/Prisões — automatizado a partir do TODOS OS B.O em 2026-08-28 ----------
# Antes desse indicador era editado manualmente (nunca passava por aggregate.py). Eduardo pediu pra
# automatizar: universo GERAL de furto, natureza C01155, consumado+tentado, rural+urbano — não usa
# nenhum export dedicado, só o TODOS OS B.O geral. Prisões = soma de QTDE_PRISAO nas mesmas linhas.

def build_esforco_furto(rows, municipios_order, n_meses):
    """rows = CSV de entrada/TODOS OS B.O (REDS geral).
    Filtro: CODIGO_NATUREZA_PRINCIPAL == C01155 (Furto), qualquer TENTADO_CONSUMADO, zona rural+urbana."""
    reds_mes = [0] * n_meses
    prisoes_mes = [0] * n_meses
    by_muni = {m: {'reds': [0]*n_meses, 'prisoes': [0]*n_meses} for m in municipios_order}
    for r in rows:
        if r.get('CODIGO_NATUREZA_PRINCIPAL', '').strip() != 'C01155':
            continue
        try:
            mi = int(r['MES_NUMERICO']) - 1
        except (ValueError, KeyError):
            continue
        if mi < 0 or mi >= n_meses:
            continue
        muni = r['MUNICIPIO'].strip().upper()
        if muni not in by_muni:
            by_muni[muni] = {'reds': [0]*n_meses, 'prisoes': [0]*n_meses}
        try:
            pris = int(r.get('QTDE_PRISAO') or 0)
        except ValueError:
            pris = 0
        reds_mes[mi] += 1; by_muni[muni]['reds'][mi] += 1
        prisoes_mes[mi] += pris; by_muni[muni]['prisoes'][mi] += pris
    return reds_mes, prisoes_mes, by_muni


# ---------- ITVD (Indicador de Combate ao Tráfico e Violência Relacionada às Drogas) ----------
# Automatizado a partir do TODOS OS B.O em 2026-08-28 (antes aguardava export específico que nunca
# batia com o filtro pedido). Eduardo confirmou: as ocorrências já estão todas no TODOS OS B.O.
# Universo Tráfico+Uso = naturezas de tráfico/uso/associação/financiamento de drogas (código abaixo).
# "Vítimas" do ITVD = Nº de REDS de MV+CVPe+CVPa (não soma de vítimas) cuja CAUSA_PRESUMIDA indica
# envolvimento com drogas (correção pedida por Eduardo em 2026-08-28: é contagem de REDS, não de
# vítimas — segue a mesma convenção do rótulo "REDS de MV+CVPe+CVPa" já usado no def-box da página).

ITVD_TRAFICO_CODES = {
    'I04033',  # TRAFICO ILICITO DE DROGAS
    'I04028',  # USO E CONSUMO DE DROGAS
    'U33010',  # ATENDIMENTO DE DENUNCIA DE INFRACOES ENVOLVENDO DROGAS
    'I99000',  # OUTRA INFRACAO REFERENTE A SUB. ENTORPECENTE
    'I04332',  # CULTIVO PLANTAS UTILIZADAS PREPARACAO DE DROGAS
    'I04035',  # ASSOCIACAO PARA O TRAFICO DE DROGAS
    'I04036',  # FINANCIAMENTO OU CUSTEIO DO TRAFICO DE DROGAS
}


def build_itvd(rows, municipios_order, n_meses):
    """rows = CSV de entrada/TODOS OS B.O (REDS geral).
    trafico_mes: REDS cuja natureza principal está em ITVD_TRAFICO_CODES.
    vit_mes: Nº de REDS de MV/CVPe/CVPa (IMV_TOTAL/ICVPE_TOTAL/ICVPA_TOTAL > 0) cuja CAUSA_PRESUMIDA
    contém 'DROGA' (ex.: 'ENVOLVIMENTO COM DROGAS', 'DROGA ILICITA / ENTORPECENTE)."""
    trafico_mes = [0] * n_meses
    vit_mes = [0] * n_meses
    by_muni = {m: {'trafico': [0]*n_meses, 'vit': [0]*n_meses} for m in municipios_order}
    for r in rows:
        try:
            mi = int(r['MES_NUMERICO']) - 1
        except (ValueError, KeyError):
            continue
        if mi < 0 or mi >= n_meses:
            continue
        muni = r['MUNICIPIO'].strip().upper()
        if muni not in by_muni:
            by_muni[muni] = {'trafico': [0]*n_meses, 'vit': [0]*n_meses}

        if r.get('CODIGO_NATUREZA_PRINCIPAL', '').strip() in ITVD_TRAFICO_CODES:
            trafico_mes[mi] += 1
            by_muni[muni]['trafico'][mi] += 1

        is_mv_cvpx = False
        for k in ('IMV_TOTAL', 'ICVPE_TOTAL', 'ICVPA_TOTAL'):
            try:
                if int(r.get(k) or 0) > 0:
                    is_mv_cvpx = True
                    break
            except ValueError:
                pass
        if is_mv_cvpx and 'DROGA' in r.get('CAUSA_PRESUMIDA', '').strip().upper():
            vit_mes[mi] += 1
            by_muni[muni]['vit'][mi] += 1

    return trafico_mes, vit_mes, by_muni

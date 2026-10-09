#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
leitura_csv.py — lê cada export do SiGOp na codificação REAL do arquivo.

Por quê (2026-10-09): os exports `relatorio_estatisticas_*` (TODOS OS B.O, TODOS OS RAT, MV, ...) são
UTF-8, mas o pipeline os lia como latin-1, o que quebrava os acentos de bairro/rua/natureza
("INVÁLIDO" virava "INVÃ\x81LIDO", "ACESSÓRIO" virava "AcessãRio"). Já os `relatorio (N).csv`
(Rolezinho, Padrinhos, Saque Seguro) são de fato latin-1/cp1252. Em vez de apostar num formato, olha
os bytes: UTF-8 válido -> UTF-8; senão usa o `fallback`.
"""


def codificacao_real(caminho, fallback='latin-1'):
    with open(caminho, 'rb') as f:
        dados = f.read()
    try:
        dados.decode('utf-8')
        return 'utf-8-sig'
    except UnicodeDecodeError:
        return fallback


def abrir_texto(caminho, fallback='latin-1'):
    return open(caminho, encoding=codificacao_real(caminho, fallback), newline='')


# Texto que ficou "quebrado" (UTF-8 lido como latin-1): letra acentuada vira "Ã" + caractere de controle/símbolo.
import re
_QUEBRADO = re.compile('[ÃÂãâ][\u0080-¿]')  # Ã/Â/ã/â seguido de controle ou símbolo latin-1


def parece_quebrado(s):
    return isinstance(s, str) and bool(_QUEBRADO.search(s))


def reparar_texto(s):
    """Desfaz o 'UTF-8 lido como latin-1'. Se a string já foi passada por .title() (que minusculou o
    'Ã' do par quebrado), restaura com .upper() e põe o title de volta. Se não der, devolve igual."""
    if not parece_quebrado(s):
        return s
    try:
        return s.encode('latin-1').decode('utf-8')
    except (UnicodeEncodeError, UnicodeDecodeError):
        pass
    try:
        return s.upper().encode('latin-1').decode('utf-8').title()
    except (UnicodeEncodeError, UnicodeDecodeError):
        return s


def reparar_arvore(obj):
    """Repara, no lugar, todo texto quebrado dentro de dict/list (JSON). Devolve quantos textos
    foram corrigidos. Rede de segurança: usada ao gravar o data_completo.json, pra garantir que
    entradas antigas (ex.: ocorrencias_graves, que é append-only) nunca fiquem com acento quebrado."""
    n = 0
    if isinstance(obj, dict):
        for k, v in list(obj.items()):
            if isinstance(v, str):
                if parece_quebrado(v):
                    novo = reparar_texto(v)
                    if novo != v:
                        obj[k] = novo; n += 1
            else:
                n += reparar_arvore(v)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            if isinstance(v, str):
                if parece_quebrado(v):
                    novo = reparar_texto(v)
                    if novo != v:
                        obj[i] = novo; n += 1
            else:
                n += reparar_arvore(v)
    return n

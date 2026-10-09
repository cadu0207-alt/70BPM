"""Copia os scripts do pipeline da pasta do Drive para esta pasta (espelho versionado).

Uso (na raiz do repositório):  python pipeline/sincronizar_do_drive.py
A versão que roda de verdade é a do Drive; este espelho só existe pra ter histórico no git.
"""
import filecmp, os, shutil, sys

DRIVE = r'C:\Users\cadu0\Claude\Projects\p3\DRIVE p3\11_ESTATISTICA_E_ANALISE_CRIMINAL\BASE_DADOS_70BPM'
AQUI = os.path.dirname(os.path.abspath(__file__))
ARQUIVOS = ['aggregate.py', 'aggregate_grave.py', 'driver_grave.py', 'publicar_restrito.py']

if not os.path.isdir(DRIVE):
    sys.exit('Pasta do Drive não encontrada: ' + DRIVE)

for nome in ARQUIVOS:
    origem, destino = os.path.join(DRIVE, nome), os.path.join(AQUI, nome)
    if not os.path.exists(origem):
        print('FALTA no Drive:', nome); continue
    if os.path.exists(destino) and filecmp.cmp(origem, destino, shallow=False):
        print('igual     :', nome)
    else:
        shutil.copyfile(origem, destino)
        print('atualizado:', nome)

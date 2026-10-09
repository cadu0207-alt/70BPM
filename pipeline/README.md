# Pipeline de atualização de dados (70º BPM)

Estes scripts geram o `data.json` a partir dos exports do SiGOp. Estão aqui para **ter histórico de versão** (antes só existiam na pasta do Drive, sem controle).

## Onde roda de verdade

A rotina roda na pasta do Drive `11_ESTATISTICA_E_ANALISE_CRIMINAL/BASE_DADOS_70BPM/`, porque é lá que chegam os exports (`entrada/<indicador>/*.csv`). **A cópia desta pasta é um espelho** — se alguém editar só a cópia do repositório, a rotina não muda.

Ao alterar um script no Drive, atualize o espelho e comite:

```
python pipeline/sincronizar_do_drive.py
git add pipeline && git commit -m "Atualiza pipeline"
```

## ⚠ Dados públicos x restritos (desde 09/10/2026)

O repositório e o site são **públicos**. Nº do REDS, data, bairro, **rua e número da casa** das ocorrências (violência doméstica, crimes violentos, ocorrências graves, endereços reincidentes) **não podem ir no `data.json`**. O fluxo é:

| Arquivo | Onde fica | O que tem |
|---|---|---|
| `data_completo.json` | só na pasta do Drive | tudo; é o arquivo de trabalho da rotina (o `ocorrencias_graves` é append-only e precisa do histórico) |
| `data.json` | vai pro repositório | só agregados; os blocos restritos viram `{}` |
| `data_restrito.json` | só na pasta do Drive | só os blocos restritos (conferência local) |
| Supabase `dados_restritos` | banco | os blocos restritos; **só PPVD aprovado lê** (RLS `eh_aprovado()`) |

`publicar_restrito.py` faz a separação e envia o restrito ao Supabase pela função `publicar_dados_restritos`, que exige um **token só de escrita** (o banco guarda apenas o hash). O token fica **fora do repositório e do Drive**: `~/.70bpm/pipeline_token.txt` (ou a variável `PIPELINE_TOKEN_70BPM`). Sem o token a rotina ainda gera o `data.json` público, mas avisa em `report.json → publicacao_restrita` que o restrito do Supabase ficou desatualizado.

**Trava:** `node verificar-publico.js` falha se o `data.json` tiver REDS ou campo de endereço, e um hook de `pre-commit` local o executa antes de qualquer commit do `data.json`. (Hooks não vão pro repositório: em outro computador, copie `.git/hooks/pre-commit` ou rode o verificador na mão.)

## Scripts

| Arquivo | O que faz |
|---|---|
| `aggregate.py` | 11 indicadores por município e mês (MV, CVPE, CVPa, Furto Rural, Armas, Cavalo de Aço, Rolezinho, Padrinhos, Saque Seguro, POG, PPAG). Sobrescreve célula a célula e relata quedas. |
| `aggregate_grave.py` | Funções de reconstrução completa (Análise Preditiva, Violência Doméstica, Crimes Violentos, Reincidência, ITVD, IDOB, Esforço-Furto). Só funções, não roda sozinho. |
| `driver_grave.py` | Chama as funções acima na ordem certa, aplica as proteções (Jan/Fev do IDOB preservados), sincroniza a Meta Boemia e carimba `atualizado_em`. |
| `leitura_csv.py` | Lê cada export na codificação REAL (UTF-8 vs latin-1, pelos bytes) e repara texto com acento quebrado. Os `relatorio_estatisticas_*` são UTF-8; lê-los como latin-1 gerava "INVÃLIDO". |
| `ajustes_manuais.py` | Correções aprovadas em auditoria que a fonte ainda não refletiu (ex.: MV lançado por erro de cadastro). Neutraliza o sinal de MV de um REDS e **se desliga sozinho** quando o SiGOp vier corrigido (avisa `AJUSTE RESOLVIDO` no relatório). A lista (`ajustes_manuais.json`) fica só no Drive, porque traz nº de REDS. |
| `publicar_restrito.py` | Separa público/restrito, grava os 3 arquivos e envia o restrito ao Supabase. Usado ao final de `aggregate.py` e `driver_grave.py`. |

Ordem de execução: `aggregate.py` e depois `driver_grave.py`. Ambos leem `data_completo.json` e, ao terminar, regravam `data_completo.json` + `data.json` (público) + `data_restrito.json` e enviam o restrito.

## Regras que não são óbvias

- Queda sistemática não é aplicada sem conferir no SiGOp (ver histórico de ITVD, IDOB e Padrinhos no `CONTEXTO_DASHBOARD_70BPM.md`, que fica no Drive).
- Arquivo na pasta errada é o erro mais comum: confira `n_matched` no relatório antes de aceitar (zero casos = pasta trocada).
- Se `data_completo.json` sumir, **não** rode a rotina com o `data.json` público: ela se recusa (para não apagar o histórico). Restaure de `data.json.bak_*` ou da tabela `dados_restritos`.

## O que não está aqui de propósito

- `dashboard_gen.py` — gera exatamente o `index.html` que já está no repositório; ter os dois só duplicaria 280 KB. Fica no Drive.
- Os CSV de `entrada/`, `data_completo.json`, `data_restrito.json` e o `CONTEXTO_DASHBOARD_70BPM.md` — contêm dado operacional e histórico interno; o repositório é público.

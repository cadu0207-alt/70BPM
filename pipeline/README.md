# Pipeline de atualização de dados (70º BPM)

Estes scripts geram o `data.json` a partir dos exports do SiGOp. Estão aqui para **ter histórico de versão** (antes só existiam na pasta do Drive, sem controle).

## Onde roda de verdade

A rotina roda na pasta do Drive `11_ESTATISTICA_E_ANALISE_CRIMINAL/BASE_DADOS_70BPM/`, porque é lá que chegam os exports (`entrada/<indicador>/*.csv`). **A cópia desta pasta é um espelho** — se alguém editar só a cópia do repositório, a rotina não muda.

Ao alterar um script no Drive, atualize o espelho e comite:

```
python pipeline/sincronizar_do_drive.py
git add pipeline && git commit -m "Atualiza pipeline"
```

## Scripts

| Arquivo | O que faz |
|---|---|
| `aggregate.py` | 11 indicadores por município e mês (MV, CVPE, CVPa, Furto Rural, Armas, Cavalo de Aço, Rolezinho, Padrinhos, Saque Seguro, POG, PPAG). Sobrescreve célula a célula e relata quedas. |
| `aggregate_grave.py` | Funções de reconstrução completa (Análise Preditiva, Violência Doméstica, Crimes Violentos, Reincidência, ITVD, IDOB, Esforço-Furto). Só funções, não roda sozinho. |
| `driver_grave.py` | Chama as funções acima na ordem certa, aplica as proteções (Jan/Fev do IDOB preservados), sincroniza a Meta Boemia e carimba `atualizado_em`. |

Ordem de execução: `aggregate.py` e depois `driver_grave.py`. Ambos leem e gravam o `data.json` da própria pasta.

## Regras que não são óbvias

- Queda sistemática não é aplicada sem conferir no SiGOp (ver histórico de ITVD, IDOB e Padrinhos no `CONTEXTO_DASHBOARD_70BPM.md`, que fica no Drive).
- Arquivo na pasta errada é o erro mais comum: confira `n_matched` no relatório antes de aceitar (zero casos = pasta trocada).
- `data.json` é **público** (GitHub Pages). Não coloque nesta pasta nada com dado pessoal além do que já está no site.

## O que não está aqui de propósito

- `dashboard_gen.py` — gera exatamente o `index.html` que já está no repositório; ter os dois só duplicaria 280 KB. Fica no Drive.
- Os CSV de `entrada/` e o `CONTEXTO_DASHBOARD_70BPM.md` — contêm dado operacional e histórico interno; o repositório é público.

# Testes automáticos do painel

Rodam sozinhos no GitHub a cada envio (`.github/workflows/verificar.yml`) e podem ser rodados no computador:

```
npm install        # uma vez (usa o Chrome já instalado; no GitHub baixa o Chromium)
npm test           # verificar-publico + validate-data + tests/smoke.js
```

| Verificação | O que garante |
|---|---|
| `verificar-publico.js` | `data.json` público sem nº de REDS e sem campos de endereço (o repositório é público) |
| `validate-data.js` | séries mensais coerentes: acumulado = soma dos meses, totais = soma dos municípios, datas de atualização |
| `tests/smoke.js` [1] | as 24 páginas abrem, sem erro de JavaScript |
| `tests/smoke.js` [2] | no celular (375px) nenhuma página estoura na lateral; menu em gaveta abre/fecha |
| `tests/smoke.js` [3] | visitante sem login: aviso de "detalhe restrito", nenhum REDS na tela nem na memória do navegador |
| `tests/smoke.js` [4] | pop-up diário do SiGOp: aparece, o clique libera e grava o dia, não reaparece |
| `tests/smoke.js` [5] | recarregar a aba volta para a mesma página |
| `tests/smoke.js` [6] | Home com quadro de 13 municípios e indicador de atualização calculado |

O teste é hermético: serve o próprio repositório numa porta local e bloqueia qualquer acesso externo (fontes, CDN, Supabase), então não depende de internet nem de login. **O que ele não cobre:** o fluxo com login Google real e o conteúdo restrito do Supabase (precisa de conta aprovada) — esses continuam sendo conferidos na mão.

Sempre que um bug novo for achado, vale acrescentar uma verificação aqui para ele não voltar.

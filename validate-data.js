#!/usr/bin/env node
/*
 * Validador do data.json do painel 70º BPM.
 *
 * Rodar antes de todo commit/push que mexer em data.json:
 *   node validate-data.js
 *
 * Saída:
 *   ERRO      -> problema estrutural (tamanho de array errado, JSON quebrado,
 *                nome de município duplicado). Interrompe com exit code 1 —
 *                não deveria ir pro ar assim.
 *   AVISO     -> inconsistência numérica (acumulado não bate com a soma dos
 *                meses, acumulado caiu em vez de subir). Pode ser real (ex.:
 *                correção retroativa de metodologia, como a de Violência
 *                Doméstica em 2026-08-20) ou pode ser erro de digitação —
 *                exige olhar antes de publicar, mas não bloqueia sozinho.
 *
 * O script é propositalmente genérico: ele detecta os pares "<algo>_mes" /
 * "<algo>_acum" dentro de cada município e confere a matemática sozinho, em
 * vez de descrever à mão a estrutura de cada um dos ~30 indicadores. Índices
 * sem essa estrutura (prints de Power BI, detalhados por fração, análise
 * preditiva) são listados à parte como "fora do escopo" — ainda não têm
 * série mensal auditável.
 */
const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, 'data.json');

function loadData() {
  const raw = fs.readFileSync(DATA_PATH, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error('ERRO FATAL: data.json não é um JSON válido.');
    console.error(e.message);
    process.exit(1);
  }
}

function isSeriesObject(obj) {
  return obj && typeof obj === 'object' && Array.isArray(obj.meses) && Array.isArray(obj.municipios);
}

function sumArrays(arrays, n) {
  const out = new Array(n).fill(0);
  for (const arr of arrays) {
    for (let i = 0; i < n; i++) out[i] += (typeof arr[i] === 'number' ? arr[i] : 0);
  }
  return out;
}

function checkSeries(label, obj, errors, warnings) {
  const n = obj.meses.length;
  if (n === 0) { errors.push(`${label}: "meses" está vazio`); return; }

  if (!Array.isArray(obj.municipios) || obj.municipios.length === 0) {
    errors.push(`${label}: "municipios" vazio ou ausente`);
    return;
  }

  const nomesVistos = new Set();
  const camposArray = {}; // campoName -> [arrays de cada município], pra cruzar com total_*

  obj.municipios.forEach((mun, idx) => {
    const ident = `${label} / município #${idx} (${mun.nome || 'SEM NOME'})`;
    if (!mun.nome) errors.push(`${ident}: sem campo "nome"`);
    else if (nomesVistos.has(mun.nome)) errors.push(`${label}: nome de município duplicado: "${mun.nome}"`);
    else nomesVistos.add(mun.nome);

    for (const [k, v] of Object.entries(mun)) {
      if (k === 'nome') continue;
      if (!Array.isArray(v)) continue;
      if (v.length !== n) {
        errors.push(`${ident}: campo "${k}" tem ${v.length} valores, esperado ${n} (mesma contagem de "meses")`);
      }
      (camposArray[k] = camposArray[k] || []).push(v);
    }

    // Consistência mes -> acum dentro do próprio município
    for (const k of Object.keys(mun)) {
      if (!k.endsWith('_mes')) continue;
      const acumKey = k.replace(/_mes$/, '_acum');
      const mesArr = mun[k];
      const acumArr = mun[acumKey];
      if (!Array.isArray(acumArr) || acumArr.length !== n || !Array.isArray(mesArr) || mesArr.length !== n) continue;

      let running = 0;
      for (let i = 0; i < n; i++) {
        running += (typeof mesArr[i] === 'number' ? mesArr[i] : 0);
        if (acumArr[i] !== running) {
          warnings.push(`${ident}: "${acumKey}"[${obj.meses[i]}] = ${acumArr[i]}, mas soma acumulada de "${k}" até esse mês dá ${running}`);
        }
        if (i > 0 && acumArr[i] < acumArr[i - 1]) {
          warnings.push(`${ident}: "${acumKey}" caiu de ${acumArr[i - 1]} (${obj.meses[i - 1]}) para ${acumArr[i]} (${obj.meses[i]}) — acumulado não deveria diminuir`);
        }
      }
    }
  });

  // Cruzamento com totais declarados no topo do indicador (total_*)
  for (const [totalKey, totalArr] of Object.entries(obj)) {
    if (!totalKey.startsWith('total_') || !Array.isArray(totalArr)) continue;
    if (totalArr.length !== n) {
      errors.push(`${label}: "${totalKey}" tem ${totalArr.length} valores, esperado ${n}`);
      continue;
    }
    // tenta achar o campo por-município correspondente:
    // total_mes/total_acum -> realizado_mes/realizado_acum (convenção mais comum)
    // total_<x> -> <x> (demais indicadores, ex.: total_reds_mes -> reds_mes)
    // total_qtdeop_* -> qop_* (peculiaridade do IDOB)
    const suffix = totalKey.slice('total_'.length); // ex: "mes", "meta_mes", "reds_mes", "qtdeop_mes"
    const candidatos = [suffix, suffix.replace(/^qtdeop/, 'qop')];
    if (suffix === 'mes' || suffix === 'acum') candidatos.push('realizado_' + suffix);

    const campo = candidatos.find(c => camposArray[c]);
    if (!campo) continue; // nenhum campo por-município correspondente — nada a cruzar (ex.: total_motos_mes sem breakdown por município)

    const somaCalculada = sumArrays(camposArray[campo], n);
    for (let i = 0; i < n; i++) {
      if (somaCalculada[i] !== totalArr[i]) {
        warnings.push(`${label}: "${totalKey}"[${obj.meses[i]}] = ${totalArr[i]}, mas a soma de "${campo}" de todos os municípios dá ${somaCalculada[i]}`);
      }
    }
  }
}

function main() {
  const data = loadData();
  const errors = [];
  const warnings = [];
  const foraDoEscopo = [];

  for (const [key, value] of Object.entries(data)) {
    if (isSeriesObject(value)) {
      checkSeries(key, value, errors, warnings);
      continue;
    }
    // estruturas aninhadas, ex.: ppag.y15001 / ppag.y07012 / ppag.y07014
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const subseries = Object.entries(value).filter(([, v]) => isSeriesObject(v));
      if (subseries.length > 0) {
        subseries.forEach(([subKey, subVal]) => checkSeries(`${key}.${subKey}`, subVal, errors, warnings));
        continue;
      }
    }
    foraDoEscopo.push(key);
  }

  console.log(`Indicadores verificados: ${Object.keys(data).length - foraDoEscopo.length}`);
  console.log(`Fora do escopo desta validação (sem série mensal padrão — prints, detalhados, etc.): ${foraDoEscopo.join(', ')}`);
  console.log('');

  if (warnings.length) {
    console.log(`⚠ ${warnings.length} AVISO(S) — confira antes de publicar (pode ser correção legítima, ou pode ser erro):`);
    warnings.forEach(w => console.log('  - ' + w));
    console.log('');
  }

  if (errors.length) {
    console.log(`✖ ${errors.length} ERRO(S) — estrutural, precisa corrigir antes de publicar:`);
    errors.forEach(e => console.log('  - ' + e));
    console.log('');
    console.log('RESULTADO: FALHOU');
    process.exit(1);
  }

  console.log(warnings.length ? 'RESULTADO: PASSOU COM AVISOS' : 'RESULTADO: PASSOU');
}

main();

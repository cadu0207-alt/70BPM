#!/usr/bin/env node
// Trava de segurança: o data.json é PÚBLICO (repositório + GitHub Pages). Falha (exit 1) se ele
// contiver nº de REDS ou campos de endereço — esses dados ficam só no Supabase (tabela
// `dados_restritos`, leitura apenas por PPVD aprovado). Criado em 2026-10-09 depois de achar
// 873 ocorrências de violência doméstica com rua e número da casa no arquivo público.
//
// Uso:  node verificar-publico.js [caminho/do/data.json]
// Roda automaticamente no pre-commit local (ver pipeline/README.md).
const fs = require('fs');
const arquivo = process.argv[2] || 'data.json';
const texto = fs.readFileSync(arquivo, 'utf8');
const problemas = [];

const reds = new Set(texto.match(/20\d\d-\d{9}-\d{3}/g) || []);
if (reds.size) problemas.push(`${reds.size} nº(s) de REDS no arquivo (ex.: ${[...reds][0]})`);

const CAMPOS_ENDERECO = new Set(['l', 'nu', 'logradouro', 'numero', 'endereco', 'rua', 'latitude', 'longitude']);
const achados = new Set();
(function varrer(o, caminho) {
  if (Array.isArray(o)) { o.slice(0, 50).forEach(v => varrer(v, caminho + '[]')); }
  else if (o && typeof o === 'object') {
    for (const k of Object.keys(o)) {
      if (CAMPOS_ENDERECO.has(k.toLowerCase())) achados.add(caminho + '.' + k);
      varrer(o[k], caminho + '.' + k);
    }
  }
})(JSON.parse(texto), '');
if (achados.size) problemas.push(`campo(s) de endereço: ${[...achados].slice(0, 4).join(', ')}`);

if (problemas.length) {
  console.error('✖ BLOQUEADO — ' + arquivo + ' tem dado restrito num arquivo público:');
  problemas.forEach(p => console.error('   - ' + p));
  console.error('Rode a rotina pelo pipeline (publicar_restrito.py gera o data.json público sem esses blocos).');
  process.exit(1);
}
console.log('✔ ' + arquivo + ': sem REDS e sem campos de endereço (seguro pra publicar).');

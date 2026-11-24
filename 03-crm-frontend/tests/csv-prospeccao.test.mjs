// CSV da prospecção: colunas exatas e proteção contra "CSV injection" (OWASP). Dados fictícios.
// Uso: node --test 03-crm-frontend/tests/csv-prospeccao.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { COLUNAS_CSV, celulaCsv, gerarCsv, neutralizarFormula } from "../src/lib/csv-prospeccao.ts";

const linha = (extra = {}) => ({
  cnpj: "11222333000181",
  nome: "EMPRESA EXEMPLO LTDA",
  data_distribuicao: "2026-11-10",
  polo_ativo: "UNIAO FEDERAL - FAZENDA NACIONAL",
  numero_processo: "50012345520264036182",
  tribunal: "TRF3",
  valor_causa: 1250000.5,
  classe: "Execução Fiscal",
  telefone: "(11) 3456-7890",
  email: "contato@exemplo.com.br",
  ...extra,
});

/** Lê o CSV gerado (RFC 4180, separador ;) de volta em linhas e células. */
function ler(csv) {
  const linhas = [];
  let linhaAtual = [];
  let celula = "";
  let aspas = false;
  const s = csv.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (aspas) {
      if (c === '"' && s[i + 1] === '"') { celula += '"'; i++; }
      else if (c === '"') aspas = false;
      else celula += c;
    } else if (c === '"') aspas = true;
    else if (c === ";") { linhaAtual.push(celula); celula = ""; }
    else if (c === "\r" && s[i + 1] === "\n") { linhaAtual.push(celula); linhas.push(linhaAtual); linhaAtual = []; celula = ""; i++; }
    else celula += c;
  }
  return linhas;
}

test("colunas exatamente como pedidas, BOM UTF-8 e CRLF", () => {
  const csv = gerarCsv([linha()]);
  assert.ok(csv.startsWith("﻿"));
  const [cab, l1] = ler(csv);
  assert.deepEqual(cab, ["CPF/CNPJ", "nome", "data da distribuição", "polo ativo", "número do processo",
    "tribunal", "valor da causa", "classe", "telefone", "e-mail"]);
  assert.deepEqual(cab, [...COLUNAS_CSV]);
  assert.deepEqual(l1, ["11.222.333/0001-81", "EMPRESA EXEMPLO LTDA", "10/11/2026", "UNIAO FEDERAL - FAZENDA NACIONAL",
    "5001234-55.2026.4.03.6182", "TRF3", "1250000,50", "Execução Fiscal", "(11) 3456-7890", "contato@exemplo.com.br"]);
});

test("CSV injection: nenhuma célula começa com = + - @ TAB ou CR depois de aberta na planilha", () => {
  const ataques = ["=HYPERLINK(\"http://x\",\"clique\")", "+1+1", "-2+3", "@SUM(A1)", "\t=1+1", "\r=1+1",
    "   =cmd|' /C calc'!A0", "\n=1", "=1;=2", '=1"";=2'];
  const csv = gerarCsv(ataques.map((nome) => linha({ nome, polo_ativo: nome, classe: nome, email: nome })));
  const linhas = ler(csv).slice(1);
  assert.equal(linhas.length, ataques.length, "separador ou quebra de linha não criaram linhas/colunas extras");
  for (const l of linhas) {
    assert.equal(l.length, COLUNAS_CSV.length, "número de colunas preservado");
    for (const c of l) assert.ok(!/^[=+\-@\t\r]/.test(c), `célula perigosa: ${JSON.stringify(c)}`);
  }
  assert.equal(neutralizarFormula("=1"), "'=1");
  assert.equal(neutralizarFormula("EMPRESA"), "EMPRESA");
});

test("célula: aspas escapadas e quebras de linha removidas", () => {
  assert.equal(celulaCsv('EMPRESA "X" LTDA'), '"EMPRESA ""X"" LTDA"');
  assert.equal(celulaCsv("A;B"), '"A;B"');
  assert.equal(celulaCsv("linha1\r\nlinha2"), '"linha1 linha2"');
  assert.equal(celulaCsv("simples"), "simples");
});

test("valor inválido não vira texto estranho; campos nulos ficam vazios", () => {
  const [, l] = ler(gerarCsv([linha({ valor_causa: Number.NaN, telefone: null, email: null, data_distribuicao: null, numero_processo: null })]));
  assert.deepEqual([l[2], l[4], l[6], l[8], l[9]], ["", "", "", "", ""]);
});

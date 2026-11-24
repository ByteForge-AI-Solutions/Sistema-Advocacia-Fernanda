/**
 * CSV da prospecção (funções puras, sem dependências: testadas em tests/csv-prospeccao.test.mjs).
 * Separador ";" e decimal com vírgula para abrir direto no Excel em português; BOM UTF-8 e CRLF.
 */

/** Colunas pedidas pelos advogados, nesta ordem e com estes nomes. */
export const COLUNAS_CSV = [
  "CPF/CNPJ",
  "nome",
  "data da distribuição",
  "polo ativo",
  "número do processo",
  "tribunal",
  "valor da causa",
  "classe",
  "telefone",
  "e-mail",
] as const;
const SEPARADOR = ";";

/** Campos de uma linha da lista usados no CSV (Oportunidade é compatível). */
export interface LinhaCsv {
  cnpj: string;
  nome: string | null;
  data_distribuicao: string | null;
  polo_ativo: string | null;
  numero_processo: string | null;
  tribunal: string | null;
  valor_causa: number;
  classe: string | null;
  telefone: string | null;
  email: string | null;
}

export function formatarCnpj(d: string): string {
  return /^\d{14}$/.test(d) ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5") : d;
}
export function formatarCnj(d: string | null): string {
  return d && /^\d{20}$/.test(d) ? d.replace(/^(\d{7})(\d{2})(\d{4})(\d)(\d{2})(\d{4})$/, "$1-$2.$3.$4.$5.$6") : (d ?? "");
}
export function formatarData(iso: string | null): string {
  return iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "";
}

/**
 * Anti "CSV injection" (OWASP): célula que começa com = + - @ TAB ou CR vira texto no
 * Excel/Sheets (prefixo '), senão o nome de uma empresa poderia virar fórmula.
 */
export function neutralizarFormula(valor: string): string {
  return /^[=+\-@\t\r]/.test(valor) ? `'${valor}` : valor;
}

/**
 * Uma célula: quebras de linha viram espaço, espaços nas pontas saem (inclusive os que
 * esconderiam um "=" no início) e a fórmula é neutralizada. Aspas quando há separador, aspas
 * ou alteração (RFC 4180).
 */
export function celulaCsv(valor: string): string {
  const v = neutralizarFormula(valor.replace(/[\r\n]+/g, " ").trim());
  return /[";\n]/.test(v) || v !== valor ? `"${v.replace(/"/g, '""')}"` : v;
}

export function gerarCsv(linhas: LinhaCsv[]): string {
  const valor = (n: number) => (Number.isFinite(n) ? n.toFixed(2).replace(".", ",") : "");
  const corpo = linhas.map((o) =>
    [
      formatarCnpj(o.cnpj),
      o.nome ?? "",
      formatarData(o.data_distribuicao),
      o.polo_ativo ?? "",
      formatarCnj(o.numero_processo),
      o.tribunal ?? "",
      valor(o.valor_causa),
      o.classe ?? "",
      o.telefone ?? "",
      o.email ?? "",
    ]
      .map(celulaCsv)
      .join(SEPARADOR),
  );
  return "﻿" + [COLUNAS_CSV.join(SEPARADOR), ...corpo].join("\r\n") + "\r\n";
}

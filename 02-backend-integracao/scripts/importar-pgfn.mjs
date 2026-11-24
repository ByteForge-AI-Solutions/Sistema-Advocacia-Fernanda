#!/usr/bin/env node
// Dias & Fernandes | Importador dos Dados Abertos da PGFN (dívida ativa da União) | v11
//
// Lê os CSVs do "Sistema Não Previdenciário" publicados pela PGFN (dadosabertos.pgfn.gov.br,
// um ZIP por trimestre; descompacte antes), agrega por CNPJ e grava em
// public.prosp_pgfn_devedores. Só PESSOA JURÍDICA (CPF é descartado na leitura, LGPD) e só
// UFs da jurisdição do TRF1, TRF3 e TRF4. Roda na máquina do escritório, fora do navegador.
//
// Uso:
//   node importar-pgfn.mjs --base=2026T3 --dry-run arquivo1.csv arquivo2.csv ...
//   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=<chave secreta> \
//     node --max-old-space-size=4096 importar-pgfn.mjs --base=2026T3 [--minimo=100000] [--limpar-antigos] arquivos.csv
//
// A chave secreta vem SÓ de variável de ambiente (nunca por argumento, para não ficar no
// histórico do terminal). Nenhum CNPJ, nome ou valor é impresso: só contagens.
import fs from "node:fs";
import readline from "node:readline";

const UFS = new Set(["AC", "AM", "AP", "BA", "DF", "GO", "MA", "MT", "PA", "PI", "RO", "RR", "TO", "SP", "MS", "PR", "RS", "SC"]);

const args = process.argv.slice(2);
const opcao = (nome) => args.find((a) => a.startsWith(`--${nome}=`))?.split("=")[1];
const arquivos = args.filter((a) => !a.startsWith("--"));
const base = opcao("base");
const minimo = Number(opcao("minimo") ?? 100000);
const simular = args.includes("--dry-run");
const limparAntigos = args.includes("--limpar-antigos");

if (!base || !/^\d{4}T[1-4]$/.test(base) || !arquivos.length || !Number.isFinite(minimo)) {
  console.error("Uso: node importar-pgfn.mjs --base=AAAAT<1-4> [--minimo=100000] [--dry-run] [--limpar-antigos] arquivo.csv ...");
  process.exit(2);
}

function cnpjValido(d) {
  if (!/^\d{14}$/.test(d) || /^(\d)\1{13}$/.test(d)) return false;
  const dv = (b) => {
    const pesos = b.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const r = pesos.reduce((s, p, i) => s + p * Number(b[i]), 0) % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = dv(d.slice(0, 12));
  return d.endsWith(`${d1}${dv(d.slice(0, 12) + d1)}`);
}

/** "1234.56" ou "1.234,56" → número. */
function valor(v) {
  const t = String(v ?? "").trim();
  const n = Number(t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** CSV com ";" e aspas opcionais (formato da PGFN). */
function campos(linha) {
  const out = [];
  let atual = "";
  let aspas = false;
  for (let i = 0; i < linha.length; i++) {
    const c = linha[i];
    if (c === '"') {
      if (aspas && linha[i + 1] === '"') { atual += '"'; i++; } else aspas = !aspas;
    } else if (c === ";" && !aspas) { out.push(atual); atual = ""; } else atual += c;
  }
  out.push(atual);
  return out;
}

// Agregado compacto por CNPJ: [ajuizado, naoAjuizado, qtd] + nome/UF da maior inscrição.
const agregado = new Map();
let linhas = 0;
let descartadasPf = 0;
let descartadasMei = 0;
// MEI/empresário individual: a Receita põe o CPF do titular na razão social (pessoa física, LGPD).
const CPF_NO_NOME = /\d{3}\.\d{3}\.\d{3}-\d{2}|(?<!\d)\d{11}(?!\d)/;
for (const arquivo of arquivos) {
  // Os arquivos da PGFN vêm em ISO-8859-1 (latin1).
  const leitor = readline.createInterface({ input: fs.createReadStream(arquivo, { encoding: "latin1" }), crlfDelay: Infinity });
  let idx = null;
  for await (const linha of leitor) {
    if (!linha.trim()) continue;
    const c = campos(linha);
    if (!idx) {
      const cab = c.map((h) => h.trim().toUpperCase());
      idx = Object.fromEntries(["CPF_CNPJ", "TIPO_PESSOA", "NOME_DEVEDOR", "UF_DEVEDOR", "INDICADOR_AJUIZADO", "VALOR_CONSOLIDADO"]
        .map((k) => [k, cab.indexOf(k)]));
      if (Object.values(idx).some((i) => i < 0)) {
        console.error(`Cabeçalho inesperado em ${arquivo}: confira se é o CSV "Não Previdenciário" da PGFN.`);
        process.exit(1);
      }
      continue;
    }
    linhas++;
    if (!/jur/i.test(c[idx.TIPO_PESSOA] ?? "")) { descartadasPf++; continue; }
    if (CPF_NO_NOME.test(String(c[idx.NOME_DEVEDOR] ?? ""))) { descartadasMei++; continue; }
    const cnpj = String(c[idx.CPF_CNPJ] ?? "").replace(/\D/g, "");
    const uf = String(c[idx.UF_DEVEDOR] ?? "").trim().toUpperCase();
    if (!cnpjValido(cnpj) || !UFS.has(uf)) continue;
    const v = valor(c[idx.VALOR_CONSOLIDADO]);
    const ajuizado = /^s/i.test(String(c[idx.INDICADOR_AJUIZADO] ?? "").trim());
    let a = agregado.get(cnpj);
    if (!a) {
      a = { aj: 0, naj: 0, qtd: 0, nome: "", uf, maior: -1 };
      agregado.set(cnpj, a);
    }
    if (ajuizado) a.aj += v; else a.naj += v;
    a.qtd++;
    if (v > a.maior) {
      a.maior = v;
      a.uf = uf;
      a.nome = String(c[idx.NOME_DEVEDOR] ?? "").trim().slice(0, 200);
    }
  }
}

const centavos = (n) => Math.round(n * 100) / 100;
const selecionados = [...agregado.entries()]
  .filter(([, a]) => a.aj + a.naj > minimo && a.nome)
  .map(([cnpj, a]) => ({
    cnpj, nome: a.nome, uf: a.uf, valor_ajuizado: centavos(a.aj), valor_nao_ajuizado: centavos(a.naj),
    qtd_inscricoes: a.qtd, base_referencia: base, importado_em: new Date().toISOString(),
  }));
console.log(`Linhas lidas: ${linhas} | pessoa física descartada: ${descartadasPf} | MEI (CPF no nome) descartado: ${descartadasMei} | CNPJs (TRF1/3/4): ${agregado.size} | acima de R$ ${minimo}: ${selecionados.length}`);
if (simular) process.exit(0);

const url = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
const chave = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url.startsWith("https://") || !chave) {
  console.error("Defina SUPABASE_URL (https) e SUPABASE_SERVICE_ROLE_KEY no ambiente.");
  process.exit(2);
}
const cabecalhos = { apikey: chave, Authorization: `Bearer ${chave}`, "content-type": "application/json" };
for (let i = 0; i < selecionados.length; i += 500) {
  const r = await fetch(`${url}/rest/v1/prosp_pgfn_devedores?on_conflict=cnpj`, {
    method: "POST",
    headers: { ...cabecalhos, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(selecionados.slice(i, i + 500)),
  });
  if (!r.ok) {
    console.error(`Falha ao gravar o lote ${i / 500 + 1}: HTTP ${r.status}`);
    process.exit(1);
  }
  process.stdout.write(`\rGravados: ${Math.min(i + 500, selecionados.length)}/${selecionados.length}`);
}
console.log("");
if (limparAntigos) {
  const r = await fetch(`${url}/rest/v1/prosp_pgfn_devedores?base_referencia=neq.${encodeURIComponent(base)}`, {
    method: "DELETE", headers: { ...cabecalhos, Prefer: "return=minimal" },
  });
  console.log(r.ok ? "Registros de bases anteriores removidos." : `Falha ao limpar bases anteriores: HTTP ${r.status}`);
}

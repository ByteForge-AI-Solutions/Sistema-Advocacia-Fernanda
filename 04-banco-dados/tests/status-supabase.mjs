// Diagnóstico SÓ DE LEITURA do projeto Supabase com a chave pública (anon), sem imprimir chaves.
// Uso (na raiz do repositório): node 04-banco-dados/tests/status-supabase.mjs
// Lê NEXT_PUBLIC_SUPABASE_URL e NEXT_PUBLIC_SUPABASE_ANON_KEY de 03-crm-frontend/.env.local.
// Tabela/coluna: PGRST205/42P01 = não existe; 42703 = coluna não existe; 42501 = existe e anon sem privilégio;
// 200 [] = existe e anon com privilégio (RLS filtrando). RPC: PGRST202 = não existe; 42501 = existe.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ENV_PADRAO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../03-crm-frontend/.env.local");

const env = Object.fromEntries(
  fs.readFileSync(process.argv[2] ?? ENV_PADRAO, "utf8").split(/\r?\n/).filter((l) => l.includes("=")).map((l) => {
    const i = l.indexOf("=");
    return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")];
  }),
);
const URL_BASE = env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/$/, "");
const KEY = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
console.log("Projeto (ref):", new URL(URL_BASE).hostname.split(".")[0]);

async function tabela(rota) {
  const r = await fetch(`${URL_BASE}/rest/v1/${rota}${rota.includes("?") ? "&" : "?"}limit=0`, { headers: H });
  const corpo = await r.text();
  let code = "";
  try { code = JSON.parse(corpo).code ?? ""; } catch { /* lista vazia */ }
  return r.ok ? "200" : code || String(r.status);
}
async function rpc(nome, args = {}) {
  // PostgREST localiza a função pelos NOMES dos parâmetros: sem eles, devolve PGRST202 mesmo existindo.
  const r = await fetch(`${URL_BASE}/rest/v1/rpc/${nome}`, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify(args) });
  let code = "";
  try { code = JSON.parse(await r.text()).code ?? ""; } catch { /* sem corpo */ }
  return r.ok ? "200" : code || String(r.status);
}
const existe = (c) => !["PGRST205", "42P01", "42703", "PGRST202", "404"].includes(c);

const itens = [
  ["bot v2.1", "tabela dfu_atendimentos", () => tabela("dfu_atendimentos?select=telefone")],
  ["v3", "rpc crm_indicadores", () => rpc("crm_indicadores", { p_inicio: "2026-01-01T00:00:00Z", p_fim: "2026-01-02T00:00:00Z" })],
  ["v4", "rpc crm_ficha_assumir", () => rpc("crm_ficha_assumir", { p_ficha: "00000000-0000-0000-0000-000000000000" })],
  ["v5", "coluna fichas_clientes.proxima_acao", () => tabela("fichas_clientes?select=proxima_acao")],
  ["v6", "coluna fichas_clientes.etapa_funil", () => tabela("fichas_clientes?select=etapa_funil")],
  ["v7", "tabela clientes_cadastro", () => tabela("clientes_cadastro?select=ficha_id")],
  ["v7", "tabela fin_contratos", () => tabela("fin_contratos?select=id")],
  ["v7", "rpc crm_fin_criar_contrato", () => rpc("crm_fin_criar_contrato", { p_ficha: "00000000-0000-0000-0000-000000000000", p_advogado: "00000000-0000-0000-0000-000000000000", p_tipo: "x", p_descricao: "x", p_valor_total: 1, p_forma: "a_vista", p_percentual: null, p_observacoes: null, p_parcelas: [] })],
  ["v6", "rpc crm_indicadores_funil", () => rpc("crm_indicadores_funil", { p_inicio: "2026-01-01T00:00:00Z", p_fim: "2026-01-02T00:00:00Z" })],
  ["v8", "rpc crm_cargo_atual", () => rpc("crm_cargo_atual")],
];
const status = {};
for (const [versao, desc, f] of itens) {
  const c = await f();
  status[versao] = (status[versao] ?? true) && existe(c);
  console.log(`${versao.padEnd(8)} ${desc.padEnd(40)} ${existe(c) ? "APLICADA" : "FALTA"}  (${c})`);
}
// v9: tira da anon todo privilégio em fichas_clientes. Antes da v9: 200 []; depois: 42501.
const c9 = await tabela("fichas_clientes?select=id");
console.log(`${"v9".padEnd(8)} ${"anon sem privilégio em fichas_clientes".padEnd(40)} ${c9 === "42501" ? "APLICADA" : "FALTA"}  (${c9})`);

for (const fn of ["meta-webhook", "google-calendar-webhook"]) {
  const r = await fetch(`${URL_BASE}/functions/v1/${fn}`, { method: "GET" });
  const t = (await r.text()).slice(0, 60).replace(/\s+/g, " ");
  const estado = r.status === 404 ? "NÃO PUBLICADA" : r.status === 401 ? "PUBLICADA COM JWT OBRIGATÓRIO (errado)" : "PUBLICADA";
  console.log(`edge     ${fn.padEnd(40)} ${estado}  (HTTP ${r.status}: ${t})`);
}

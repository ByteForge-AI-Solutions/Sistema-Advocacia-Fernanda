// Testes das regras puras e da allowlist anti-SSRF da prospecção (sem rede).
// Uso (Node 22.6+ com remoção de tipos): node --test 02-backend-integracao/supabase/functions/prospeccao-execucoes/regras.test.ts
// Dados fictícios: CNPJs de exemplo de documentação (11.222.333/0001-81) e números CNJ gerados.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classificar,
  cnpjValido,
  dataDataJud,
  ehFazendaNacional,
  extrairPartesDjen,
  formatarTelefone,
  lerPublicacao,
  lerValorBR,
  numeroCnjValido,
  tribunalDoCnj,
  validarPedido,
} from "./regras.ts";
import { consultaDataJud, urlPermitida } from "./fontes.ts";

/** Gera um número CNJ válido (DV módulo 97) para os testes. */
function cnj(seq: string, ano: string, tr: string, origem: string): string {
  const base = BigInt(`${seq}${ano}4${tr}${origem}00`);
  const dv = String(98n - (base % 97n)).padStart(2, "0");
  return `${seq}${dv}${ano}4${tr}${origem}`;
}

test("CNPJ: dígitos verificadores; CPF e sequências repetidas são recusados", () => {
  assert.equal(cnpjValido("11222333000181"), true);
  assert.equal(cnpjValido("11222333000182"), false);
  assert.equal(cnpjValido("00000000000000"), false);
  assert.equal(cnpjValido("52998224725"), false); // CPF (11 dígitos) nunca passa
});

test("número CNJ e tribunal", () => {
  const n = cnj("5001234", "2026", "04", "7000");
  assert.equal(numeroCnjValido(n), true);
  assert.equal(numeroCnjValido(n.slice(0, 19) + ((Number(n[19]) + 1) % 10)), false);
  assert.equal(tribunalDoCnj(n), "TRF4");
  assert.equal(tribunalDoCnj(cnj("0000227", "2026", "03", "6202")), "TRF3");
  assert.equal(tribunalDoCnj(cnj("0000227", "2026", "05", "8100")), null);
});

test("Fazenda Nacional: grafias oficiais aceitas; União Federal sozinha e autarquias, não", () => {
  for (const p of ["FAZENDA NACIONAL", "UNIÃO - FAZENDA NACIONAL", "UNIAO FEDERAL (FAZENDA NACIONAL)",
    "Procuradoria-Geral da Fazenda Nacional", "PGFN", "União Federal - Fazenda Nacional"]) {
    assert.equal(ehFazendaNacional(p), true, p);
  }
  for (const p of ["UNIÃO FEDERAL", "INSTITUTO NACIONAL DO SEGURO SOCIAL - INSS", "CONSELHO REGIONAL DE CONTABILIDADE",
    "FAZENDA PÚBLICA DO ESTADO DE SÃO PAULO", "", null]) {
    assert.equal(ehFazendaNacional(p), false, String(p));
  }
});

test("datas do DataJud nos dois formatos", () => {
  assert.equal(dataDataJud("20261103000000"), "2026-11-03");
  assert.equal(dataDataJud("2026-11-03T00:00:00.000Z"), "2026-11-03");
  assert.equal(dataDataJud("20261340000000"), null);
  assert.equal(dataDataJud(20261103), null);
});

test("valor em formato brasileiro", () => {
  assert.equal(lerValorBR("1.234.567,89"), 1234567.89);
  assert.equal(lerValorBR("150.000,00"), 150000);
});

test("publicação PJe: polo ativo, executado, CNPJ e valor", () => {
  const p = lerPublicacao({
    texto: "PODER JUDICIÁRIO 1ª Vara Federal EXECUÇÃO FISCAL (1116) Nº 5001234-55.2026.4.03.6182 " +
      "EXEQUENTE: UNIAO FEDERAL - FAZENDA NACIONAL EXECUTADO: EMPRESA EXEMPLO LTDA - CNPJ: 11.222.333/0001-81 " +
      "Advogado do(a) EXECUTADO: FULANO - SP000000 Valor da causa: R$ 1.250.000,00 DESPACHO Cite-se.",
  });
  assert.equal(p.poloAtivoFazenda, true);
  assert.equal(p.poloAtivo, "UNIAO FEDERAL - FAZENDA NACIONAL");
  assert.equal(p.executado, "EMPRESA EXEMPLO LTDA");
  assert.equal(p.cnpj, "11222333000181");
  assert.equal(p.valorCausa, 1250000);
});

test("publicação eproc com parênteses no polo ativo e CNPJ da PGFN no texto", () => {
  const p = lerPublicacao({
    texto: "EXECUÇÃO FISCAL Nº 5000001-00.2026.4.04.7000/PR EXEQUENTE: UNIÃO FEDERAL (FAZENDA NACIONAL) (CNPJ 00.394.460/0001-41) " +
      "EXECUTADO: INDUSTRIA MODELO S/A ADVOGADO(A): BELTRANO. Ato ordinatório.",
  });
  assert.equal(p.poloAtivoFazenda, true);
  assert.equal(p.cnpj, null, "CNPJ da União nunca vira executado");
  assert.equal(p.executado, "INDUSTRIA MODELO S/A");
});

test("pessoa física: sem CNPJ, nada é qualificado", () => {
  const partes = extrairPartesDjen([{ texto: "EXEQUENTE: FAZENDA NACIONAL EXECUTADO: JOSE DA SILVA CPF: 529.982.247-25 Intime-se." }]);
  assert.equal(partes?.cnpj, null);
  assert.equal(classificar(partes), "sem_cnpj");
});

test("classificação", () => {
  assert.equal(classificar(null), "sem_publicacao");
  assert.equal(classificar({ poloAtivo: "CONSELHO REGIONAL DE MEDICINA", poloAtivoFazenda: false, executado: "X", cnpj: "11222333000181", valorCausa: null, pessoaFisica: false }), "fora_do_filtro");
  assert.equal(classificar({ poloAtivo: "FAZENDA NACIONAL", poloAtivoFazenda: true, executado: "X", cnpj: "11222333000181", valorCausa: null, pessoaFisica: false }), "qualificado");
});

test("várias publicações: a mais recente vence, campos faltantes vêm das antigas", () => {
  const partes = extrairPartesDjen([
    { data_disponibilizacao: "2026-11-01", texto: "EXEQUENTE: FAZENDA NACIONAL EXECUTADO: EMPRESA EXEMPLO LTDA CNPJ 11222333000181 Valor da causa: R$ 300.000,00 Cite-se" },
    { data_disponibilizacao: "2026-11-20", texto: "Intimação sem cabeçalho de partes." , destinatarios: [{ nome: "EMPRESA EXEMPLO LTDA", polo: "P" }] },
  ]);
  assert.equal(partes?.cnpj, "11222333000181");
  assert.equal(partes?.valorCausa, 300000);
  assert.equal(partes?.poloAtivoFazenda, true);
});

test("telefone da base CNPJ", () => {
  assert.equal(formatarTelefone("1134567890"), "(11) 3456-7890");
  assert.equal(formatarTelefone("11934567890"), "(11) 93456-7890");
  assert.equal(formatarTelefone("123"), null);
});

test("pedido: campos estritos, janela e tribunais", () => {
  const hoje = new Date("2026-11-23T12:00:00Z");
  assert.deepEqual(validarPedido({ acao: "buscar", tribunais: ["TRF1", "TRF3"], de: "2026-11-01", ate: "2026-11-20" }, hoje),
    { acao: "buscar", tribunais: ["TRF1", "TRF3"], de: "2026-11-01", ate: "2026-11-20", limite: 200 });
  assert.ok("erro" in validarPedido({ acao: "buscar", tribunais: ["TRF5"], de: "2026-11-01", ate: "2026-11-20" }, hoje));
  assert.ok("erro" in validarPedido({ acao: "buscar", tribunais: ["TRF1"], de: "2026-01-01", ate: "2026-11-20" }, hoje), "janela > 31 dias");
  assert.ok("erro" in validarPedido({ acao: "buscar", tribunais: ["TRF1"], de: "2026-11-01", ate: "2026-12-20" }, hoje), "futuro");
  assert.ok("erro" in validarPedido({ acao: "buscar", tribunais: ["TRF1"], de: "2026-11-01", ate: "2026-11-20", url: "http://169.254.169.254" }, hoje), "campo extra");
  assert.ok("erro" in validarPedido({ acao: "buscar", tribunais: ["TRF1"], de: "2026-11-01", ate: "2026-11-20", limite: 10_000 }, hoje));
  assert.deepEqual(validarPedido({ acao: "processar" }, hoje), { acao: "processar" });
  assert.ok("erro" in validarPedido({ acao: "processar", tribunal: "x" }, hoje));
  assert.ok("erro" in validarPedido([], hoje));
});

test("anti-SSRF: só HTTPS e só hosts da lista", () => {
  assert.ok(urlPermitida("https://comunicaapi.pje.jus.br/api/v1/comunicacao?numeroProcesso=1"));
  assert.ok(urlPermitida("https://api-publica.datajud.cnj.jus.br/api_publica_trf1/_search"));
  for (const u of ["http://comunicaapi.pje.jus.br/x", "https://169.254.169.254/latest/meta-data", "https://localhost/x",
    "https://comunicaapi.pje.jus.br.evil.com/x", "https://user:senha@minhareceita.org/x", "https://minhareceita.org:8443/x",
    "file:///etc/passwd", "nada"]) {
    assert.equal(urlPermitida(u), null, u);
  }
});

test("consulta DataJud: classe 1116 e janela nos dois formatos de data", () => {
  const q = consultaDataJud("2026-11-01", "2026-11-20", 100) as { query: { bool: { filter: unknown[] } } };
  const s = JSON.stringify(q);
  assert.match(s, /"classe.codigo":1116/);
  assert.match(s, /"gte":20261101000000/);
  assert.match(s, /"lte":20261120235959/);
  assert.match(s, /2026-11-01T00:00:00/);
});

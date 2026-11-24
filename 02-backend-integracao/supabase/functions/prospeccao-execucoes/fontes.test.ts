// Testes dos adaptadores (DataJud, DJEN, base CNPJ) com fetch SIMULADO (sem rede) e das regras
// de MEI, classificação de respostas e prazo. Dados fictícios.
// Uso: node --test 02-backend-integracao/supabase/functions/prospeccao-execucoes/fontes.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { classificar, classificarRespostaDataJud, lerPublicacao, pareceEmpresarioIndividual, tempoRestante } from "./regras.ts";
import { ChaveRecusada, FonteIndisponivel, fonteDataJud, fonteDjen, fonteMinhaReceita, lerPaginaDataJud, minimizar } from "./fontes.ts";
import type { ProcessoEncontrado } from "./fontes.ts";

/** Gera um número CNJ válido (DV módulo 97). */
function cnj(seq: string, ano: string, tr: string, origem: string): string {
  const base = BigInt(`${seq}${ano}4${tr}${origem}00`);
  const dv = String(98n - (base % 97n)).padStart(2, "0");
  return `${seq}${dv}${ano}4${tr}${origem}`;
}

test("MEI/empresário individual: CPF no nome tira o processo da lista e não grava nome nem CNPJ", () => {
  assert.equal(pareceEmpresarioIndividual("FULANO DE TAL 52998224725"), true);
  assert.equal(pareceEmpresarioIndividual("FULANO DE TAL - 529.982.247-25"), true);
  assert.equal(pareceEmpresarioIndividual("EMPRESA EXEMPLO LTDA"), false);
  assert.equal(pareceEmpresarioIndividual("EMPRESA 11222333000181"), false, "CNPJ (14 dígitos) não é CPF");
  const p = lerPublicacao({ texto: "EXEQUENTE: FAZENDA NACIONAL EXECUTADO: FULANO DE TAL 52998224725 CNPJ: 11.222.333/0001-81 Cite-se." });
  assert.equal(p.pessoaFisica, true);
  assert.equal(p.cnpj, null);
  assert.equal(p.executado, null);
  assert.equal(classificar(p), "fora_do_filtro");
});

test("base CNPJ: natureza 2135 ou CPF na razão social apaga nome e contato (LGPD)", () => {
  const base = { nomeFantasia: null, situacaoCadastral: "ATIVA", uf: "SP", municipio: "SAO PAULO", telefones: ["(11) 3456-7890"], email: "a@b.com.br" };
  const mei = minimizar({ ...base, razaoSocial: "FULANO DE TAL 52998224725", naturezaJuridica: "2135" });
  assert.deepEqual([mei.razaoSocial, mei.telefones, mei.email, mei.naturezaJuridica], [null, [], null, "2135"]);
  const semNatureza = minimizar({ ...base, razaoSocial: "FULANO DE TAL 52998224725", naturezaJuridica: null });
  assert.equal(semNatureza.naturezaJuridica, "2135", "CPF no nome marca como empresário individual");
  const ltda = minimizar({ ...base, razaoSocial: "EMPRESA EXEMPLO LTDA", naturezaJuridica: "2062" });
  assert.equal(ltda.email, "a@b.com.br");
});

// Corpo real devolvido pelo DataJud em 24/11/2026 (HTTP 429), resumido.
const SOBRECARGA_REAL = {
  error: {
    root_cause: [{ type: "es_rejected_execution_exception", reason: "rejected execution of TimedRunnable ... queue capacity = 1000" }],
    type: "search_phase_execution_exception",
    phase: "fetch",
  },
};

test("DataJud: classificação das respostas (chave, sobrecarga real, erro, ok)", () => {
  assert.equal(classificarRespostaDataJud(401, { error: "unauthorized" }), "chave_invalida");
  assert.equal(classificarRespostaDataJud(403, null), "chave_invalida");
  assert.equal(classificarRespostaDataJud(429, SOBRECARGA_REAL), "sobrecarga");
  assert.equal(classificarRespostaDataJud(200, SOBRECARGA_REAL), "sobrecarga", "rejeição no corpo mesmo com HTTP 200");
  assert.equal(classificarRespostaDataJud(503, null), "sobrecarga");
  assert.equal(classificarRespostaDataJud(400, { error: { type: "parsing_exception" } }), "erro");
  assert.equal(classificarRespostaDataJud(200, { hits: { hits: [] } }), "ok");
});

test("prazo: chamada externa nunca passa do fim da execução", () => {
  assert.equal(tempoRestante(1_050_000, 20_000, 3_000, 1_000_000), 20_000);
  assert.equal(tempoRestante(1_008_000, 20_000, 3_000, 1_000_000), 8_000);
  assert.equal(tempoRestante(995_000, 20_000, 3_000, 1_000_000), 3_000);
  // Regressão (auditoria 24/11/2026): prazo fracionário fazia AbortSignal.timeout lançar RangeError.
  assert.equal(tempoRestante(1_028_982.5, 60_000, 5_000, 1_000_000), 28_982);
  assert.equal(tempoRestante(Number.NaN, 60_000, 5_000, 1_000_000), 5_000);
});

test("DataJud: prazo fracionário (divisão entre tribunais) não derruba a busca", async () => {
  const f = simularFetch([json(401, { error: "unauthorized" })]);
  try {
    await assert.rejects(
      fonteDataJud("chave").buscar({ tribunal: "TRF1", de: "2026-11-01", ate: "2026-11-02", limite: 10, prazoFinal: Date.now() + 28_982.5 }, async () => {}),
      ChaveRecusada,
      "chegou ao DataJud (antes, o RangeError era engolido e virava 'sobrecarga')",
    );
    assert.equal(f.chamadas.length, 1);
  } finally {
    f.restaurar();
  }
});

const N1 = cnj("5001234", "2026", "03", "6182");
const N2 = cnj("5001235", "2026", "03", "6182");
const hit = (numero: string, data: unknown, extra: Record<string, unknown> = {}) => ({
  _source: { numeroProcesso: numero, dataAjuizamento: data, classe: { codigo: 1116, nome: "Execução Fiscal" }, grau: "G1", ...extra },
  sort: [numero],
});

test("DataJud: página lida nos dois formatos de data; tribunal, classe e janela conferidos", () => {
  const lote = lerPaginaDataJud({
    hits: {
      hits: [
        hit(N1, "20261110000000"),
        hit(N2, "2026-11-12T00:00:00.000Z", { valorCausa: 250000.5 }),
        hit(cnj("5001236", "2026", "01", "3400"), "20261110000000"), // TRF1 na consulta do TRF3
        hit(cnj("5001237", "2026", "03", "6182"), "20261110000000", { classe: { codigo: 1118 } }), // embargos
        hit(cnj("5001238", "2026", "03", "6182"), "20261020000000"), // fora da janela
      ],
    },
  }, "TRF3", "2026-11-01", "2026-11-20");
  assert.deepEqual(lote.map((p) => [p.numeroCnj, p.dataDistribuicao, p.valorCausa]), [[N1, "2026-11-10", null], [N2, "2026-11-12", 250000.5]]);
});

/** fetch simulado: responde em sequência e registra cada chamada (sem rede). */
function simularFetch(respostas: (() => Response)[]) {
  const chamadas: { url: string; init: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: URL | string, init: RequestInit = {}) => {
    chamadas.push({ url: String(url), init });
    const proxima = respostas.shift();
    if (!proxima) throw new Error("sem resposta simulada");
    return proxima();
  }) as typeof fetch;
  return { chamadas, restaurar: () => { globalThis.fetch = original; } };
}
const json = (status: number, corpo: unknown) => () => new Response(JSON.stringify(corpo), { status });

test("DataJud: grava página a página; sobrecarga no meio devolve o parcial sem perder nada", async () => {
  const f = simularFetch([
    json(429, SOBRECARGA_REAL), // 1ª página, 1ª tentativa: sobrecarga, tenta de novo
    json(200, { hits: { hits: [hit(N1, "20261110000000")] } }),
    json(429, SOBRECARGA_REAL), json(429, SOBRECARGA_REAL), json(429, SOBRECARGA_REAL), // 2ª página: desiste
  ]);
  try {
    const gravados: ProcessoEncontrado[] = [];
    const r = await fonteDataJud("chave-ficticia").buscar(
      { tribunal: "TRF3", de: "2026-11-01", ate: "2026-11-20", limite: 50, prazoFinal: Date.now() + 60_000 },
      async (lote) => {
        gravados.push(...lote);
      },
    );
    assert.deepEqual(r, { recebidos: 1, fim: "sobrecarga" });
    assert.deepEqual(gravados.map((p) => p.numeroCnj), [N1], "a página que chegou foi entregue para gravar");
    assert.ok(f.chamadas.every((c) => c.init.redirect === "error"), "nunca segue redirect");
    assert.ok(f.chamadas.every((c) => c.url === "https://api-publica.datajud.cnj.jus.br/api_publica_trf3/_search"));
    assert.equal((f.chamadas[0].init.headers as Record<string, string>).Authorization, "APIKey chave-ficticia");
  } finally {
    f.restaurar();
  }
});

test("DataJud: 401/403 vira ChaveRecusada na hora (sem repetir); sobrecarga sem nada recebido vira FonteIndisponivel", async () => {
  for (const status of [401, 403]) {
    const f = simularFetch([json(status, { error: "unauthorized" })]);
    try {
      await assert.rejects(
        fonteDataJud("chave-antiga").buscar({ tribunal: "TRF1", de: "2026-11-01", ate: "2026-11-02", limite: 10, prazoFinal: Date.now() + 60_000 }, async () => {}),
        ChaveRecusada,
      );
      assert.equal(f.chamadas.length, 1, "chave recusada não é repetida");
    } finally {
      f.restaurar();
    }
  }
  const f = simularFetch([json(429, SOBRECARGA_REAL), json(503, {}), json(429, SOBRECARGA_REAL)]);
  try {
    await assert.rejects(
      fonteDataJud("chave").buscar({ tribunal: "TRF4", de: "2026-11-01", ate: "2026-11-02", limite: 10, prazoFinal: Date.now() + 60_000 }, async () => {}),
      (e: unknown) => e instanceof FonteIndisponivel && e.limiteDeUso,
    );
  } finally {
    f.restaurar();
  }
});

test("DataJud: busca sem resultado termina como completa, sem gravar nada", async () => {
  const f = simularFetch([json(200, { hits: { hits: [] } })]);
  try {
    let chamou = false;
    const r = await fonteDataJud("chave").buscar(
      { tribunal: "TRF1", de: "2026-11-01", ate: "2026-11-02", limite: 10, prazoFinal: Date.now() + 60_000 },
      async () => {
        chamou = true;
      },
    );
    assert.deepEqual(r, { recebidos: 0, fim: "fim" });
    assert.equal(chamou, false);
  } finally {
    f.restaurar();
  }
});

test("DJEN: limite de uso (429) e queda (5xx) são passageiros; 404 = sem publicação", async () => {
  const f = simularFetch([json(429, {}), json(502, {}), json(404, {})]);
  try {
    await assert.rejects(fonteDjen.consultar(N1), (e: unknown) => e instanceof FonteIndisponivel && e.limiteDeUso);
    await assert.rejects(fonteDjen.consultar(N1), (e: unknown) => e instanceof FonteIndisponivel && e.limiteDeUso);
    assert.equal(await fonteDjen.consultar(N1), null);
    assert.ok(f.chamadas.every((c) => c.url.startsWith("https://comunicaapi.pje.jus.br/api/v1/comunicacao?numeroProcesso=") && c.init.redirect === "error"));
  } finally {
    f.restaurar();
  }
});

test("base CNPJ (minhareceita): contato lido; 429 é passageiro; 404 = CNPJ inexistente", async () => {
  const f = simularFetch([
    json(200, { razao_social: "EMPRESA EXEMPLO LTDA", codigo_natureza_juridica: 2062, uf: "SP", ddd_telefone_1: "1134567890", email: "Contato@Exemplo.com.br" }),
    json(429, {}),
    json(404, {}),
  ]);
  try {
    const d = await fonteMinhaReceita.consultar("11222333000181");
    assert.deepEqual([d?.razaoSocial, d?.naturezaJuridica, d?.telefones, d?.email], ["EMPRESA EXEMPLO LTDA", "2062", ["(11) 3456-7890"], "contato@exemplo.com.br"]);
    await assert.rejects(fonteMinhaReceita.consultar("11222333000181"), (e: unknown) => e instanceof FonteIndisponivel && e.limiteDeUso);
    assert.equal(await fonteMinhaReceita.consultar("11222333000181"), null);
    assert.ok(f.chamadas.every((c) => c.url === "https://minhareceita.org/11222333000181" && c.init.redirect === "error"));
  } finally {
    f.restaurar();
  }
});

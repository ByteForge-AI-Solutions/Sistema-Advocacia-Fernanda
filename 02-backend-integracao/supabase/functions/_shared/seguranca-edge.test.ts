// Testes de segurança das Edge Functions (auditoria de 24/11/2026), sem rede e sem Deno:
// o Deno.serve e o Deno.env são simulados e o handler real de cada função é chamado com
// Requests montados aqui. O fetch é simulado por URL. Dados fictícios.
// Uso: node --test 02-backend-integracao/supabase/functions/_shared/seguranca-edge.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_ENTRADAS, _tamanho, bloqueado, ipDe, registrarFalha } from "./limite-falhas.ts";
import { buscarComRedirecionamentoControlado, corpoGrandeDemais, lerCorpoLimitado } from "./rede-segura.ts";

type Handler = (req: Request) => Promise<Response>;
const ENV: Record<string, string> = {
  SUPABASE_URL: "https://projeto-teste.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "chave-servico-ficticia",
  SUPABASE_ANON_KEY: "chave-anon-ficticia",
  META_APP_SECRET: "segredo-meta-ficticio",
  META_VERIFY_TOKEN: "token-verificacao-ficticio",
  GOOGLE_CHANNEL_TOKEN: "token-canal-ficticio",
  CRM_ORIGENS: "https://crm.exemplo.com.br",
  DATAJUD_API_KEY: "chave-datajud-ficticia",
};
const handlers: Handler[] = [];
(globalThis as unknown as { Deno: unknown }).Deno = {
  env: { get: (k: string) => ENV[k] },
  serve: (h: Handler) => {
    handlers.push(h);
  },
};

/** fetch simulado por rota; registra todas as chamadas de saída. */
type Rota = (url: string, init: RequestInit) => Response | undefined;
let rotas: Rota[] = [];
const saidas: { url: string; init: RequestInit }[] = [];
globalThis.fetch = (async (entrada: URL | string | Request, init: RequestInit = {}) => {
  const url = entrada instanceof Request ? entrada.url : String(entrada);
  saidas.push({ url, init });
  for (const r of rotas) {
    const resp = r(url, init);
    if (resp) return resp;
  }
  throw new Error(`fetch inesperado: ${url}`);
}) as typeof fetch;
const json = (status: number, corpo: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json", ...headers } });

await import("../meta-webhook/index.ts");
await import("../google-calendar-webhook/index.ts");
await import("../prospeccao-execucoes/index.ts");
const [meta, google, prospeccao] = handlers;

// ---------------------------------------------------------------- limite por IP

test("ipDe: cabeçalho da borda vence o X-Forwarded-For forjado; valor inválido é ignorado", () => {
  const h = (headers: Record<string, string>) => ipDe(new Request("https://x/", { headers }));
  assert.equal(h({ "x-forwarded-for": "157.240.0.1, 10.0.0.9", "cf-connecting-ip": "203.0.113.7" }), "203.0.113.7");
  assert.equal(h({ "x-forwarded-for": "157.240.0.1", "x-real-ip": "203.0.113.8" }), "203.0.113.8");
  assert.equal(h({ "x-forwarded-for": "<script>, 1.2.3.4" }), "desconhecido");
  assert.equal(h({ "x-forwarded-for": "2001:db8::1" }), "2001:db8::1");
});

test("limite por IP: 20 falhas bloqueiam; mapa nunca passa do teto (enxurrada de IPs)", () => {
  for (let i = 0; i < 20; i++) registrarFalha("192.0.2.50");
  assert.equal(bloqueado("192.0.2.50"), true);
  assert.equal(bloqueado("192.0.2.50", Date.now() + 61_000), false, "janela de 1 minuto");
  const t = Date.now();
  for (let i = 0; i < MAX_ENTRADAS + 5_000; i++) registrarFalha(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`, t);
  assert.ok(_tamanho() <= MAX_ENTRADAS, `mapa com ${_tamanho()} entradas`);
});

// ---------------------------------------------------------------- rede segura

test("redirecionamento controlado: segue só para host permitido e nunca leva o token para fora", async () => {
  const permitido = (u: string) => new URL(u).hostname.endsWith(".fbsbx.com");
  saidas.length = 0;
  rotas = [
    (u) => (u === "https://a.fbsbx.com/m" ? new Response(null, { status: 302, headers: { location: "https://b.fbsbx.com/m2" } }) : undefined),
    (u) => (u === "https://b.fbsbx.com/m2" ? new Response("audio", { status: 200 }) : undefined),
  ];
  const ok = await buscarComRedirecionamentoControlado("https://a.fbsbx.com/m", { headers: { Authorization: "Bearer x" } }, permitido);
  assert.equal(await ok.text(), "audio");
  assert.ok(saidas.every((s) => s.init.redirect === "manual"));

  saidas.length = 0;
  rotas = [(u) => (u === "https://a.fbsbx.com/m" ? new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }) : undefined)];
  await assert.rejects(buscarComRedirecionamentoControlado("https://a.fbsbx.com/m", { headers: { Authorization: "Bearer x" } }, permitido), /destino_nao_permitido/);
  assert.deepEqual(saidas.map((s) => s.url), ["https://a.fbsbx.com/m"], "o destino interno nunca é chamado");

  rotas = [(u) => new Response(null, { status: 302, headers: { location: u } })];
  await assert.rejects(buscarComRedirecionamentoControlado("https://a.fbsbx.com/m", {}, permitido), /redirecionamentos_demais/);
});

test("corpo limitado: aborta ao passar do teto, mesmo sem Content-Length", async () => {
  const grande = new ReadableStream({
    pull(c) {
      c.enqueue(new Uint8Array(64 * 1024));
    },
  });
  await assert.rejects(lerCorpoLimitado(new Response(grande), 1_000_000), /resposta_grande_demais/);
  assert.equal((await lerCorpoLimitado(new Response("abc"), 10)).byteLength, 3);
  assert.equal(corpoGrandeDemais(new Request("https://x/", { method: "POST", body: "x", headers: { "content-length": "2000000" } }), 1_000_000), true);
});

// ---------------------------------------------------------------- meta-webhook

async function assinar(corpo: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(ENV.META_APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(corpo)));
  return "sha256=" + Array.from(s, (b) => b.toString(16).padStart(2, "0")).join("");
}
const EVENTO = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [{ changes: [{ value: { contacts: [{ profile: { name: "Cliente Teste" } }], messages: [{ from: "5566999990000", id: "wamid.teste", type: "text", text: { body: "Olá" } }] } }] }],
});
const postMeta = (corpo: string, assinatura: string, ip: string) =>
  meta(new Request("https://edge/meta-webhook", { method: "POST", body: corpo, headers: { "x-hub-signature-256": assinatura, "cf-connecting-ip": ip } }));

test("meta-webhook: assinatura inválida = 403 e depois 429; assinatura VÁLIDA passa mesmo do IP bloqueado", async () => {
  rotas = [(u) => (u.endsWith("/rest/v1/rpc/dfu_receber") ? json(200, { processar_ia: false }) : undefined)];
  const ipMeta = "157.240.0.10";
  assert.equal((await postMeta(EVENTO, "sha256=" + "0".repeat(64), ipMeta)).status, 403);
  for (let i = 0; i < 25; i++) await postMeta(EVENTO, "sha256=" + "0".repeat(64), ipMeta); // atacante forja o IP da Meta
  assert.equal((await postMeta(EVENTO, "sha256=" + "0".repeat(64), ipMeta)).status, 429);
  saidas.length = 0;
  const legitima = await postMeta(EVENTO, await assinar(EVENTO), ipMeta);
  assert.equal(legitima.status, 200, "a Meta não é barrada pelo IP forjado");
  assert.equal(await legitima.text(), "EVENT_RECEIVED");
  assert.deepEqual(saidas.map((s) => s.url), [`${ENV.SUPABASE_URL}/rest/v1/rpc/dfu_receber`]);
  assert.ok(saidas.every((s) => s.init.redirect === "error"));
});

test("meta-webhook: GET de verificação; corpo grande recusado sem ler; falha do banco não vaza detalhe", async () => {
  const ok = await meta(new Request(`https://edge/meta-webhook?hub.mode=subscribe&hub.verify_token=${ENV.META_VERIFY_TOKEN}&hub.challenge=abc<script>`));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal((await meta(new Request("https://edge/meta-webhook?hub.mode=subscribe&hub.verify_token=errado"))).status, 403);
  const grande = await meta(new Request("https://edge/meta-webhook", { method: "POST", body: "x", headers: { "content-length": "5000000", "cf-connecting-ip": "198.51.100.1" } }));
  assert.equal(grande.status, 403);
  rotas = [(u) => (u.endsWith("/rpc/dfu_receber") ? json(500, { message: "relation dfu_atendimentos does not exist", hint: "segredo interno" }) : undefined)];
  const falha = await postMeta(EVENTO, await assinar(EVENTO), "198.51.100.2");
  assert.equal(falha.status, 503);
  const texto = await falha.text();
  assert.ok(!/relation|segredo|db_http|5566999990000|stack/i.test(texto), `vazou: ${texto}`);
});

// ---------------------------------------------------------------- google-calendar-webhook

test("google-calendar-webhook: token inválido 403→429; token VÁLIDO passa mesmo do IP bloqueado", async () => {
  rotas = [(u) => (u.endsWith("/rest/v1/agenda_google_notificacoes") ? new Response(null, { status: 201 }) : undefined)];
  const req = (token: string) => google(new Request("https://edge/google", {
    method: "POST",
    headers: { "x-goog-channel-id": "canal-1", "x-goog-resource-state": "exists", "x-goog-channel-token": token, "cf-connecting-ip": "74.125.0.1" },
  }));
  for (let i = 0; i < 21; i++) await req("errado");
  assert.equal((await req("errado")).status, 429);
  saidas.length = 0;
  assert.equal((await req(ENV.GOOGLE_CHANNEL_TOKEN)).status, 200);
  assert.ok(saidas.every((s) => s.init.redirect === "error"));
});

// ---------------------------------------------------------------- prospeccao-execucoes

const ID_SOCIO = "11111111-1111-4111-8111-111111111111";
function rotasProspeccao(cargo: string | null, id = ID_SOCIO) {
  rotas = [
    (u) => (u.endsWith("/rest/v1/rpc/crm_cargo_atual") ? json(200, cargo) : undefined),
    (u) => (u.endsWith("/rest/v1/rpc/advogado_atual_id") ? json(200, cargo ? id : null) : undefined),
    (u) => (u.endsWith("/rest/v1/rpc/prosp_cnpjs_para_enriquecer") ? json(200, []) : undefined),
    (u) => (u.includes("/rest/v1/prosp_processos") ? json(200, [], { "content-range": "*/0" }) : undefined),
    (u) => (u.endsWith("/rest/v1/prosp_auditoria") ? new Response(null, { status: 201 }) : undefined),
  ];
}
const chamar = (corpo: unknown, opcoes: { jwt?: string; ip?: string; origem?: string } = {}) =>
  prospeccao(new Request("https://edge/prospeccao-execucoes", {
    method: "POST",
    body: JSON.stringify(corpo),
    headers: {
      "content-type": "application/json",
      ...(opcoes.jwt ? { authorization: `Bearer ${opcoes.jwt}` } : {}),
      "cf-connecting-ip": opcoes.ip ?? "203.0.113.20",
      origin: opcoes.origem ?? ENV.CRM_ORIGENS,
    },
  }));

test("prospecção: sem sessão 401; estagiário/desenvolvedor 403; campos extras 400", async () => {
  rotasProspeccao(null);
  assert.equal((await chamar({ acao: "processar" })).status, 401);
  assert.equal((await chamar({ acao: "processar" }, { jwt: "jwt-ficticio" })).status, 401);
  for (const cargo of ["estagiario", "desenvolvedor"]) {
    rotasProspeccao(cargo, "22222222-2222-4222-8222-22222222222" + (cargo === "estagiario" ? "2" : "3"));
    const r = await chamar({ acao: "processar" }, { jwt: "jwt-ficticio", ip: "203.0.113.30" });
    assert.equal(r.status, 403, cargo);
  }
  rotasProspeccao("advogado", "33333333-3333-4333-8333-333333333333");
  const extra = await chamar({ acao: "buscar", tribunais: ["TRF1"], de: "2026-11-01", ate: "2026-11-02", url: "http://169.254.169.254/" }, { jwt: "jwt-ficticio" });
  assert.equal(extra.status, 400);
});

test("prospecção: 6 execuções por minuto por usuário; a 7ª é 429 com aguardeSegundos; sem vazar o host do banco", async () => {
  rotasProspeccao("socio", "44444444-4444-4444-8444-444444444444");
  for (let i = 0; i < 6; i++) {
    const r = await chamar({ acao: "processar" }, { jwt: "jwt-ficticio", ip: "203.0.113.40" });
    assert.equal(r.status, 200, `chamada ${i + 1}`);
    assert.equal(r.headers.get("access-control-allow-origin"), ENV.CRM_ORIGENS);
  }
  const setima = await chamar({ acao: "processar" }, { jwt: "jwt-ficticio", ip: "203.0.113.40" });
  assert.equal(setima.status, 429);
  const j = (await setima.json()) as { aguardeSegundos: number; erro: string };
  assert.ok(j.aguardeSegundos >= 1 && j.aguardeSegundos <= 60);
  assert.ok(!JSON.stringify(j).includes("supabase.co"));
});

test("prospecção: IP forjado e bloqueado não barra sócio autenticado; origem fora da lista não recebe CORS", async () => {
  const ip = "203.0.113.50";
  for (let i = 0; i < 25; i++) registrarFalha(ip);
  rotasProspeccao("socio", "55555555-5555-4555-8555-555555555555");
  const r = await chamar({ acao: "processar" }, { jwt: "jwt-ficticio", ip, origem: "https://site-malicioso.example" });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("access-control-allow-origin"), null);
  rotasProspeccao(null);
  assert.equal((await chamar({ acao: "processar" }, { jwt: "jwt-invalido", ip })).status, 429, "quem não é da equipe continua barrado");
});

test("prospecção: falha do banco vira 503 genérico (sem stack, sem detalhe interno); corpo grande 413", async () => {
  rotasProspeccao("socio", "66666666-6666-4666-8666-666666666666");
  rotas.unshift((u) => (u.includes("/rest/v1/prosp_processos") ? json(500, { message: "permission denied for table prosp_processos", details: "segredo" }) : undefined));
  const r = await chamar({ acao: "processar" }, { jwt: "jwt-ficticio", ip: "203.0.113.60" });
  assert.equal(r.status, 503);
  const texto = await r.text();
  assert.ok(!/permission|segredo|db_http|stack|at \w+ \(/i.test(texto), `vazou: ${texto}`);
  const grande = await prospeccao(new Request("https://edge/prospeccao-execucoes", {
    method: "POST", body: "x", headers: { "content-length": "100000", authorization: "Bearer jwt" },
  }));
  assert.equal(grande.status, 413);
});

test("prospecção: busca com chave do DataJud recusada devolve aviso com o comando e não chama host fora da lista", async () => {
  rotasProspeccao("socio", "77777777-7777-4777-8777-777777777777");
  rotas.unshift((u) => (u.startsWith("https://api-publica.datajud.cnj.jus.br/") ? json(401, { error: "unauthorized" }) : undefined));
  saidas.length = 0;
  const r = await chamar({ acao: "buscar", tribunais: ["TRF1", "TRF3"], de: "2026-11-01", ate: "2026-11-10" }, { jwt: "jwt-ficticio", ip: "203.0.113.70" });
  assert.equal(r.status, 200);
  const j = (await r.json()) as { avisos: { codigo: string; mensagem: string }[]; porTribunal: Record<string, { fim: string }> };
  const aviso = j.avisos.find((a) => a.codigo === "datajud_chave_recusada");
  assert.ok(aviso && aviso.mensagem.includes("supabase secrets set DATAJUD_API_KEY"));
  assert.deepEqual([j.porTribunal.TRF1?.fim, j.porTribunal.TRF3?.fim], ["chave_recusada", "chave_recusada"]);
  assert.equal(saidas.filter((s) => s.url.includes("datajud")).length, 1, "chave recusada: uma chamada só, sem insistir");
  const hosts = new Set(saidas.map((s) => new URL(s.url).hostname));
  assert.deepEqual([...hosts].sort(), ["api-publica.datajud.cnj.jus.br", "projeto-teste.supabase.co"]);
  assert.ok(!JSON.stringify(j).includes(ENV.DATAJUD_API_KEY), "a chave nunca volta na resposta");
});

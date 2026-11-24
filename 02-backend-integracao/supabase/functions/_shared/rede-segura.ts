/**
 * Utilitários de rede para Edge Functions (auditoria de 24/11/2026).
 *
 * - buscarComRedirecionamentoControlado: segue no máximo N redirecionamentos, um por vez, e
 *   só se o destino passar na allowlist. Os cabeçalhos (inclusive Authorization) só vão para
 *   hosts aprovados. Destino fora da lista = erro (anti-SSRF e anti-vazamento de token).
 * - lerCorpoLimitado: lê a resposta em partes e aborta ao passar do teto, sem carregar um
 *   corpo gigante inteiro na memória (content-length pode mentir ou faltar).
 * - corpoGrandeDemais: recusa a requisição pelo Content-Length antes de ler o corpo.
 */

export async function buscarComRedirecionamentoControlado(
  url: string,
  init: RequestInit,
  permitido: (u: string) => boolean,
  maxSaltos = 3,
): Promise<Response> {
  let atual = url;
  for (let salto = 0; salto <= maxSaltos; salto++) {
    if (!permitido(atual)) throw new Error("destino_nao_permitido");
    const r = await fetch(atual, { ...init, redirect: "manual" });
    if (r.status < 300 || r.status > 399) return r;
    const destino = r.headers.get("location");
    await r.body?.cancel().catch(() => {});
    if (!destino) throw new Error("redirecionamento_sem_destino");
    atual = new URL(destino, atual).toString();
  }
  throw new Error("redirecionamentos_demais");
}

export async function lerCorpoLimitado(r: Response, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const declarado = Number(r.headers.get("content-length") || 0);
  if (declarado > maxBytes) {
    await r.body?.cancel().catch(() => {});
    throw new Error("resposta_grande_demais");
  }
  if (!r.body) return new Uint8Array(new ArrayBuffer(0));
  const leitor = r.body.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await leitor.cancel().catch(() => {});
      throw new Error("resposta_grande_demais");
    }
    partes.push(value);
  }
  const corpo = new Uint8Array(new ArrayBuffer(total));
  let pos = 0;
  for (const p of partes) {
    corpo.set(p, pos);
    pos += p.byteLength;
  }
  return corpo;
}

/** true = Content-Length declarado acima do teto (recuse com 413 sem ler o corpo). */
export function corpoGrandeDemais(req: Request, maxBytes: number): boolean {
  const declarado = Number(req.headers.get("content-length") || 0);
  return Number.isFinite(declarado) && declarado > maxBytes;
}

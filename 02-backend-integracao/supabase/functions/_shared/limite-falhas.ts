/**
 * Limite de tentativas INVÁLIDAS por IP (assinatura/token errado) para webhooks públicos.
 * Em memória, por instância da Edge Function: freia varredura e força bruta de token sem
 * custo de banco. Tráfego legítimo (assinatura válida) nunca é contado nem bloqueado.
 * Para limite global entre instâncias, use também o firewall/rate limit do provedor.
 */
const JANELA_MS = 60_000;
const MAX_FALHAS = 20;
const falhas = new Map<string, { n: number; desde: number }>();

export function ipDe(req: Request): string {
  const encaminhado = req.headers.get("x-forwarded-for") ?? "";
  return (encaminhado.split(",")[0] || req.headers.get("cf-connecting-ip") || "desconhecido").trim().slice(0, 64);
}

/** true = IP estourou o limite de falhas na janela atual (responda 429 sem processar). */
export function bloqueado(ip: string, agora = Date.now()): boolean {
  const r = falhas.get(ip);
  if (!r || agora - r.desde > JANELA_MS) return false;
  return r.n >= MAX_FALHAS;
}

export function registrarFalha(ip: string, agora = Date.now()): void {
  const r = falhas.get(ip);
  if (!r || agora - r.desde > JANELA_MS) falhas.set(ip, { n: 1, desde: agora });
  else r.n++;
  if (falhas.size > 10_000) {
    // Evita crescimento sem fim: descarta janelas vencidas.
    for (const [k, v] of falhas) if (agora - v.desde > JANELA_MS) falhas.delete(k);
  }
}

/**
 * Limite de tentativas INVÁLIDAS por IP (assinatura/token errado) para webhooks públicos.
 * Em memória, por instância da Edge Function: freia varredura e força bruta de token sem
 * custo de banco. Para limite global entre instâncias, use também o firewall do provedor.
 *
 * REGRAS (auditoria de 24/11/2026):
 *  1. Requisição AUTÊNTICA nunca é barrada por este limite. Quem chama deve conferir a
 *     assinatura/token ANTES de aplicar bloqueado(ip) e só barrar as inválidas. Sem isso, um
 *     atacante que forje o IP da Meta/Google (cabeçalho controlável) bloquearia o tráfego
 *     legítimo (negação de serviço).
 *  2. O IP vem primeiro de cabeçalhos que o cliente não controla (cf-connecting-ip, x-real-ip,
 *     definidos pela borda). X-Forwarded-For só como último recurso, porque o cliente pode
 *     pôr qualquer valor no início dele.
 *  3. O mapa tem teto fixo de entradas: uma enxurrada de IPs diferentes não esgota a memória.
 */
const JANELA_MS = 60_000;
const MAX_FALHAS = 20;
export const MAX_ENTRADAS = 10_000;
const falhas = new Map<string, { n: number; desde: number }>();

function ipValido(v: string | null): string | null {
  const ip = (v ?? "").trim();
  // IPv4/IPv6 sem lixo: evita que um cabeçalho forjado vire uma chave arbitrária no mapa.
  return /^[0-9a-fA-F:.]{2,45}$/.test(ip) ? ip : null;
}

export function ipDe(req: Request): string {
  return (
    ipValido(req.headers.get("cf-connecting-ip")) ??
    ipValido(req.headers.get("x-real-ip")) ??
    ipValido((req.headers.get("x-forwarded-for") ?? "").split(",")[0]) ??
    "desconhecido"
  );
}

/** true = IP estourou o limite de falhas na janela atual (só para requisições NÃO autênticas). */
export function bloqueado(ip: string, agora = Date.now()): boolean {
  const r = falhas.get(ip);
  if (!r || agora - r.desde > JANELA_MS) return false;
  return r.n >= MAX_FALHAS;
}

export function registrarFalha(ip: string, agora = Date.now()): void {
  const r = falhas.get(ip);
  if (!r || agora - r.desde > JANELA_MS) {
    falhas.delete(ip); // reinsere no fim: a ordem do Map vira "mais antigo primeiro"
    falhas.set(ip, { n: 1, desde: agora });
  } else r.n++;
  if (falhas.size > MAX_ENTRADAS) {
    for (const [k, v] of falhas) if (agora - v.desde > JANELA_MS) falhas.delete(k);
    // Ainda cheio (enxurrada dentro da janela): descarta os registros mais antigos.
    for (const k of falhas.keys()) {
      if (falhas.size <= MAX_ENTRADAS) break;
      falhas.delete(k);
    }
  }
}

/** Só para testes: quantas entradas o mapa tem. */
export function _tamanho(): number {
  return falhas.size;
}

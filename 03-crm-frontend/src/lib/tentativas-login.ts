/**
 * Freio de tentativas de login neste navegador: depois de 5 falhas seguidas, espera crescente
 * (30 s, 60 s, 120 s... até 15 min). É um complemento de UX; a proteção real contra força bruta
 * é o rate limit do Supabase Auth (Authentication → Rate Limits) e, se ativado, o CAPTCHA.
 * Guarda só contadores e horários (nada de e-mail ou senha).
 */
const CHAVE = "crm-login-tentativas";
const LIVRES = 5;
const BASE_MS = 30_000;
const MAX_MS = 15 * 60_000;

interface Estado {
  falhas: number;
  bloqueadoAte: number;
}

function ler(): Estado {
  try {
    const e = JSON.parse(localStorage.getItem(CHAVE) ?? "{}") as Partial<Estado>;
    return { falhas: Number(e.falhas) || 0, bloqueadoAte: Number(e.bloqueadoAte) || 0 };
  } catch {
    return { falhas: 0, bloqueadoAte: 0 };
  }
}

/** Segundos que ainda faltam para poder tentar de novo (0 = liberado). */
export function segundosBloqueado(agora = Date.now()): number {
  return Math.max(0, Math.ceil((ler().bloqueadoAte - agora) / 1000));
}

/** Espera aplicada depois da n-ésima falha (0 enquanto houver tentativas livres). */
export function esperaAposFalhas(falhas: number): number {
  if (falhas < LIVRES) return 0;
  return Math.min(MAX_MS, BASE_MS * 2 ** (falhas - LIVRES));
}

export function registrarFalhaLogin(agora = Date.now()): number {
  const e = ler();
  const falhas = e.falhas + 1;
  const espera = esperaAposFalhas(falhas);
  localStorage.setItem(CHAVE, JSON.stringify({ falhas, bloqueadoAte: espera ? agora + espera : 0 }));
  return Math.ceil(espera / 1000);
}

export function limparTentativasLogin() {
  localStorage.removeItem(CHAVE);
}

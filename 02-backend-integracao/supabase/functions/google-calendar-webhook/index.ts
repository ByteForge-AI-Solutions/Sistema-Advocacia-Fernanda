/**
 * DIAS & FERNANDES | Webhook Google Calendar (notificações push) | preparação v3
 *
 * Recebe as notificações de "watch" da Google Calendar API (events.watch) e
 * apenas REGISTRA o aviso em public.agenda_google_notificacoes; quem busca as
 * mudanças (events.list com syncToken) e chama crm_google_aplicar_alteracao é o
 * worker do n8n, que guarda as credenciais OAuth. Esta função não fala com o Google.
 *
 * Segurança: o Google não assina o corpo; a autenticidade vem do X-Goog-Channel-Token,
 * definido por nós ao criar o canal (events.watch → "token"). Compare sempre em
 * tempo constante. Implante sem JWT (o Google não envia):
 *   supabase functions deploy google-calendar-webhook --no-verify-jwt
 * Secrets: GOOGLE_CHANNEL_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY e,
 * opcionais, N8N_GOOGLE_SYNC_URL + N8N_WEBHOOK_SECRET (para acordar o worker).
 */
import { bloqueado, ipDe, registrarFalha } from "../_shared/limite-falhas.ts";

function env(key: string): string {
  return Deno.env.get(key)?.trim() || "";
}

function fixedTimeEquals(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

async function registrar(aviso: Record<string, unknown>): Promise<void> {
  const url = env("SUPABASE_URL");
  const secret = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url.startsWith("https://") || !secret) throw new Error("backend_config_incomplete");
  const r = await fetch(`${url.replace(/\/$/, "")}/rest/v1/agenda_google_notificacoes`, {
    method: "POST",
    headers: {
      apikey: secret,
      Authorization: `Bearer ${secret}`,
      "content-type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(aviso),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`db_http_${r.status}`);
}

async function acordarWorker(canalId: string): Promise<void> {
  if (!env("N8N_GOOGLE_SYNC_URL") || !env("N8N_WEBHOOK_SECRET")) return;
  try {
    await fetch(env("N8N_GOOGLE_SYNC_URL"), {
      method: "POST",
      headers: { "content-type": "application/json", "X-DFU-Internal-Secret": env("N8N_WEBHOOK_SECRET") },
      body: JSON.stringify({ canal_id: canalId }),
      signal: AbortSignal.timeout(4500),
    });
  } catch {
    /* O aviso já está gravado; o cron do worker processa depois. */
  }
}

Deno.serve(async (req: Request) => {
  const ip = ipDe(req);
  if (bloqueado(ip)) return new Response("Too Many Requests", { status: 429, headers: { "retry-after": "60" } });
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const canalId = (req.headers.get("x-goog-channel-id") || "").slice(0, 200);
  const estado = (req.headers.get("x-goog-resource-state") || "").slice(0, 40);
  const token = req.headers.get("x-goog-channel-token") || "";
  if (!canalId || !estado || !fixedTimeEquals(token, env("GOOGLE_CHANNEL_TOKEN"))) {
    registrarFalha(ip);
    return new Response("Unauthorized", { status: 403 });
  }

  // "sync" é só a confirmação de criação do canal: nada a sincronizar.
  if (estado === "sync") return new Response("OK", { status: 200 });

  const numero = Number(req.headers.get("x-goog-message-number") || "");
  try {
    await registrar({
      canal_id: canalId,
      resource_id: (req.headers.get("x-goog-resource-id") || "").slice(0, 200) || null,
      estado,
      mensagem_numero: Number.isFinite(numero) ? numero : null,
    });
  } catch {
    // 5xx faz o Google tentar novamente com backoff.
    return new Response("Persistência indisponível", { status: 503 });
  }
  await acordarWorker(canalId);
  return new Response("OK", { status: 200 });
});

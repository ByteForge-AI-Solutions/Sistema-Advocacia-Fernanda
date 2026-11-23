/**
 * DIAS & FERNANDES | Entrada durável Meta (WhatsApp Cloud API) | v2
 *
 * 1. Verifica challenge GET e assinatura HMAC do corpo bruto no POST.
 * 2. Grava cada mensagem, de modo idempotente, via RPC dfu_receber no Supabase.
 * 3. Só confirma HTTP 200 à Meta APÓS sucesso de persistência.
 * 4. Acorda opcionalmente o n8n para processamento imediato. Se o n8n falhar,
 *    o cron dfu_recuperar_pendentes retoma a mensagem gravada no banco.
 *
 * Nunca implante usando JWT obrigatório nesta função pública da Meta:
 *    supabase functions deploy meta-webhook --no-verify-jwt
 * O POST é protegido por HMAC, o GET pelo token de verificação.
 * Chaves service_role e tokens devem existir apenas como secrets da Edge.
 * Tentativas com token/assinatura inválidos são limitadas por IP (429).
 */
import { bloqueado, ipDe, registrarFalha } from "../_shared/limite-falhas.ts";

/** Hosts aceitos para baixar mídia (a URL vem da Graph API; evita SSRF para outros destinos). */
const HOSTS_MIDIA = [".fbsbx.com", ".fbcdn.net", ".facebook.com", ".whatsapp.net"];
function hostDeMidiaPermitido(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && HOSTS_MIDIA.some((h) => url.hostname.endsWith(h));
  } catch { return false; }
}
function env(key: string): string { return Deno.env.get(key)?.trim() || ""; }
function fixedTimeEquals(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}
function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
async function validHmac(body: Uint8Array, header: string): Promise<boolean> {
  if (!header.startsWith("sha256=") || !env("META_APP_SECRET")) return false;
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(env("META_APP_SECRET")),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sign = new Uint8Array(await crypto.subtle.sign("HMAC", k, body));
  return fixedTimeEquals(toHex(sign), header.slice(7).toLowerCase());
}
async function transcribeAudio(mediaId: string): Promise<string | null> {
  if (!env("OPENAI_API_KEY") || !env("META_ACCESS_TOKEN")) return null;
  const version = env("META_GRAPH_VERSION") || "v23.0";
  const url = `https://graph.facebook.com/${version}/${encodeURIComponent(mediaId)}`;
  const auth = { Authorization: `Bearer ${env("META_ACCESS_TOKEN")}` };
  const meta = await fetch(url, { headers: auth, signal: AbortSignal.timeout(8000) });
  if (!meta.ok) return null;
  const data = await meta.json();
  if (typeof data?.url !== "string" || !hostDeMidiaPermitido(data.url)) return null;
  const audio = await fetch(data.url, { headers: auth, signal: AbortSignal.timeout(12000) });
  if (!audio.ok || Number(audio.headers.get("content-length") || 0) > 20_000_000) return null;
  const blob = await audio.blob();
  if (blob.size > 20_000_000) return null;
  const form = new FormData();
  form.append("model", "gpt-4o-mini-transcribe");
  form.append("file", new File([blob], "whatsapp-audio.ogg", { type: blob.type || "audio/ogg" }));
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST", headers: { Authorization: `Bearer ${env("OPENAI_API_KEY")}` },
    body: form, signal: AbortSignal.timeout(18000)
  });
  if (!r.ok) return null;
  const j = await r.json();
  return typeof j?.text === "string" ? j.text.slice(0, 3000) : null;
}
function normalizedMessage(message: any, name: string): Record<string, string> | null {
  const tel = String(message?.from || "").replace(/\D/g, "");
  const provider = String(message?.id || "").slice(0, 250);
  if (!/^55[1-9][0-9]9[0-9]{8}$/.test(tel) || !provider) return null;
  const kind = String(message.type || "outro").slice(0, 30);
  const descriptions: Record<string, string> = {
    audio: "[Áudio recebido sem transcrição. Peça ao cliente um breve relato por texto.]",
    image: "[Imagem recebida; será avaliada pela equipe, sem análise automática.]",
    document: "[Documento recebido; será avaliado pela equipe, sem análise automática.]",
    video: "[Vídeo recebido; o assistente não analisa vídeos.]"
  };
  return {
    p_telefone: tel,
    p_provider_id: provider,
    p_texto: String(kind === "text" ? (message.text?.body ?? "") : (descriptions[kind] ?? "[Mensagem não textual]" )).slice(0, 3000),
    p_tipo: kind,
    p_nome_whatsapp: name.slice(0, 120)
  };
}
async function persist(payload: Record<string, string>): Promise<any> {
  const url = env("SUPABASE_URL");
  const secret = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url.startsWith("https://") || !secret) throw new Error("backend_config_incomplete");
  const r = await fetch(`${url.replace(/\/$/, "")}/rest/v1/rpc/dfu_receber`, {
    method: "POST",
    headers: { "apikey": secret, "Authorization": `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(10000)
  });
  if (!r.ok) throw new Error(`db_http_${r.status}`);
  return await r.json();
}
async function wakeN8n(telephone: string): Promise<void> {
  if (!env("N8N_WEBHOOK_URL") || !env("N8N_WEBHOOK_SECRET")) return;
  try {
    await fetch(env("N8N_WEBHOOK_URL"), {
      method: "POST",
      headers: { "content-type": "application/json", "X-DFU-Internal-Secret": env("N8N_WEBHOOK_SECRET") },
      body: JSON.stringify({ telefone: telephone, processar_ia: true }),
      signal: AbortSignal.timeout(4500)
    });
  } catch { /* O DB ja confirmou a entrada; a recuperacao periodica assume. */ }
}
Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const ip = ipDe(req);
  if (bloqueado(ip)) return new Response("Too Many Requests", { status: 429, headers: { "retry-after": "60" } });
  if (req.method === "GET") {
    const okay = url.searchParams.get("hub.mode") === "subscribe" &&
      fixedTimeEquals(url.searchParams.get("hub.verify_token") || "", env("META_VERIFY_TOKEN"));
    if (!okay) registrarFalha(ip);
    // O challenge volta como texto puro (nunca HTML) e com tamanho limitado.
    return okay ? new Response((url.searchParams.get("hub.challenge") || "").slice(0, 200),
        { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } })
      : new Response("Unauthorized", { status: 403 });
  }
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const body = new Uint8Array(await req.arrayBuffer());
  if (body.length > 1_000_000 || !(await validHmac(body, req.headers.get("x-hub-signature-256") || ""))) {
    registrarFalha(ip);
    return new Response("Unauthorized", { status: 403 });
  }
  let document: any;
  try { document = JSON.parse(new TextDecoder().decode(body)); }
  catch { return new Response("Invalid JSON", { status: 400 }); }
  if (document?.object !== "whatsapp_business_account" || !Array.isArray(document?.entry))
    return new Response("Invalid event", { status: 400 });
  try {
    for (const entry of document.entry) for (const change of (entry?.changes || [])) {
      const val = change?.value ?? {};
      const name = String(val?.contacts?.[0]?.profile?.name || "");
      for (const m of (val?.messages || [])) {
        const parsed = normalizedMessage(m, name);
        if (!parsed) continue; // Ignorar status de entrega e telefones invalidos
        if (m.type === "audio" && m.audio?.id) {
          try {
            const transcript = await transcribeAudio(String(m.audio.id));
            if (transcript) { parsed.p_texto = transcript; parsed.p_tipo = "texto"; }
          } catch { /* prosseguir com marcador de audio sem transcricao */ }
        }
        const state = await persist(parsed); // A Meta só recebe 200 APOS gravar.
        if (state?.processar_ia === true) await wakeN8n(parsed.p_telefone);
      }
    }
    return new Response("EVENT_RECEIVED", { status: 200 });
  } catch {
    // Sem vazamento de números/relatos; a Meta repetirá o lote (RPC idempotente por message ID).
    return new Response("Persistência indisponível", { status: 503 });
  }
});

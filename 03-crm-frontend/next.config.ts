import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

/**
 * Origem do Supabase (REST, Auth, Storage e Realtime). Só a origem entra na CSP;
 * a chave anon nunca aparece aqui.
 */
function origemSupabase(): { https: string; wss: string } | null {
  try {
    const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
    return { https: url.origin, wss: `wss://${url.host}` };
  } catch {
    return null;
  }
}

const supabase = origemSupabase();

/**
 * CSP sem nonce (o app é estático, com Cache Components; nonce exigiria renderização
 * dinâmica): ver node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md.
 *  - script/style 'unsafe-inline': exigido pelos scripts de hidratação do Next e pelos
 *    estilos inline do React/Tailwind e da impressão de documentos;
 *  - 'unsafe-eval' só em desenvolvimento (React usa para depuração);
 *  - connect-src: só o próprio app e o Supabase (HTTPS + WebSocket do Realtime);
 *  - frame-ancestors 'none': o CRM não pode ser embutido em outro site (clickjacking).
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  `connect-src 'self'${supabase ? ` ${supabase.https} ${supabase.wss}` : ""}`,
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(isDev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const cabecalhosSeguranca = [
  { key: "Content-Security-Policy", value: csp },
  // HTTPS obrigatório por 2 anos (ignorado pelo navegador em http://localhost).
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Não envia o caminho completo do CRM para sites externos (wa.me, Supabase Storage).
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  // Isola a janela do CRM de abas abertas por ele (links de documento, wa.me): sem window.opener.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  poweredByHeader: false,
  async headers() {
    return [{ source: "/(.*)", headers: cabecalhosSeguranca }];
  },
};

export default nextConfig;

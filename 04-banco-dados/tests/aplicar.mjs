// Monta um banco Postgres real em memória (PGlite) com o ambiente mínimo do Supabase
// (papéis anon/authenticated/service_role, auth.jwt(), Storage) e aplica schema.sql +
// migrações na ordem. Nova migração: inclua o arquivo na lista MIGRACOES.
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

export const MIGRACOES = [
  "20261118_bot_unificado.sql",
  "20261118_v3_crm_modulos.sql",
  "20261118_v4_cargo_socio.sql",
  "20261118_v5_leads_posvenda.sql",
  "20261118_v6_funil_followup.sql",
  "20261119_v7_financeiro_documentos.sql",
  "20261122_v8_hardening_rls.sql",
  "20261122_v9_security_hardening.sql",
  "20261122_v10_advisor_funcoes.sql",
  "20261123_v11_prospeccao_execucoes.sql",
  "20261126_v12_ficha_manual.sql",
];

export async function montarBanco(raizRepo, migracoes = MIGRACOES) {
  const db = new PGlite();

  // Ambiente Supabase mínimo: papéis, auth.jwt(), Storage e privilégios padrão.
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;

    CREATE SCHEMA auth;
    GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
      $f$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $f$;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $f$ SELECT nullif(auth.jwt() ->> 'sub', '')::uuid $f$;
    GRANT EXECUTE ON FUNCTION auth.jwt(), auth.uid() TO anon, authenticated, service_role;

    CREATE SCHEMA storage;
    GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
    CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean DEFAULT false,
      file_size_limit bigint, allowed_mime_types text[]);
    CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text,
      owner uuid, metadata jsonb);
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    GRANT ALL ON storage.objects, storage.buckets TO anon, authenticated, service_role;
  `);

  const ler = (rel) => fs.readFileSync(path.join(raizRepo, rel), "utf8");
  await db.exec(ler("04-banco-dados/schema.sql"));
  // O banco real tem agenda_advogados.criado_em (conferido em 18/11/2026); o schema.sql diz created_at.
  await db.exec("ALTER TABLE public.agenda_advogados RENAME COLUMN created_at TO criado_em;");

  for (const m of migracoes) {
    try {
      await db.exec(ler(`04-banco-dados/migrations/${m}`));
    } catch (e) {
      throw new Error(`Falha ao aplicar ${m}: ${e.message}`);
    }
  }
  return db;
}

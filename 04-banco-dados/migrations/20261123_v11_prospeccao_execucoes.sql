-- Dias & Fernandes | CRM v11 — Prospecção de Execuções Fiscais (CNPJ) | 2026-11-23
--
-- PRÉ-REQUISITOS: migrações até 20261122_v10_advisor_funcoes.sql. Incremental e idempotente.
--
-- O QUE CRIA:
--   1. prosp_processos: execuções fiscais (classe 1116) do DataJud/CNJ nos TRF1, TRF3 e TRF4,
--      com as partes extraídas do DJEN (polo ativo, executado, CNPJ e valor da causa quando
--      publicados). Fila de processamento: situacao + proxima_tentativa_em.
--   2. prosp_cnpj_cache: dados públicos da base aberta de CNPJ da Receita Federal (razão social,
--      telefones, e-mail, natureza jurídica), com data da consulta para respeitar limites de uso.
--   3. prosp_pgfn_devedores: agregado por CNPJ dos Dados Abertos da PGFN (dívida ativa da União),
--      carregado pelo importador 02-backend-integracao/scripts/importar-pgfn.mjs.
--   4. prosp_auditoria: quem buscou, processou e exportou (LGPD, art. 37: registro das operações).
--   5. View prosp_oportunidades (security_invoker): a lista da tela, já com as regras de negócio
--      (Fazenda Nacional, só CNPJ, valor > R$ 100.000,00, sem empresário individual).
--
-- QUEM ACESSA: só sócios e advogados titulares ativos (crm_cargo_atual()). Estagiário,
-- desenvolvedor e anon não leem nada. Escrita nas tabelas de dados: só a service_role (Edge
-- Function prospeccao-execucoes e importador PGFN). O CRM só grava o registro de exportação.
--
-- REAPLICAÇÃO: o arquivo é idempotente. Rodar de novo recria a view e as funções com as regras
-- mais recentes (tabelas e dados existentes são preservados).
--
-- SEM FUNÇÃO SECURITY DEFINER NOVA: as políticas reaproveitam crm_cargo_atual() e
-- advogado_atual_id() (v8/v4). O gatilho de carimbo de data é SECURITY INVOKER.
-- NÃO MUDA: pode_acessar_ficha, fichas_clientes, funções dfu_* e crm_* existentes.
BEGIN;

DO $crm11_preflight$
BEGIN
  IF to_regprocedure('public.crm_cargo_atual()') IS NULL THEN
    RAISE EXCEPTION 'Pré-requisito ausente: aplique 20261122_v8_hardening_rls.sql antes.';
  END IF;
  IF to_regprocedure('public.crm_fin_contrato_guarda()') IS NULL THEN
    RAISE EXCEPTION 'Pré-requisito ausente: aplique 20261122_v9_security_hardening.sql e a v10 antes.';
  END IF;
END $crm11_preflight$;


-- =====================================================================
-- 1. Processos (DataJud + DJEN)
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.prosp_processos (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  numero_cnj           text NOT NULL UNIQUE CHECK (numero_cnj ~ '^[0-9]{20}$'),
  tribunal             text NOT NULL CHECK (tribunal IN ('TRF1', 'TRF3', 'TRF4')),
  classe_codigo        integer NOT NULL DEFAULT 1116 CHECK (classe_codigo = 1116),
  classe_nome          text NOT NULL DEFAULT 'Execução Fiscal' CHECK (char_length(classe_nome) <= 120),
  data_distribuicao    date,
  orgao_julgador       text CHECK (orgao_julgador IS NULL OR char_length(orgao_julgador) <= 200),
  grau                 text CHECK (grau IS NULL OR char_length(grau) <= 10),
  -- Partes (DJEN). Só CNPJ: CPF nunca é gravado (o CHECK aceita 14 dígitos apenas).
  polo_ativo           text CHECK (polo_ativo IS NULL OR char_length(polo_ativo) <= 200),
  polo_ativo_fazenda   boolean NOT NULL DEFAULT false,
  executado_nome       text CHECK (executado_nome IS NULL OR char_length(executado_nome) <= 200),
  cnpj                 text CHECK (cnpj IS NULL OR cnpj ~ '^[0-9]{14}$'),
  valor_causa          numeric(16, 2) CHECK (valor_causa IS NULL OR valor_causa >= 0),
  valor_fonte          text CHECK (valor_fonte IS NULL OR valor_fonte IN ('datajud', 'djen')),
  fonte_partes         text CHECK (fonte_partes IS NULL OR fonte_partes IN ('djen')),
  -- Fila: pendente → qualificado | sem_publicacao (tenta de novo) | sem_cnpj | fora_do_filtro | erro
  situacao             text NOT NULL DEFAULT 'pendente'
                       CHECK (situacao IN ('pendente', 'qualificado', 'sem_publicacao', 'sem_cnpj', 'fora_do_filtro', 'erro')),
  tentativas           integer NOT NULL DEFAULT 0 CHECK (tentativas >= 0),
  proxima_tentativa_em timestamptz NOT NULL DEFAULT now(),
  consultado_em        timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS prosp_processos_fila_idx ON public.prosp_processos (situacao, proxima_tentativa_em);
CREATE INDEX IF NOT EXISTS prosp_processos_trib_data_idx ON public.prosp_processos (tribunal, data_distribuicao);
CREATE INDEX IF NOT EXISTS prosp_processos_cnpj_idx ON public.prosp_processos (cnpj) WHERE cnpj IS NOT NULL;
COMMENT ON TABLE public.prosp_processos IS
  'Execuções fiscais (classe 1116) dos TRF1/3/4 vindas do DataJud, com partes do DJEN. Escrita só pela service_role (Edge prospeccao-execucoes). Leitura: sócio e advogado.';


-- =====================================================================
-- 2. Cache da base aberta de CNPJ (Receita Federal)
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.prosp_cnpj_cache (
  cnpj                 text PRIMARY KEY CHECK (cnpj ~ '^[0-9]{14}$'),
  razao_social         text CHECK (razao_social IS NULL OR char_length(razao_social) <= 200),
  nome_fantasia        text CHECK (nome_fantasia IS NULL OR char_length(nome_fantasia) <= 200),
  situacao_cadastral   text CHECK (situacao_cadastral IS NULL OR char_length(situacao_cadastral) <= 40),
  natureza_juridica    text CHECK (natureza_juridica IS NULL OR natureza_juridica ~ '^[0-9]{4}$'),
  uf                   text CHECK (uf IS NULL OR uf ~ '^[A-Z]{2}$'),
  municipio            text CHECK (municipio IS NULL OR char_length(municipio) <= 120),
  telefones            text[] NOT NULL DEFAULT '{}' CHECK (cardinality(telefones) <= 3),
  email                text CHECK (email IS NULL OR (char_length(email) <= 200 AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  fonte                text CHECK (fonte IS NULL OR fonte IN ('minhareceita', 'brasilapi', 'cnpjws')),
  encontrado           boolean NOT NULL DEFAULT true,
  consultado_em        timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.prosp_cnpj_cache IS
  'Cache da base aberta de CNPJ da Receita (via APIs públicas). Evita consultas repetidas (validade de 30 dias no código). Escrita só pela service_role.';


-- =====================================================================
-- 3. Dívida ativa da União (Dados Abertos PGFN), agregada por CNPJ
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.prosp_pgfn_devedores (
  cnpj                 text PRIMARY KEY CHECK (cnpj ~ '^[0-9]{14}$'),
  nome                 text NOT NULL CHECK (btrim(nome) <> '' AND char_length(nome) <= 200),
  uf                   text CHECK (uf IS NULL OR uf ~ '^[A-Z]{2}$'),
  valor_ajuizado       numeric(16, 2) NOT NULL DEFAULT 0 CHECK (valor_ajuizado >= 0),
  valor_nao_ajuizado   numeric(16, 2) NOT NULL DEFAULT 0 CHECK (valor_nao_ajuizado >= 0),
  qtd_inscricoes       integer NOT NULL DEFAULT 0 CHECK (qtd_inscricoes >= 0),
  base_referencia      text NOT NULL CHECK (base_referencia ~ '^[0-9]{4}T[1-4]$'),
  importado_em         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS prosp_pgfn_uf_idx ON public.prosp_pgfn_devedores (uf);
COMMENT ON TABLE public.prosp_pgfn_devedores IS
  'Dados Abertos PGFN (dívida ativa da União) agregados por CNPJ. Só pessoa jurídica. Carga pelo importador com service_role.';


-- =====================================================================
-- 4. Auditoria (quem buscou, processou e exportou)
-- O CRM só insere 'exportacao', com autoria forçada (DEFAULT + política); o resto vem da Edge.
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.prosp_auditoria (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  advogado_id     uuid NOT NULL DEFAULT public.advogado_atual_id() REFERENCES public.advogados(id) ON DELETE RESTRICT,
  acao            text NOT NULL CHECK (acao IN ('busca', 'processamento', 'exportacao')),
  parametros      jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(parametros) = 'object' AND pg_column_size(parametros) <= 4000),
  qtd_registros   integer NOT NULL DEFAULT 0 CHECK (qtd_registros BETWEEN 0 AND 100000),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS prosp_auditoria_quando_idx ON public.prosp_auditoria (created_at DESC);
COMMENT ON TABLE public.prosp_auditoria IS
  'Registro das operações de prospecção (LGPD art. 37). Sem UPDATE/DELETE para usuários. Sócio lê tudo; advogado, só o próprio.';


-- =====================================================================
-- 5. Carimbo de atualização (SECURITY INVOKER: nada a expor na API)
-- =====================================================================
CREATE OR REPLACE FUNCTION public.prosp_carimbo_atualizacao()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  NEW.updated_at := now();
  NEW.created_at := OLD.created_at;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.prosp_carimbo_atualizacao() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS prosp_processos_carimbo ON public.prosp_processos;
CREATE TRIGGER prosp_processos_carimbo BEFORE UPDATE ON public.prosp_processos
  FOR EACH ROW EXECUTE FUNCTION public.prosp_carimbo_atualizacao();

-- Jurisdição da Justiça Federal por UF (para a base PGFN, que não tem número de processo).
-- MG saiu do TRF1 para o TRF6 em 2022. Funções puras, sem acesso a tabelas.
CREATE OR REPLACE FUNCTION public.prosp_trf_da_uf(p_uf text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE
    WHEN p_uf IN ('AC','AM','AP','BA','DF','GO','MA','MT','PA','PI','RO','RR','TO') THEN 'TRF1'
    WHEN p_uf IN ('SP','MS') THEN 'TRF3'
    WHEN p_uf IN ('PR','RS','SC') THEN 'TRF4'
  END;
$$;
REVOKE EXECUTE ON FUNCTION public.prosp_trf_da_uf(text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.prosp_trf_da_uf(text) TO authenticated, service_role;

-- Fila de enriquecimento (uso exclusivo da Edge Function, com service_role): CNPJs da lista
-- sem contato em cache ou com cache vencido (30 dias). Processos qualificados primeiro, depois
-- a base PGFN; dentro de cada grupo, do maior valor para o menor. SECURITY INVOKER.
CREATE OR REPLACE FUNCTION public.prosp_cnpjs_para_enriquecer(p_limite integer)
RETURNS TABLE (cnpj text) LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT x.cnpj
    FROM (
      SELECT p.cnpj, coalesce(p.valor_causa, 0) AS valor, 0 AS grupo
        FROM public.prosp_processos p
       WHERE p.situacao = 'qualificado' AND p.cnpj IS NOT NULL
      UNION ALL
      SELECT g.cnpj, g.valor_ajuizado + g.valor_nao_ajuizado, 1
        FROM public.prosp_pgfn_devedores g
       WHERE g.valor_ajuizado + g.valor_nao_ajuizado > 100000
         AND public.prosp_trf_da_uf(g.uf) IS NOT NULL
         AND g.nome !~ '([0-9]{3}\.[0-9]{3}\.[0-9]{3}-[0-9]{2}|(^|[^0-9])[0-9]{11}([^0-9]|$))'  -- MEI: fora do escopo, nem consulta
    ) x
    LEFT JOIN public.prosp_cnpj_cache c ON c.cnpj = x.cnpj
   WHERE c.cnpj IS NULL OR c.consultado_em < now() - interval '30 days'
   GROUP BY x.cnpj
   ORDER BY min(x.grupo), max(x.valor) DESC
   LIMIT least(greatest(coalesce(p_limite, 50), 1), 200);
$$;
REVOKE EXECUTE ON FUNCTION public.prosp_cnpjs_para_enriquecer(integer) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.prosp_cnpjs_para_enriquecer(integer) TO service_role;


-- =====================================================================
-- 6. RLS e privilégios
-- =====================================================================
ALTER TABLE public.prosp_processos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prosp_cnpj_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prosp_pgfn_devedores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prosp_auditoria ENABLE ROW LEVEL SECURITY;

-- Nada para anon; para authenticated, só o que a tela usa. A service_role ignora o RLS.
REVOKE ALL ON public.prosp_processos, public.prosp_cnpj_cache, public.prosp_pgfn_devedores, public.prosp_auditoria
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.prosp_processos, public.prosp_cnpj_cache, public.prosp_pgfn_devedores, public.prosp_auditoria
  TO authenticated;
GRANT INSERT (acao, parametros, qtd_registros) ON public.prosp_auditoria TO authenticated;
GRANT ALL ON public.prosp_processos, public.prosp_cnpj_cache, public.prosp_pgfn_devedores, public.prosp_auditoria
  TO service_role;

DROP POLICY IF EXISTS "prosp processos: leitura titular" ON public.prosp_processos;
CREATE POLICY "prosp processos: leitura titular" ON public.prosp_processos
  FOR SELECT TO authenticated USING ((SELECT public.crm_cargo_atual()) IN ('advogado', 'socio'));

DROP POLICY IF EXISTS "prosp cnpj: leitura titular" ON public.prosp_cnpj_cache;
CREATE POLICY "prosp cnpj: leitura titular" ON public.prosp_cnpj_cache
  FOR SELECT TO authenticated USING ((SELECT public.crm_cargo_atual()) IN ('advogado', 'socio'));

DROP POLICY IF EXISTS "prosp pgfn: leitura titular" ON public.prosp_pgfn_devedores;
CREATE POLICY "prosp pgfn: leitura titular" ON public.prosp_pgfn_devedores
  FOR SELECT TO authenticated USING ((SELECT public.crm_cargo_atual()) IN ('advogado', 'socio'));

DROP POLICY IF EXISTS "prosp auditoria: leitura" ON public.prosp_auditoria;
CREATE POLICY "prosp auditoria: leitura" ON public.prosp_auditoria
  FOR SELECT TO authenticated
  USING ((SELECT public.crm_cargo_atual()) = 'socio'
         OR ((SELECT public.crm_cargo_atual()) = 'advogado' AND advogado_id = (SELECT public.advogado_atual_id())));

DROP POLICY IF EXISTS "prosp auditoria: exportação" ON public.prosp_auditoria;
CREATE POLICY "prosp auditoria: exportação" ON public.prosp_auditoria
  FOR INSERT TO authenticated
  WITH CHECK (acao = 'exportacao'
              AND advogado_id = (SELECT public.advogado_atual_id())
              AND (SELECT public.crm_cargo_atual()) IN ('advogado', 'socio'));
-- Sem UPDATE/DELETE para authenticated em nenhuma tabela prosp_*.


-- =====================================================================
-- 7. Lista da tela: prosp_oportunidades (security_invoker = RLS de quem consulta)
-- Regras:
--   * polo ativo Fazenda Nacional (a Edge não marca "União Federal" genérica como Fazenda);
--   * só CNPJ: fora o empresário individual/MEI (natureza 2135 ou CPF no nome, que é como a
--     Receita monta a razão social dele) e o CNPJ que a Receita não encontrou;
--   * valor > R$ 100.000,00. Processo sem valor publicado usa o total AJUIZADO na PGFN do
--     mesmo CNPJ (valor_fonte = 'pgfn');
--   * sem duplicar: a linha da PGFN só aparece se o CNPJ ainda não está na lista por processo.
-- cadastro_verificado = o CNPJ já passou pela base da Receita (natureza conhecida). A ordem
-- (maior valor primeiro) é aplicada na consulta do CRM.
-- =====================================================================
DROP VIEW IF EXISTS public.prosp_oportunidades;
CREATE VIEW public.prosp_oportunidades WITH (security_invoker = true) AS
WITH base AS (
  SELECT 'processo'::text                                  AS origem,
         p.numero_cnj                                      AS chave,
         p.cnpj,
         coalesce(c.razao_social, p.executado_nome)        AS nome,
         p.data_distribuicao,
         p.polo_ativo,
         p.numero_cnj                                      AS numero_processo,
         p.tribunal,
         coalesce(p.valor_causa, nullif(g.valor_ajuizado, 0)) AS valor_causa,
         CASE WHEN p.valor_causa IS NOT NULL THEN p.valor_fonte
              WHEN g.valor_ajuizado > 0 THEN 'pgfn' END    AS valor_fonte,
         p.classe_nome                                     AS classe,
         c.telefones,
         c.email,
         c.situacao_cadastral,
         c.natureza_juridica,
         coalesce(c.uf, g.uf)                              AS uf,
         c.consultado_em                                   AS contato_consultado_em,
         c.encontrado
    FROM public.prosp_processos p
    LEFT JOIN public.prosp_cnpj_cache c ON c.cnpj = p.cnpj
    LEFT JOIN public.prosp_pgfn_devedores g ON g.cnpj = p.cnpj
   WHERE p.cnpj IS NOT NULL AND p.polo_ativo_fazenda
  UNION ALL
  SELECT 'pgfn',
         'pgfn:' || g.cnpj,
         g.cnpj,
         coalesce(c.razao_social, g.nome),
         NULL::date,
         'Fazenda Nacional (PGFN)',
         NULL,
         public.prosp_trf_da_uf(g.uf),
         g.valor_ajuizado + g.valor_nao_ajuizado,
         'pgfn',
         CASE WHEN g.valor_ajuizado > 0 THEN 'Dívida ativa da União (com inscrição ajuizada)'
              ELSE 'Dívida ativa da União (não ajuizada)' END,
         c.telefones,
         c.email,
         c.situacao_cadastral,
         c.natureza_juridica,
         g.uf,
         c.consultado_em,
         c.encontrado
    FROM public.prosp_pgfn_devedores g
    LEFT JOIN public.prosp_cnpj_cache c ON c.cnpj = g.cnpj
   WHERE public.prosp_trf_da_uf(g.uf) IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.prosp_processos p2
                      WHERE p2.cnpj = g.cnpj AND p2.polo_ativo_fazenda)
)
SELECT origem, chave, cnpj, nome, data_distribuicao, polo_ativo, numero_processo, tribunal,
       valor_causa, valor_fonte, classe,
       array_to_string(coalesce(telefones, '{}'), ' / ') AS telefone,
       email, situacao_cadastral, natureza_juridica, uf, contato_consultado_em,
       (natureza_juridica IS NOT NULL) AS cadastro_verificado
  FROM base
 WHERE valor_causa > 100000
   AND coalesce(natureza_juridica, '') <> '2135'
   AND coalesce(nome, '') !~ '([0-9]{3}\.[0-9]{3}\.[0-9]{3}-[0-9]{2}|(^|[^0-9])[0-9]{11}([^0-9]|$))'
   AND encontrado IS NOT FALSE;

REVOKE ALL ON public.prosp_oportunidades FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.prosp_oportunidades TO authenticated, service_role;
COMMENT ON VIEW public.prosp_oportunidades IS
  'Lista de prospecção (Fazenda Nacional, CNPJ, valor > R$ 100 mil). security_invoker: aplica o RLS das tabelas prosp_* a quem consulta.';

NOTIFY pgrst, 'reload schema';
COMMIT;

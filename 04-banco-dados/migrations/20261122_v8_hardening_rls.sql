-- Dias & Fernandes | CRM v8 — Blindagem de RLS (skill appsec-juridico) | 2026-11-22
--
-- PRÉ-REQUISITOS: migrações até 20261119_v7_financeiro_documentos.sql. Incremental e idempotente.
--
-- O QUE MUDA (remove as duas políticas USING (true) que restavam):
--   1. advogados: deixa de ser legível por qualquer usuário logado ("equipe lê advogados",
--      schema.sql seção 5.3). Agora:
--        * cada um lê a PRÓPRIA linha (pelo e-mail do JWT, mesmo inativo: o login precisa
--          dela para mostrar "acesso desativado");
--        * equipe real ativa (advogado, sócio, estagiário) lê a equipe real;
--        * conta 'desenvolvedor' lê só a si mesma, e a equipe real não vê contas de
--          desenvolvedor (isolamento nos dois sentidos);
--        * usuário autenticado sem cadastro (ou com e-mail não vinculado) não lê nada.
--   2. dfu_feriados: leitura só para quem tem perfil ativo no escritório.
--
-- Funções SECURITY DEFINER (pode_acessar_ficha, crm_*, dfu_*) e a service_role (bot)
-- não passam pelo RLS: rodízio, indicadores e RPCs continuam iguais.
-- NÃO MUDA: pode_acessar_ficha, nenhuma outra política, nenhuma função dfu_*.
BEGIN;

DO $crm8_preflight$
BEGIN
  IF to_regprocedure('public.crm_pode_acessar_ficha_id(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Pré-requisito ausente: aplique 20261119_v7_financeiro_documentos.sql antes.';
  END IF;
  IF to_regclass('public.dfu_feriados') IS NULL THEN
    RAISE EXCEPTION 'Pré-requisito ausente: aplique 20261118_bot_unificado.sql antes.';
  END IF;
END $crm8_preflight$;


-- =====================================================================
-- 1. advogados
-- =====================================================================
-- Cargo do usuário logado e ativo (NULL se não houver). SECURITY DEFINER evita a
-- recursão de uma política de advogados que consulta a própria tabela.
CREATE OR REPLACE FUNCTION public.crm_cargo_atual()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT a.cargo FROM public.advogados a
   WHERE lower(a.email) = lower(auth.jwt() ->> 'email') AND a.ativo IS TRUE
   LIMIT 1;
$$;
REVOKE EXECUTE ON FUNCTION public.crm_cargo_atual() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.crm_cargo_atual() TO authenticated;

ALTER TABLE public.advogados ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.advogados FROM anon;

DROP POLICY IF EXISTS "equipe lê advogados" ON public.advogados;
DROP POLICY IF EXISTS "advogados: leitura restrita" ON public.advogados;
CREATE POLICY "advogados: leitura restrita" ON public.advogados
  FOR SELECT TO authenticated
  USING (
    -- a própria linha (login, inclusive para avisar que o acesso está desativado)
    (auth.jwt() ->> 'email') IS NOT NULL AND lower(email) = lower(auth.jwt() ->> 'email')
    OR
    -- equipe real ativa lê a equipe real; contas de desenvolvedor ficam de fora
    (public.crm_cargo_atual() IN ('advogado', 'socio', 'estagiario')
     AND cargo IN ('advogado', 'socio', 'estagiario'))
  );
-- Sem INSERT/UPDATE/DELETE para authenticated: cadastro da equipe é feito pela administração.


-- =====================================================================
-- 2. dfu_feriados (sem dado pessoal, mas sem leitura irrestrita)
-- =====================================================================
DROP POLICY IF EXISTS "crm feriados leitura" ON public.dfu_feriados;
CREATE POLICY "crm feriados leitura" ON public.dfu_feriados
  FOR SELECT TO authenticated
  USING ((SELECT public.advogado_atual_id()) IS NOT NULL);


-- =====================================================================
-- 3. Conferência: nenhuma política permissiva USING (true) para authenticated/public
-- em tabelas do schema public. Só AVISA (não desfaz os ajustes acima): uma política criada
-- fora dos arquivos do repositório (pelo painel, por exemplo) aparece aqui para revisão.
-- =====================================================================
DO $crm8_confere$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT tablename, policyname FROM pg_policies
     WHERE schemaname = 'public'
       AND permissive = 'PERMISSIVE'
       AND (roles && ARRAY['authenticated', 'public']::name[])
       AND (btrim(coalesce(qual, '')) = 'true' OR btrim(coalesce(with_check, '')) = 'true')
  LOOP
    RAISE WARNING 'Política irrestrita encontrada: %.% — revise.', r.tablename, r.policyname;
  END LOOP;
END $crm8_confere$;

NOTIFY pgrst, 'reload schema';
COMMIT;

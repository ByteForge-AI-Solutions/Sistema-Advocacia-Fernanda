-- Dias & Fernandes | CRM v10 — Avisos do Supabase Security Advisor | 2026-11-22
--
-- PRÉ-REQUISITOS: migrações até 20261122_v9_security_hardening.sql. Incremental e idempotente.
--
-- 1) Lint 0028/0029 em FUNÇÕES DE GATILHO (crm_agenda_enfileirar_google, crm_fin_acompanhar_ficha,
--    crm_fin_avancar_funil, crm_fin_contrato_guarda, dfu_proteger_agenda): o Postgres recusa
--    chamá-las fora de um gatilho, mas o EXECUTE padrão do Supabase as deixava expostas em
--    /rest/v1/rpc. Removido de PUBLIC, anon e authenticated. Gatilho NÃO depende de EXECUTE do
--    usuário que dispara a escrita (só de quem criou o gatilho), então nada muda no CRM nem no bot.
--    Para dfu_proteger_agenda (bot) só muda a permissão: a função não é redefinida.
--
-- 2) Lint 0029 nas RPCs e funções de autorização (pode_acessar_ficha, crm_pode_*, crm_atendimento_*,
--    crm_indicadores*, crm_ficha_assumir, dfu_assumir_atendimento...): INTENCIONAL. As RPCs são a
--    API do CRM e validam o chamador por dentro; as funções de autorização são usadas pelas
--    políticas RLS, que rodam com o papel de quem consulta — sem EXECUTE para authenticated, o RLS
--    falharia para todos. Elas só respondem sobre o próprio usuário (sem vazamento). Documentado
--    nos comentários abaixo.
--
-- 3) Lint 0008 (RLS sem política) em agenda_google_fila, agenda_google_notificacoes,
--    conversas_memoria, dfu_erros, dfu_origens, dfu_revisoes: INTENCIONAL (negar tudo). São
--    tabelas só do servidor (bot/worker com service_role, que ignora o RLS). Documentado abaixo.
BEGIN;

DO $crm10_preflight$
BEGIN
  IF to_regprocedure('public.crm_fin_contrato_guarda()') IS NULL THEN
    RAISE EXCEPTION 'Pré-requisito ausente: aplique 20261122_v9_security_hardening.sql antes.';
  END IF;
END $crm10_preflight$;


-- =====================================================================
-- 1. Funções de gatilho fora da API
-- =====================================================================
DO $crm10_gatilhos$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.crm_agenda_enfileirar_google()', 'public.crm_fin_acompanhar_ficha()',
    'public.crm_fin_avancar_funil()', 'public.crm_fin_contrato_guarda()', 'public.dfu_proteger_agenda()'] LOOP
    IF to_regprocedure(f) IS NOT NULL THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    END IF;
  END LOOP;
END $crm10_gatilhos$;


-- =====================================================================
-- 2. Exceções intencionais documentadas (aparecem no painel em Database → Functions/Tables)
-- =====================================================================
COMMENT ON FUNCTION public.pode_acessar_ficha(uuid) IS
  'Autorização usada pelas políticas RLS. EXECUTE para authenticated é obrigatório (RLS roda com o papel do usuário). Responde só sobre o próprio usuário. Aviso 0029 do Advisor: intencional.';
COMMENT ON FUNCTION public.advogado_atual_id() IS
  'Id do advogado logado (pelo e-mail do JWT). Usada por políticas RLS; devolve só o próprio id. Aviso 0029: intencional.';
COMMENT ON FUNCTION public.crm_cargo_atual() IS
  'Cargo do usuário logado. Usada pela política de advogados (evita recursão). Aviso 0029: intencional.';
COMMENT ON FUNCTION public.crm_pode_acessar_ficha_id(uuid) IS
  'Visibilidade de uma ficha para o usuário logado (RLS de cadastro, financeiro e documentos). Falso para ficha inexistente ou alheia. Aviso 0029: intencional.';
COMMENT ON FUNCTION public.crm_pode_excluir() IS
  'Se o usuário logado pode excluir (titular, sócio, desenvolvedor). Usada por políticas RLS. Aviso 0029: intencional.';
COMMENT ON FUNCTION public.crm_pode_acessar_objeto(text) IS
  'Acesso a um arquivo do bucket documentos-clientes pela ficha do caminho. Usada pelas políticas do Storage. Aviso 0029: intencional.';
COMMENT ON FUNCTION public.crm_titular_da_area(text) IS
  'Se o usuário logado é titular/sócio da área (registros sem responsável). Usada por políticas RLS. Aviso 0029: intencional.';
COMMENT ON FUNCTION public.crm_pode_acessar_atendimento(text) IS
  'Acesso do usuário logado a um atendimento. Usada por políticas RLS e pelas RPCs crm_atendimento_*. Aviso 0029: intencional.';

COMMENT ON TABLE public.conversas_memoria IS 'Só servidor (service_role). RLS sem política = nega tudo a anon/authenticated. Aviso 0008: intencional.';
COMMENT ON TABLE public.dfu_erros IS 'Só servidor (service_role). RLS sem política = nega tudo a anon/authenticated. Aviso 0008: intencional.';
COMMENT ON TABLE public.dfu_origens IS 'Só servidor (service_role). RLS sem política = nega tudo a anon/authenticated. Aviso 0008: intencional.';
COMMENT ON TABLE public.dfu_revisoes IS 'Só servidor (service_role). RLS sem política = nega tudo a anon/authenticated. Aviso 0008: intencional.';
COMMENT ON TABLE public.agenda_google_fila IS 'Fila do worker Google (service_role). RLS sem política = nega tudo a anon/authenticated. Aviso 0008: intencional.';
COMMENT ON TABLE public.agenda_google_notificacoes IS 'Avisos do webhook Google (service_role). RLS sem política = nega tudo a anon/authenticated. Aviso 0008: intencional.';

-- Defesa em profundidade: confirma que essas tabelas não têm privilégio para anon/authenticated.
REVOKE ALL ON public.conversas_memoria, public.dfu_erros, public.dfu_origens, public.dfu_revisoes,
  public.agenda_google_fila, public.agenda_google_notificacoes FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;

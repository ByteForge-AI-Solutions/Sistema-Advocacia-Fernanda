-- Dias & Fernandes | CRM v9 — Auditoria AppSec: correções de autorização e integridade | 2026-11-22
--
-- PRÉ-REQUISITOS: migrações até 20261122_v8_hardening_rls.sql. Incremental e idempotente.
--
-- FALHAS CORRIGIDAS (detalhes no relatório da auditoria):
--   F1 Financeiro autorizado pelo advogado do CONTRATO, não pela ficha: depois de uma
--      transferência, o advogado antigo continuava lendo valores/parcelas e o novo não via
--      nada. Agora: acesso = acesso à ficha (crm_pode_acessar_ficha_id); advogado_id do
--      contrato é forçado a acompanhar o responsável da ficha.
--   F2 Atribuição em massa em fichas_clientes: qualquer usuário com acesso podia reescrever
--      via API colunas do bot e de auditoria (resumo_fatos, telefone, cpf, created_at,
--      temperatura, etapa_desde, cadencia_desde...). Agora só as colunas que o CRM edita.
--   F3 Adulteração financeira por estagiário: podia mudar valor/vencimento de parcelas,
--      desfazer pagamentos, cancelar contratos e trocar a ficha/valor do contrato (só a
--      exclusão era bloqueada). Agora essas operações são exclusivas de titular/sócio.
--   F4 Storage aceitava qualquer nome de objeto dentro da pasta da ficha (nome com dados
--      pessoais, extensão diferente do tipo). Agora: "<uuid-ficha>/<uuid>.<ext permitida>".
--   F5 Campos de autoria forjáveis no INSERT (fin_contratos.criado_por, processos_prazos.criado_por).
--   +  Defesa em profundidade: anon sem nenhum privilégio nas tabelas do CRM; CHECKs de
--      MIME/caminho em fichas_documentos.
--
-- NÃO MUDA: pode_acessar_ficha, políticas de fichas/agenda/atendimentos, funções dfu_* do bot.
-- Bot e RPCs SECURITY DEFINER não são afetados pelas restrições de coluna (service_role/dono).
BEGIN;

DO $crm9_preflight$
BEGIN
  IF to_regprocedure('public.crm_cargo_atual()') IS NULL THEN
    RAISE EXCEPTION 'Pré-requisito ausente: aplique 20261122_v8_hardening_rls.sql antes.';
  END IF;
  IF to_regclass('public.fin_contratos') IS NULL OR to_regclass('public.fichas_documentos') IS NULL THEN
    RAISE EXCEPTION 'Pré-requisito ausente: aplique 20261119_v7_financeiro_documentos.sql antes.';
  END IF;
END $crm9_preflight$;


-- =====================================================================
-- F1. Financeiro autorizado pela ficha
-- =====================================================================
-- Contrato: advogado_id acompanha a ficha (ou quem cria, se a ficha não tem responsável);
-- a ficha do contrato não muda; campos financeiros só titular/sócio altera; autoria forçada.
CREATE OR REPLACE FUNCTION public.crm_fin_contrato_guarda()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_resp uuid;
BEGIN
  SELECT advogado_id INTO v_resp FROM public.fichas_clientes WHERE id = NEW.ficha_id;
  NEW.advogado_id := coalesce(v_resp, NEW.advogado_id);

  IF TG_OP = 'INSERT' THEN
    -- Autoria vem do JWT; sem JWT (bot/SQL do dono) mantém o informado.
    NEW.criado_por := coalesce(public.advogado_atual_id(), NEW.criado_por);
    RETURN NEW;
  END IF;

  IF NEW.ficha_id IS DISTINCT FROM OLD.ficha_id THEN
    RAISE EXCEPTION 'Um contrato não pode mudar de ficha.' USING ERRCODE = '42501', HINT = 'crm_sem_acesso';
  END IF;
  NEW.criado_por := OLD.criado_por;
  NEW.created_at := OLD.created_at;
  -- Só usuários do CRM (JWT) passam por aqui; sincronizações do sistema não têm JWT.
  IF public.advogado_atual_id() IS NOT NULL AND NOT public.crm_pode_excluir()
     AND (NEW.tipo, NEW.valor_total, NEW.forma_pagamento, NEW.percentual_exito, NEW.cancelado)
         IS DISTINCT FROM (OLD.tipo, OLD.valor_total, OLD.forma_pagamento, OLD.percentual_exito, OLD.cancelado) THEN
    RAISE EXCEPTION 'Só titulares e sócios alteram valores ou cancelam contratos.' USING ERRCODE = '42501', HINT = 'crm_sem_acesso';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS crm_fin_contrato_guarda ON public.fin_contratos;
CREATE TRIGGER crm_fin_contrato_guarda BEFORE INSERT OR UPDATE ON public.fin_contratos
  FOR EACH ROW EXECUTE FUNCTION public.crm_fin_contrato_guarda();

-- Transferência/assunção da ficha leva junto o responsável dos contratos.
CREATE OR REPLACE FUNCTION public.crm_fin_acompanhar_ficha()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.advogado_id IS NOT NULL AND NEW.advogado_id IS DISTINCT FROM OLD.advogado_id THEN
    UPDATE public.fin_contratos SET advogado_id = NEW.advogado_id WHERE ficha_id = NEW.id;
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS crm_fin_acompanhar_ficha ON public.fichas_clientes;
CREATE TRIGGER crm_fin_acompanhar_ficha AFTER UPDATE OF advogado_id ON public.fichas_clientes
  FOR EACH ROW EXECUTE FUNCTION public.crm_fin_acompanhar_ficha();

-- Corrige contratos já desalinhados (roda como dono: sem JWT, sem bloqueio de cargo).
UPDATE public.fin_contratos c SET advogado_id = f.advogado_id
  FROM public.fichas_clientes f
 WHERE f.id = c.ficha_id AND f.advogado_id IS NOT NULL AND c.advogado_id IS DISTINCT FROM f.advogado_id;

DROP POLICY IF EXISTS "fin contratos: leitura" ON public.fin_contratos;
CREATE POLICY "fin contratos: leitura" ON public.fin_contratos
  FOR SELECT TO authenticated USING (public.crm_pode_acessar_ficha_id(ficha_id));
DROP POLICY IF EXISTS "fin contratos: criação" ON public.fin_contratos;
CREATE POLICY "fin contratos: criação" ON public.fin_contratos
  FOR INSERT TO authenticated WITH CHECK (public.crm_pode_acessar_ficha_id(ficha_id));
DROP POLICY IF EXISTS "fin contratos: atualização" ON public.fin_contratos;
CREATE POLICY "fin contratos: atualização" ON public.fin_contratos
  FOR UPDATE TO authenticated
  USING (public.crm_pode_acessar_ficha_id(ficha_id)) WITH CHECK (public.crm_pode_acessar_ficha_id(ficha_id));
DROP POLICY IF EXISTS "fin contratos: exclusão por titular" ON public.fin_contratos;
CREATE POLICY "fin contratos: exclusão por titular" ON public.fin_contratos
  FOR DELETE TO authenticated USING (public.crm_pode_acessar_ficha_id(ficha_id) AND public.crm_pode_excluir());

DROP POLICY IF EXISTS "fin parcelas: leitura" ON public.fin_parcelas;
CREATE POLICY "fin parcelas: leitura" ON public.fin_parcelas
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.fin_contratos c WHERE c.id = fin_parcelas.contrato_id AND public.crm_pode_acessar_ficha_id(c.ficha_id)));
DROP POLICY IF EXISTS "fin parcelas: criação" ON public.fin_parcelas;
CREATE POLICY "fin parcelas: criação" ON public.fin_parcelas
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.fin_contratos c WHERE c.id = fin_parcelas.contrato_id AND public.crm_pode_acessar_ficha_id(c.ficha_id)));
DROP POLICY IF EXISTS "fin parcelas: atualização" ON public.fin_parcelas;
CREATE POLICY "fin parcelas: atualização" ON public.fin_parcelas
  FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.fin_contratos c WHERE c.id = fin_parcelas.contrato_id AND public.crm_pode_acessar_ficha_id(c.ficha_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.fin_contratos c WHERE c.id = fin_parcelas.contrato_id AND public.crm_pode_acessar_ficha_id(c.ficha_id)));
DROP POLICY IF EXISTS "fin parcelas: exclusão por titular" ON public.fin_parcelas;
CREATE POLICY "fin parcelas: exclusão por titular" ON public.fin_parcelas
  FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.fin_contratos c WHERE c.id = fin_parcelas.contrato_id AND public.crm_pode_acessar_ficha_id(c.ficha_id))
         AND public.crm_pode_excluir());


-- =====================================================================
-- F3. Parcelas: o que o estagiário pode e não pode (mesma função da v7, ampliada)
-- Todos com acesso: registrar pagamento (data, valor pago, meio, comprovante, observação).
-- Só titular/sócio: alterar valor/vencimento e desfazer pagamento. Ninguém: trocar contrato/número.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.crm_fin_parcela_valida()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.contrato_id IS DISTINCT FROM OLD.contrato_id OR NEW.numero IS DISTINCT FROM OLD.numero THEN
      RAISE EXCEPTION 'Contrato e número da parcela não podem ser alterados.' USING ERRCODE = '42501', HINT = 'crm_sem_acesso';
    END IF;
    IF public.advogado_atual_id() IS NOT NULL AND NOT public.crm_pode_excluir()
       AND ((NEW.valor, NEW.vencimento) IS DISTINCT FROM (OLD.valor, OLD.vencimento)
            OR (OLD.pago_em IS NOT NULL AND NEW.pago_em IS NULL)) THEN
      RAISE EXCEPTION 'Só titulares e sócios alteram valores/vencimentos ou desfazem pagamentos.'
        USING ERRCODE = '42501', HINT = 'crm_sem_acesso';
    END IF;
  END IF;
  IF NEW.comprovante_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.fichas_documentos d JOIN public.fin_contratos c ON c.ficha_id = d.ficha_id
        WHERE d.id = NEW.comprovante_id AND c.id = NEW.contrato_id) THEN
    RAISE EXCEPTION 'O comprovante precisa ser um documento da mesma ficha.' USING ERRCODE = '23514', HINT = 'crm_comprovante_invalido';
  END IF;
  IF NEW.pago_em IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.pago_em IS NULL) THEN
    NEW.registrado_por := public.advogado_atual_id();
    NEW.registrado_em := now();
  ELSIF NEW.pago_em IS NULL THEN
    NEW.registrado_por := NULL;
    NEW.registrado_em := NULL;
  ELSE
    NEW.registrado_por := OLD.registrado_por;
    NEW.registrado_em := OLD.registrado_em;
  END IF;
  RETURN NEW;
END;
$$;


-- =====================================================================
-- F2. fichas_clientes: só as colunas que o CRM edita (atribuição em massa)
-- Lista = salvarLead (src/lib/leads.ts) + crm_followup_registrar + delegação (advogado_id).
-- Coluna nova editável pela tela precisa entrar aqui, senão o PostgREST devolve 42501.
-- =====================================================================
REVOKE UPDATE ON public.fichas_clientes FROM authenticated;
GRANT UPDATE (advogado_id, status_atendimento, proxima_acao, proxima_acao_em, faixa_divida,
              bloqueio_penhora, dor_principal, onde_divida, etapa_funil, motivo_perda,
              motivo_perda_detalhe, nao_contatar)
  ON public.fichas_clientes TO authenticated;


-- =====================================================================
-- F4. Storage e metadados de documentos
-- =====================================================================
DROP POLICY IF EXISTS "crm documentos: envio" ON storage.objects;
CREATE POLICY "crm documentos: envio" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'documentos-clientes'
              AND name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|jpg|png|webp|docx|xlsx)$'
              AND public.crm_pode_acessar_objeto(name));

DO $crm9_docs$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documentos_mime_permitido') THEN
    ALTER TABLE public.fichas_documentos ADD CONSTRAINT documentos_mime_permitido CHECK (tipo_mime IN (
      'application/pdf', 'image/jpeg', 'image/png', 'image/webp',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documentos_caminho_anonimo') THEN
    ALTER TABLE public.fichas_documentos ADD CONSTRAINT documentos_caminho_anonimo CHECK (
      caminho ~ '^[0-9a-f-]{36}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|jpg|png|webp|docx|xlsx)$') NOT VALID;
  END IF;
END $crm9_docs$;


-- =====================================================================
-- F5. Autoria forçada em prazos (mesma função da v3, com criado_por do JWT)
-- =====================================================================
CREATE OR REPLACE FUNCTION public.crm_prazos_carimbos()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  NEW.updated_at := now();
  IF TG_OP = 'INSERT' THEN
    NEW.criado_por := coalesce(public.advogado_atual_id(), NEW.criado_por);
  ELSE
    NEW.criado_por := OLD.criado_por;
    NEW.created_at := OLD.created_at;
  END IF;
  IF NEW.status = 'cumprido' THEN
    IF TG_OP = 'INSERT' OR OLD.status <> 'cumprido' THEN NEW.cumprido_em := now(); END IF;
  ELSE
    NEW.cumprido_em := NULL;
  END IF;
  RETURN NEW;
END;
$$;


-- =====================================================================
-- Defesa em profundidade: a chave anon (pública) não tem privilégio em tabela do CRM.
-- O RLS já negava; aqui nem o privilégio existe. Login usa a API de Auth, não tabelas.
-- =====================================================================
REVOKE ALL ON public.advogados, public.fichas_clientes, public.agenda_advogados,
  public.disponibilidade_advogados, public.processos_prazos, public.dfu_notas_internas,
  public.agenda_google_contas, public.agenda_google_fila, public.agenda_google_notificacoes,
  public.crm_followup_toques, public.clientes_cadastro, public.fichas_documentos,
  public.fin_contratos, public.fin_parcelas
  FROM anon;

-- Funções de gatilho (crm_fin_contrato_guarda, crm_fin_acompanhar_ficha) não ganham REVOKE:
-- o Postgres recusa chamá-las fora de um gatilho, e o RPC do PostgREST não as executa.

NOTIFY pgrst, 'reload schema';
COMMIT;

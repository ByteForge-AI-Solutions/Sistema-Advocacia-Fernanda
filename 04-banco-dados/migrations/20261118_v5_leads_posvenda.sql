-- Dias & Fernandes | CRM v5 — Leads (próxima ação, prioridade por cor) e pós-venda | 2026-11-18
--
-- Base: documento "CRM de leads de anúncio" (Caio Melo, nov/2026), seções 1, 3, 4, 7, 8 e 11.
--
-- PRÉ-REQUISITOS (nesta ordem): schema.sql (seções 1–8, NUNCA reexecute inteiro),
-- 20261118_bot_unificado.sql, 20261118_v3_crm_modulos.sql, 20261118_v4_cargo_socio.sql.
-- Incremental e idempotente (pode rodar mais de uma vez).
--
-- O QUE MUDA:
--   1. fichas_clientes: próxima ação (texto + data), qualificação do lead (faixa de
--      dívida, bloqueio/penhora, dor principal, onde está a dívida) e a "temperatura"
--      calculada pelo banco (urgente/quente/morno/frio).
--   2. Regra de ouro: o CRM não salva um lead ativo sem próxima ação (trigger).
--      O bot (service_role) e as RPCs SECURITY DEFINER NÃO são afetados.
--   3. processos_prazos: categorias de pós-venda (parcela de acordo, certidão,
--      execução fiscal, embargos), identificação do acordo e nº da parcela.
--
-- LGPD (seção 11 do documento): a dívida é guardada só em FAIXA (minimização), não em
-- valor exato; simulações do CRM são calculadas no navegador e nunca gravadas; o
-- texto da próxima ação recusa CPF/CNPJ (ele aparece na fila e na agenda).
--
-- RLS: nenhuma política nova. As colunas novas herdam as políticas existentes
-- (pode_acessar_ficha), inclusive o isolamento das contas 'desenvolvedor'.
BEGIN;

DO $crm5_preflight$
BEGIN
  IF to_regclass('public.fichas_clientes') IS NULL OR to_regclass('public.processos_prazos') IS NULL THEN
    RAISE EXCEPTION 'Pré-requisito ausente: aplique o CRM e a migração v3 antes.';
  END IF;
  IF to_regprocedure('public.crm_ficha_assumir(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Pré-requisito ausente: aplique 20261118_v4_cargo_socio.sql antes.';
  END IF;
END $crm5_preflight$;


-- =====================================================================
-- 1. FICHA DO LEAD: próxima ação e qualificação
-- =====================================================================
ALTER TABLE public.fichas_clientes
  ADD COLUMN IF NOT EXISTS proxima_acao      text,
  ADD COLUMN IF NOT EXISTS proxima_acao_em   timestamptz,
  ADD COLUMN IF NOT EXISTS faixa_divida      text,
  ADD COLUMN IF NOT EXISTS bloqueio_penhora  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS dor_principal     text,
  ADD COLUMN IF NOT EXISTS onde_divida       text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS temperatura       text;

DO $crm5_checks_ficha$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fichas_faixa_divida_valida') THEN
    ALTER TABLE public.fichas_clientes ADD CONSTRAINT fichas_faixa_divida_valida
      CHECK (faixa_divida IS NULL OR faixa_divida IN ('ate_50k', '50k_100k', '100k_500k', 'acima_500k'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fichas_dor_principal_valida') THEN
    ALTER TABLE public.fichas_clientes ADD CONSTRAINT fichas_dor_principal_valida
      CHECK (dor_principal IS NULL OR dor_principal IN ('certidao', 'bens', 'execucao', 'parcelamento', 'outra'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fichas_onde_divida_valida') THEN
    ALTER TABLE public.fichas_clientes ADD CONSTRAINT fichas_onde_divida_valida
      CHECK (onde_divida <@ ARRAY['receita', 'pgfn', 'estado', 'municipio', 'justica']::text[]);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fichas_temperatura_valida') THEN
    ALTER TABLE public.fichas_clientes ADD CONSTRAINT fichas_temperatura_valida
      CHECK (temperatura IS NULL OR temperatura IN ('urgente', 'quente', 'morno', 'frio'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fichas_proxima_acao_tamanho') THEN
    ALTER TABLE public.fichas_clientes ADD CONSTRAINT fichas_proxima_acao_tamanho
      CHECK (proxima_acao IS NULL OR char_length(proxima_acao) <= 280);
  END IF;
END $crm5_checks_ficha$;

CREATE INDEX IF NOT EXISTS idx_fichas_proxima_acao_em ON public.fichas_clientes (advogado_id, proxima_acao_em);

-- 1.1 Prioridade automática (seção 4 do documento). Espelhada em
-- 03-crm-frontend/src/lib/leads.ts (calcularTemperatura): mantenha as duas iguais.
--   urgente: bloqueio de conta, penhora ou citação recebida;
--   quente : acima de R$ 100 mil e dor de certidão, bens ou execução;
--   morno  : acima de R$ 100 mil e urgência baixa
--            (também: até R$ 100 mil COM dor de certidão, bens ou execução — o
--             documento não define esse caso; fica um nível acima do frio);
--   frio   : até R$ 100 mil e urgência baixa;
--   ajuste : dívida só na Receita e sem urgência desce uma cor (morno → frio).
--   NULL   : faixa de dívida não informada e sem bloqueio (lead ainda não qualificado;
--            a fila usa a prioridade do bot).
-- O ajuste "respondeu em menos de 1 hora sobe uma cor" depende do tempo de
-- resposta e ainda não é calculado.
CREATE OR REPLACE FUNCTION public.crm_temperatura_lead(
  p_faixa text, p_bloqueio boolean, p_dor text, p_onde text[])
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE
  v_dor_urgente boolean := coalesce(p_dor IN ('certidao', 'bens', 'execucao'), false);
  v_acima boolean;
  v text;
BEGIN
  IF coalesce(p_bloqueio, false) THEN RETURN 'urgente'; END IF;
  IF p_faixa IS NULL THEN RETURN NULL; END IF;
  v_acima := p_faixa IN ('100k_500k', 'acima_500k');
  v := CASE
         WHEN v_acima AND v_dor_urgente THEN 'quente'
         WHEN v_acima OR v_dor_urgente  THEN 'morno'
         ELSE 'frio'
       END;
  IF v = 'morno' AND NOT v_dor_urgente AND coalesce(p_onde, '{}') = ARRAY['receita']::text[] THEN
    v := 'frio';
  END IF;
  RETURN v;
END;
$$;

-- 1.2 Trigger da ficha: calcula a temperatura e aplica a regra de ouro.
-- A regra só vale para edições DIRETAS do CRM (current_user = 'authenticated',
-- via PostgREST). O bot usa service_role e as RPCs do CRM rodam como dono da
-- função (SECURITY DEFINER): nenhuma delas é bloqueada por fichas antigas sem data.
CREATE OR REPLACE FUNCTION public.crm_fichas_lead()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_ativo boolean;
BEGIN
  NEW.proxima_acao := nullif(btrim(coalesce(NEW.proxima_acao, '')), '');
  NEW.onde_divida := coalesce(NEW.onde_divida, '{}');
  NEW.temperatura := public.crm_temperatura_lead(NEW.faixa_divida, NEW.bloqueio_penhora,
                                                NEW.dor_principal, NEW.onde_divida);

  IF current_user = 'authenticated' THEN
    v_ativo := lower(btrim(coalesce(NEW.status_atendimento, 'novo'))) <> 'finalizado';
    IF v_ativo AND (NEW.proxima_acao IS NULL OR NEW.proxima_acao_em IS NULL) THEN
      RAISE EXCEPTION 'Lead ativo precisa de próxima ação e data.'
        USING ERRCODE = '23514', HINT = 'crm_proxima_acao_obrigatoria';
    END IF;
    -- CPF/CNPJ formatados (ou CNPJ só com dígitos) não entram no texto da próxima
    -- ação, que aparece em listas. O CRM também confere os dígitos verificadores.
    IF NEW.proxima_acao ~ '[0-9]{3}\.[0-9]{3}\.[0-9]{3}-[0-9]{2}'
       OR NEW.proxima_acao ~ '[0-9]{2}\.?[0-9]{3}\.?[0-9]{3}/?[0-9]{4}-?[0-9]{2}' THEN
      RAISE EXCEPTION 'Não registre CPF/CNPJ no texto da próxima ação.'
        USING ERRCODE = '23514', HINT = 'crm_dado_pessoal';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS crm_fichas_lead ON public.fichas_clientes;
CREATE TRIGGER crm_fichas_lead
  BEFORE INSERT OR UPDATE ON public.fichas_clientes
  FOR EACH ROW EXECUTE FUNCTION public.crm_fichas_lead();

-- Recalcula a temperatura das fichas que já têm dados (idempotente; roda como dono).
UPDATE public.fichas_clientes
   SET temperatura = public.crm_temperatura_lead(faixa_divida, bloqueio_penhora, dor_principal, onde_divida)
 WHERE temperatura IS DISTINCT FROM
       public.crm_temperatura_lead(faixa_divida, bloqueio_penhora, dor_principal, onde_divida);


-- =====================================================================
-- 2. PÓS-VENDA: categorias em processos_prazos (seção 8 do documento)
--   processual      : prazo processual comum (exige CNJ, como antes);
--   execucao_fiscal : citação em execução fiscal (5 dias para pagar ou garantir; exige CNJ);
--   embargos        : garantia do juízo → 30 dias para embargos (exige CNJ);
--   parcela         : parcela mensal de acordo/transação/parcelamento (alerta 5 dias antes;
--                     3 seguidas ou 6 alternadas em atraso podem rescindir o acordo);
--   certidao        : validade de certidão (CPEN federal vale 180 dias; alerta 15 dias antes);
--   outro           : demais controles operacionais.
-- =====================================================================
ALTER TABLE public.processos_prazos
  ADD COLUMN IF NOT EXISTS categoria      text NOT NULL DEFAULT 'processual',
  ADD COLUMN IF NOT EXISTS acordo_ref     text,
  ADD COLUMN IF NOT EXISTS parcela_numero integer,
  ADD COLUMN IF NOT EXISTS parcela_total  integer;

-- Parcelas e certidões não têm número de processo: o CNJ passa a ser opcional
-- nessas categorias (o CHECK de formato continua valendo quando preenchido).
ALTER TABLE public.processos_prazos ALTER COLUMN numero_cnj DROP NOT NULL;

DO $crm5_checks_prazo$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prazos_categoria_valida') THEN
    ALTER TABLE public.processos_prazos ADD CONSTRAINT prazos_categoria_valida
      CHECK (categoria IN ('processual', 'execucao_fiscal', 'embargos', 'parcela', 'certidao', 'outro'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prazos_cnj_obrigatorio') THEN
    ALTER TABLE public.processos_prazos ADD CONSTRAINT prazos_cnj_obrigatorio
      CHECK (categoria NOT IN ('processual', 'execucao_fiscal', 'embargos') OR numero_cnj IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prazos_parcela_valida') THEN
    ALTER TABLE public.processos_prazos ADD CONSTRAINT prazos_parcela_valida
      CHECK (
        (categoria = 'parcela'
          AND btrim(coalesce(acordo_ref, '')) <> ''
          AND parcela_numero BETWEEN 1 AND 600
          AND parcela_total BETWEEN 1 AND 600
          AND parcela_numero <= parcela_total)
        OR (categoria <> 'parcela' AND parcela_numero IS NULL AND parcela_total IS NULL)
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prazos_acordo_ref_tamanho') THEN
    ALTER TABLE public.processos_prazos ADD CONSTRAINT prazos_acordo_ref_tamanho
      CHECK (acordo_ref IS NULL OR char_length(acordo_ref) <= 120);
  END IF;
END $crm5_checks_prazo$;

CREATE INDEX IF NOT EXISTS processos_prazos_acordo
  ON public.processos_prazos (advogado_id, acordo_ref, parcela_numero) WHERE categoria = 'parcela';

NOTIFY pgrst, 'reload schema';
COMMIT;

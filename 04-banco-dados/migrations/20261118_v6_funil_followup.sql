-- Dias & Fernandes | CRM v6 — Funil de 12 etapas, motivo de perda e cadência de follow-up | 2026-11-18
--
-- Base: documento "CRM de leads de anúncio" (Caio Melo, nov/2026), seções 2, 5, 7, 10 e 11.
--
-- PRÉ-REQUISITOS (nesta ordem): schema.sql (seções 1–8, NUNCA reexecute inteiro),
-- 20261118_bot_unificado.sql, 20261118_v3_crm_modulos.sql, 20261118_v4_cargo_socio.sql,
-- 20261118_v5_leads_posvenda.sql. Incremental e idempotente.
--
-- O QUE MUDA:
--   1. fichas_clientes.etapa_funil (10 etapas ativas + 'sem_resposta' e 'perdido'),
--      etapa_desde (alerta de tempo máximo), motivo_perda (OBRIGATÓRIO em 'perdido'),
--      cadencia_desde (relógio do follow-up) e nao_contatar (opt-out definitivo).
--   2. Trigger crm_fichas_lead (v5) ampliado: sincroniza status_atendimento ↔ etapa,
--      carimba datas, limpa o motivo ao reativar e aplica a regra de ouro com a etapa.
--   3. crm_followup_toques: registro dos toques de follow-up (RLS via pode_acessar_ficha).
--   4. RPC crm_followup_registrar: registra o toque e agenda a próxima ação numa única
--      transação (SECURITY INVOKER: RLS e a regra de ouro continuam valendo).
--   5. RPC crm_indicadores_funil: contagens por etapa e por motivo de perda (mesmo
--      escopo de crm_indicadores: sócio = escritório; demais = próprio).
--
-- NÃO MUDA: pode_acessar_ficha, políticas existentes, funções dfu_* do bot, crm_indicadores.
-- O bot continua gravando status_atendimento; o trigger move a etapa quando ele agenda.
BEGIN;

DO $crm6_preflight$
BEGIN
  IF to_regprocedure('public.crm_fichas_lead()') IS NULL OR to_regprocedure('public.crm_temperatura_lead(text,boolean,text,text[])') IS NULL THEN
    RAISE EXCEPTION 'Pré-requisito ausente: aplique 20261118_v5_leads_posvenda.sql antes.';
  END IF;
  IF to_regprocedure('public.crm_ficha_assumir(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Pré-requisito ausente: aplique 20261118_v4_cargo_socio.sql antes.';
  END IF;
END $crm6_preflight$;


-- =====================================================================
-- 1. ETAPAS DO FUNIL E MOTIVO DE PERDA
-- =====================================================================
ALTER TABLE public.fichas_clientes
  ADD COLUMN IF NOT EXISTS etapa_funil          text,
  ADD COLUMN IF NOT EXISTS etapa_desde          timestamptz,
  ADD COLUMN IF NOT EXISTS motivo_perda         text,
  ADD COLUMN IF NOT EXISTS motivo_perda_detalhe text,
  ADD COLUMN IF NOT EXISTS cadencia_desde       timestamptz,
  ADD COLUMN IF NOT EXISTS nao_contatar         boolean NOT NULL DEFAULT false;

-- Preenche as fichas existentes a partir do status antigo (só onde ainda está vazio).
-- etapa_desde/cadencia_desde = agora: o acompanhamento começa na migração (usar
-- created_at faria todas as fichas antigas aparecerem como "paradas" de uma vez).
UPDATE public.fichas_clientes
   SET etapa_funil = CASE lower(btrim(coalesce(status_atendimento, 'novo')))
                       WHEN 'em_analise' THEN 'em_analise'
                       WHEN 'agendado'   THEN 'horario_confirmado'
                       WHEN 'finalizado' THEN 'encerrado'
                       ELSE 'novo_lead' END,
       etapa_desde = coalesce(etapa_desde, now()),
       cadencia_desde = coalesce(cadencia_desde, now())
 WHERE etapa_funil IS NULL;

ALTER TABLE public.fichas_clientes ALTER COLUMN etapa_funil SET DEFAULT 'novo_lead';
ALTER TABLE public.fichas_clientes ALTER COLUMN etapa_funil SET NOT NULL;

DO $crm6_checks$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fichas_etapa_funil_valida') THEN
    ALTER TABLE public.fichas_clientes ADD CONSTRAINT fichas_etapa_funil_valida CHECK (etapa_funil IN (
      'novo_lead', 'primeiro_contato', 'em_conversa', 'horario_confirmado', 'diagnostico_ofertado',
      'diagnostico_pago', 'em_analise', 'proposta', 'cliente_ativo', 'encerrado',
      'sem_resposta', 'perdido'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fichas_motivo_perda_valido') THEN
    ALTER TABLE public.fichas_clientes ADD CONSTRAINT fichas_motivo_perda_valido CHECK (motivo_perda IS NULL OR motivo_perda IN (
      'preco', 'ja_tem_advogado', 'resolveu_sozinho', 'divida_pequena', 'sem_urgencia',
      'nao_respondeu', 'desconfianca'));
  END IF;
  -- Motivo de perda obrigatório (vale para todos, inclusive bot e service_role).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fichas_perdido_exige_motivo') THEN
    ALTER TABLE public.fichas_clientes ADD CONSTRAINT fichas_perdido_exige_motivo
      CHECK (etapa_funil <> 'perdido' OR motivo_perda IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fichas_motivo_detalhe_tamanho') THEN
    ALTER TABLE public.fichas_clientes ADD CONSTRAINT fichas_motivo_detalhe_tamanho
      CHECK (motivo_perda_detalhe IS NULL OR char_length(motivo_perda_detalhe) <= 280);
  END IF;
END $crm6_checks$;

CREATE INDEX IF NOT EXISTS idx_fichas_etapa_funil ON public.fichas_clientes (advogado_id, etapa_funil);


-- =====================================================================
-- 2. TRIGGER DA FICHA (substitui a versão da v5, mesmo nome)
-- Ordem: normaliza → sincroniza etapa/status → carimba datas → temperatura →
-- regra de ouro (só edição direta do CRM) → CPF/CNPJ no texto.
--   * etapa mudou: status_atendimento acompanha (novo_lead→novo; horario_confirmado→agendado;
--     encerrado/perdido→finalizado; demais→em_analise).
--   * só o status mudou (bot ou tela antiga): 'agendado' avança a etapa para
--     horario_confirmado quando ela ainda estava antes disso; 'finalizado' leva a 'encerrado'
--     se a etapa estava ativa.
--   * etapa_desde = início da etapa; cadencia_desde reinicia a cada mudança de etapa,
--     EXCETO primeiro_contato → sem_resposta (a nutrição 30/60/90 conta do 1º contato).
--   * saiu de 'perdido': o motivo é limpo (lead reativado).
-- =====================================================================
CREATE OR REPLACE FUNCTION public.crm_fichas_lead()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_ativo boolean;
  v_status text;
  v_etapa_mudou boolean;
  v_status_mudou boolean;
BEGIN
  NEW.proxima_acao := nullif(btrim(coalesce(NEW.proxima_acao, '')), '');
  NEW.motivo_perda_detalhe := nullif(btrim(coalesce(NEW.motivo_perda_detalhe, '')), '');
  NEW.onde_divida := coalesce(NEW.onde_divida, '{}');
  NEW.etapa_funil := coalesce(NEW.etapa_funil, 'novo_lead');

  IF TG_OP = 'INSERT' THEN
    v_etapa_mudou := NEW.etapa_funil <> 'novo_lead';
    v_status_mudou := NOT v_etapa_mudou;
  ELSE
    v_etapa_mudou := NEW.etapa_funil IS DISTINCT FROM OLD.etapa_funil;
    v_status_mudou := NEW.status_atendimento IS DISTINCT FROM OLD.status_atendimento;
  END IF;
  v_status := lower(btrim(coalesce(NEW.status_atendimento, 'novo')));

  IF v_etapa_mudou THEN
    NEW.status_atendimento := CASE NEW.etapa_funil
      WHEN 'novo_lead' THEN 'novo'
      WHEN 'horario_confirmado' THEN 'agendado'
      WHEN 'encerrado' THEN 'finalizado'
      WHEN 'perdido' THEN 'finalizado'
      ELSE 'em_analise' END;
  ELSIF v_status_mudou THEN
    IF v_status = 'agendado' AND NEW.etapa_funil IN ('novo_lead', 'primeiro_contato', 'em_conversa', 'sem_resposta') THEN
      NEW.etapa_funil := 'horario_confirmado';
      v_etapa_mudou := TG_OP = 'UPDATE';
    ELSIF v_status = 'finalizado' AND NEW.etapa_funil NOT IN ('encerrado', 'perdido') THEN
      NEW.etapa_funil := 'encerrado';
      v_etapa_mudou := TG_OP = 'UPDATE';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.etapa_desde := coalesce(NEW.etapa_desde, now());
    NEW.cadencia_desde := coalesce(NEW.cadencia_desde, now());
  ELSIF v_etapa_mudou THEN
    NEW.etapa_desde := now();
    IF NOT (OLD.etapa_funil = 'primeiro_contato' AND NEW.etapa_funil = 'sem_resposta') THEN
      NEW.cadencia_desde := now();
    END IF;
  END IF;
  IF NEW.etapa_funil <> 'perdido' THEN
    NEW.motivo_perda := NULL;
    NEW.motivo_perda_detalhe := NULL;
  END IF;

  NEW.temperatura := public.crm_temperatura_lead(NEW.faixa_divida, NEW.bloqueio_penhora,
                                                NEW.dor_principal, NEW.onde_divida);

  IF current_user = 'authenticated' THEN
    -- Regra de ouro: etapas de saída/fim e atendimento finalizado não exigem próxima ação.
    v_ativo := NEW.etapa_funil NOT IN ('encerrado', 'perdido')
               AND lower(btrim(coalesce(NEW.status_atendimento, 'novo'))) <> 'finalizado';
    IF v_ativo AND (NEW.proxima_acao IS NULL OR NEW.proxima_acao_em IS NULL) THEN
      RAISE EXCEPTION 'Lead ativo precisa de próxima ação e data.'
        USING ERRCODE = '23514', HINT = 'crm_proxima_acao_obrigatoria';
    END IF;
    IF NEW.proxima_acao ~ '[0-9]{3}\.[0-9]{3}\.[0-9]{3}-[0-9]{2}'
       OR NEW.proxima_acao ~ '[0-9]{2}\.?[0-9]{3}\.?[0-9]{3}/?[0-9]{4}-?[0-9]{2}'
       OR NEW.motivo_perda_detalhe ~ '[0-9]{3}\.[0-9]{3}\.[0-9]{3}-[0-9]{2}'
       OR NEW.motivo_perda_detalhe ~ '[0-9]{2}\.?[0-9]{3}\.?[0-9]{3}/?[0-9]{4}-?[0-9]{2}' THEN
      RAISE EXCEPTION 'Não registre CPF/CNPJ em texto livre da ficha.'
        USING ERRCODE = '23514', HINT = 'crm_dado_pessoal';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
-- O trigger crm_fichas_lead (v5) já aponta para esta função; recriado por segurança.
DROP TRIGGER IF EXISTS crm_fichas_lead ON public.fichas_clientes;
CREATE TRIGGER crm_fichas_lead
  BEFORE INSERT OR UPDATE ON public.fichas_clientes
  FOR EACH ROW EXECUTE FUNCTION public.crm_fichas_lead();


-- =====================================================================
-- 3. TOQUES DE FOLLOW-UP
-- Um registro por toque feito. A cadência (quais toques, em que dia) fica no CRM
-- (src/lib/funil.ts): o banco guarda o histórico e responde quem pode ver.
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.crm_followup_toques (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ficha_id   uuid NOT NULL REFERENCES public.fichas_clientes(id) ON DELETE CASCADE,
  etapa      text NOT NULL,
  passo      integer NOT NULL CHECK (passo BETWEEN 0 AND 365),
  canal      text NOT NULL CHECK (canal IN ('whatsapp', 'audio', 'ligacao', 'email', 'outro')),
  resultado  text NOT NULL DEFAULT 'feito' CHECK (resultado IN ('feito', 'pulado')),
  nota       text CHECK (nota IS NULL OR char_length(nota) <= 500),
  -- Mesmo marco de cadencia_desde no momento do toque: separa ciclos da mesma etapa.
  ciclo      timestamptz NOT NULL,
  autor_id   uuid NOT NULL REFERENCES public.advogados(id) DEFAULT public.advogado_atual_id(),
  criado_em  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_followup_toques_ficha ON public.crm_followup_toques (ficha_id, etapa, ciclo);

ALTER TABLE public.crm_followup_toques ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.crm_followup_toques FROM PUBLIC, anon;
GRANT SELECT, INSERT ON public.crm_followup_toques TO authenticated;  -- histórico: sem UPDATE/DELETE

DROP POLICY IF EXISTS "toques: leitura pela equipe responsável" ON public.crm_followup_toques;
CREATE POLICY "toques: leitura pela equipe responsável" ON public.crm_followup_toques
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.fichas_clientes f
                 WHERE f.id = crm_followup_toques.ficha_id
                   AND public.pode_acessar_ficha(f.advogado_id)));

DROP POLICY IF EXISTS "toques: registro pela equipe responsável" ON public.crm_followup_toques;
CREATE POLICY "toques: registro pela equipe responsável" ON public.crm_followup_toques
  FOR INSERT TO authenticated
  WITH CHECK (autor_id = (SELECT public.advogado_atual_id())
              AND EXISTS (SELECT 1 FROM public.fichas_clientes f
                          WHERE f.id = crm_followup_toques.ficha_id
                            AND public.pode_acessar_ficha(f.advogado_id)
                            AND f.nao_contatar IS NOT TRUE));


-- =====================================================================
-- 4. RPC: registrar toque + agendar a próxima ação (atômico)
-- SECURITY INVOKER: roda como o usuário, então o RLS das duas tabelas e a regra de
-- ouro do trigger valem normalmente. p_nova_etapa NULL = mantém a etapa.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.crm_followup_registrar(
  p_ficha uuid, p_etapa text, p_passo integer, p_canal text, p_resultado text, p_nota text,
  p_nova_etapa text, p_proxima_acao text, p_proxima_acao_em timestamptz)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE f public.fichas_clientes%ROWTYPE; v_id uuid;
BEGIN
  SELECT * INTO f FROM public.fichas_clientes WHERE id = p_ficha FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ficha não encontrada ou sem permissão.' USING ERRCODE = '42501', HINT = 'crm_sem_acesso';
  END IF;
  IF f.nao_contatar THEN
    RAISE EXCEPTION 'Lead marcado como "não contatar".' USING HINT = 'crm_optout';
  END IF;
  IF f.etapa_funil IS DISTINCT FROM p_etapa THEN
    RAISE EXCEPTION 'A etapa da ficha mudou. Atualize a tela.' USING HINT = 'crm_estado_invalido';
  END IF;

  INSERT INTO public.crm_followup_toques (ficha_id, etapa, passo, canal, resultado, nota, ciclo)
  VALUES (p_ficha, p_etapa, p_passo, p_canal, coalesce(p_resultado, 'feito'),
          nullif(btrim(coalesce(p_nota, '')), ''), f.cadencia_desde)
  RETURNING id INTO v_id;

  UPDATE public.fichas_clientes
     SET etapa_funil = coalesce(p_nova_etapa, etapa_funil),
         proxima_acao = p_proxima_acao,
         proxima_acao_em = p_proxima_acao_em
   WHERE id = p_ficha;
  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.crm_followup_registrar(uuid, text, integer, text, text, text, text, text, timestamptz) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.crm_followup_registrar(uuid, text, integer, text, text, text, text, text, timestamptz) TO authenticated;


-- =====================================================================
-- 5. INDICADORES DO FUNIL (só contagens)
-- Fichas por etapa atual (criadas no período) e perdas por motivo (perdidas no
-- período, pela data de entrada na etapa). Escopo igual ao de crm_indicadores (v4).
-- =====================================================================
CREATE OR REPLACE FUNCTION public.crm_indicadores_funil(p_inicio timestamptz, p_fim timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_eu uuid := public.advogado_atual_id(); v_escritorio boolean; v jsonb;
BEGIN
  IF v_eu IS NULL THEN
    RAISE EXCEPTION 'Sem perfil ativo.' USING ERRCODE = '42501', HINT = 'crm_sem_acesso';
  END IF;
  IF p_inicio IS NULL OR p_fim IS NULL OR p_fim <= p_inicio OR p_fim - p_inicio > interval '400 days' THEN
    RAISE EXCEPTION 'Período inválido (máximo de 400 dias).' USING HINT = 'crm_periodo_invalido';
  END IF;
  SELECT cargo = 'socio' INTO v_escritorio FROM public.advogados WHERE id = v_eu;

  WITH devs AS (
    SELECT id FROM public.advogados WHERE cargo = 'desenvolvedor'
  ), visiveis AS (
    SELECT f.etapa_funil, f.motivo_perda, f.etapa_desde, f.created_at FROM public.fichas_clientes f
     WHERE CASE WHEN v_escritorio THEN f.advogado_id IS NULL OR f.advogado_id NOT IN (SELECT id FROM devs)
                ELSE public.pode_acessar_ficha(f.advogado_id) END
  )
  SELECT jsonb_build_object(
    'escopo', CASE WHEN v_escritorio THEN 'escritorio' ELSE 'proprio' END,
    'por_etapa', (SELECT coalesce(jsonb_object_agg(s.etapa_funil, s.n), '{}'::jsonb)
                    FROM (SELECT etapa_funil, count(*) AS n FROM visiveis
                           WHERE created_at >= p_inicio AND created_at < p_fim GROUP BY 1) s),
    'perdas_por_motivo', (SELECT coalesce(jsonb_object_agg(s.motivo_perda, s.n), '{}'::jsonb)
                            FROM (SELECT motivo_perda, count(*) AS n FROM visiveis
                                   WHERE etapa_funil = 'perdido' AND etapa_desde >= p_inicio AND etapa_desde < p_fim
                                   GROUP BY 1) s)
  ) INTO v;
  RETURN v;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.crm_indicadores_funil(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.crm_indicadores_funil(timestamptz, timestamptz) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;

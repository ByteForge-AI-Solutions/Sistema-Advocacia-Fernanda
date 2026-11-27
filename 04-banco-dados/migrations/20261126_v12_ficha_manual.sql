-- Dias & Fernandes | CRM v12 — Cadastro manual de atendimento ("+ Novo atendimento") | 2026-11-26
--
-- PRÉ-REQUISITOS: migrações até 20261123_v11_prospeccao_execucoes.sql. Incremental e idempotente.
--
-- O QUE CRIA: a RPC crm_ficha_criar_manual(nome, telefone, área, resumo), usada pelo botão
-- "+ Novo atendimento" da fila (/painel). Cliente que chega por telefone, indicação ou balcão.
--
-- POR QUE UMA RPC (e não INSERT direto): INSERT em fichas_clientes continua exclusivo da
-- service_role (bot). A RPC é a ÚNICA porta de entrada do CRM e decide sozinha tudo que é
-- protegido; o navegador só manda os 4 campos do formulário:
--   * responsável = quem cadastra (advogado_atual_id() do JWT). Ninguém cria ficha em nome de
--     outro. Estagiário cria a própria (o supervisor vê, por pode_acessar_ficha); conta de
--     desenvolvedor cria só ficha de teste dela (isolada da equipe real nos dois sentidos);
--   * prioridade, status, etapa do funil, temperatura e datas: padrões do banco e o gatilho
--     crm_fichas_lead (v6), como numa ficha do bot;
--   * rodízio: ultima_atribuicao NÃO muda (cadastro manual não é distribuição do bot);
--   * próxima ação (regra de ouro, v5): "Fazer o primeiro contato", para hoje.
-- Validação no servidor (o navegador também valida, mas não é confiável):
--   nome 2–120 caracteres; telefone opcional, normalizado para 55+DDD+número; área entre as 6
--   canônicas; resumo até 3.000 caracteres; nada de CPF/CNPJ em nome ou resumo (LGPD); no máximo
--   30 cadastros manuais por pessoa por hora (anti-abuso).
--
-- SECURITY DEFINER com SET search_path = '' e objetos qualificados; EXECUTE só para
-- authenticated (aviso 0029 do Advisor: intencional, a função valida o chamador por dentro).
-- NÃO MUDA: políticas de fichas_clientes, pode_acessar_ficha, funções dfu_* e crm_* existentes.
BEGIN;

DO $crm12_preflight$
BEGIN
  IF to_regclass('public.prosp_processos') IS NULL THEN
    RAISE EXCEPTION 'Pré-requisito ausente: aplique 20261123_v11_prospeccao_execucoes.sql antes.';
  END IF;
  IF to_regprocedure('public.crm_fichas_lead()') IS NULL OR to_regprocedure('public.crm_cargo_atual()') IS NULL THEN
    RAISE EXCEPTION 'Pré-requisito ausente: aplique as migrações v6 e v8 antes.';
  END IF;
END $crm12_preflight$;

-- Marca de origem (para o limite anti-abuso e para relatórios). Só a RPC grava; a coluna não
-- entra no GRANT de UPDATE da v9, então o CRM não consegue alterá-la.
ALTER TABLE public.fichas_clientes ADD COLUMN IF NOT EXISTS origem_cadastro text;
DO $crm12_origem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fichas_origem_cadastro_valida') THEN
    ALTER TABLE public.fichas_clientes ADD CONSTRAINT fichas_origem_cadastro_valida
      CHECK (origem_cadastro IS NULL OR origem_cadastro IN ('manual_crm'));
  END IF;
END $crm12_origem$;
CREATE INDEX IF NOT EXISTS fichas_clientes_manual_idx
  ON public.fichas_clientes (advogado_id, created_at) WHERE origem_cadastro = 'manual_crm';


CREATE OR REPLACE FUNCTION public.crm_ficha_criar_manual(
  p_nome text, p_telefone text, p_area text, p_resumo text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_eu uuid := public.advogado_atual_id();
  v_cargo text := public.crm_cargo_atual();
  v_nome text := regexp_replace(btrim(coalesce(p_nome, '')), '\s+', ' ', 'g');
  v_tel text := regexp_replace(coalesce(p_telefone, ''), '[^0-9]', '', 'g');
  v_area text := lower(btrim(coalesce(p_area, '')));
  v_resumo text := btrim(coalesce(p_resumo, ''));
  v_id uuid;
BEGIN
  IF v_eu IS NULL OR v_cargo IS NULL OR v_cargo NOT IN ('advogado', 'socio', 'estagiario', 'desenvolvedor') THEN
    RAISE EXCEPTION 'Sem permissão para cadastrar atendimentos.' USING ERRCODE = '42501', HINT = 'crm_sem_acesso';
  END IF;

  IF char_length(v_nome) < 2 OR char_length(v_nome) > 120 OR v_nome ~ '[[:cntrl:]]' OR v_nome !~ '[[:alpha:]]' THEN
    RAISE EXCEPTION 'Nome do cliente inválido (2 a 120 caracteres).' USING ERRCODE = '22023', HINT = 'crm_ficha_nome';
  END IF;

  -- Telefone opcional. Com DDD (10/11 dígitos) ganha o 55; aceita fixo e celular brasileiros.
  IF v_tel <> '' THEN
    IF char_length(v_tel) IN (10, 11) THEN v_tel := '55' || v_tel; END IF;
    IF v_tel !~ '^55[1-9][0-9]([2-8][0-9]{7}|9[0-9]{8})$' THEN
      RAISE EXCEPTION 'Telefone inválido. Use DDD + número.' USING ERRCODE = '22023', HINT = 'crm_ficha_telefone';
    END IF;
  END IF;

  IF v_area NOT IN ('trabalhista', 'empresarial', 'civil', 'cartorario_reurb', 'previdenciario', 'tributario') THEN
    RAISE EXCEPTION 'Área jurídica inválida.' USING ERRCODE = '22023', HINT = 'crm_ficha_area';
  END IF;

  IF char_length(v_resumo) > 3000 OR v_resumo ~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]' THEN
    RAISE EXCEPTION 'Resumo inválido (até 3.000 caracteres).' USING ERRCODE = '22023', HINT = 'crm_ficha_resumo';
  END IF;

  -- LGPD: CPF/CNPJ não vão para nome nem resumo (aparecem na fila). Mesmos padrões do gatilho v6.
  IF v_nome ~ '[0-9]{3}\.?[0-9]{3}\.?[0-9]{3}-?[0-9]{2}'
     OR v_resumo ~ '[0-9]{3}\.[0-9]{3}\.[0-9]{3}-[0-9]{2}'
     OR v_resumo ~ '[0-9]{2}\.?[0-9]{3}\.?[0-9]{3}/?[0-9]{4}-?[0-9]{2}' THEN
    RAISE EXCEPTION 'Não registre CPF/CNPJ no nome ou no resumo. Use o cadastro do cliente.'
      USING ERRCODE = '23514', HINT = 'crm_dado_pessoal';
  END IF;

  IF (SELECT count(*) FROM public.fichas_clientes f
       WHERE f.advogado_id = v_eu AND f.origem_cadastro = 'manual_crm'
         AND f.created_at > now() - interval '1 hour') >= 30 THEN
    RAISE EXCEPTION 'Limite de 30 cadastros manuais por hora atingido.' USING ERRCODE = '54000', HINT = 'crm_ficha_limite';
  END IF;

  INSERT INTO public.fichas_clientes
    (nome_cliente, telefone, area_identificada, resumo_fatos, advogado_id,
     proxima_acao, proxima_acao_em, origem_cadastro)
  VALUES
    (v_nome, v_tel, v_area,
     coalesce(nullif(v_resumo, ''), 'Atendimento cadastrado manualmente no CRM (sem resumo inicial).'),
     v_eu, 'Fazer o primeiro contato', now(), 'manual_crm')
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- Defesa em profundidade: o Supabase concede INSERT/DELETE a authenticated por padrão; hoje só o
-- RLS (sem política de INSERT/DELETE) barrava. INSERT e DELETE de fichas são da service_role
-- (bot) e desta RPC; o CRM não usa nenhum dos dois direto. UPDATE segue o GRANT por coluna da v9.
REVOKE INSERT, DELETE, TRUNCATE ON public.fichas_clientes FROM anon, authenticated;

REVOKE ALL ON FUNCTION public.crm_ficha_criar_manual(text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crm_ficha_criar_manual(text, text, text, text) TO authenticated;
COMMENT ON FUNCTION public.crm_ficha_criar_manual(text, text, text, text) IS
  'Cadastro manual de atendimento pelo CRM. Responsável = quem chama (JWT); valida e normaliza os campos; não toca no rodízio. Aviso 0029 do Advisor: intencional (valida o chamador por dentro).';

NOTIFY pgrst, 'reload schema';
COMMIT;

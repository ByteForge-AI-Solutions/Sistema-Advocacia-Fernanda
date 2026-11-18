-- Dias & Fernandes | CRM v4 — cargo 'socio' (sócios com supervisão total) | 2026-11-18
--
-- PRÉ-REQUISITOS (nesta ordem):
--   1. CRM instalado (schema.sql seções 1–8) — NUNCA reexecute schema.sql inteiro.
--   2. 20261118_bot_unificado.sql (bot v2.1).
--   3. 20261118_v3_crm_modulos.sql.
-- Incremental e idempotente (pode rodar mais de uma vez).
--
-- REGRAS:
--   * socio: atua como titular (rodízio do bot, agenda, atendimentos, prazos) e
--     vê/edita os registros de TODO o escritório. Registros de contas
--     'desenvolvedor' continuam fora do alcance (LGPD / dados de teste).
--   * advogado: só o que é dele, o dos estagiários que supervisiona e o que
--     está sem responsável na área dele (para assumir).
--   * estagiario / desenvolvedor: inalterados (só o próprio id).
--
-- ATENÇÃO (ordem de implantação): aplique esta migração, publique o CRM novo e
-- SÓ ENTÃO promova os sócios (UPDATE no fim do arquivo). O CRM antigo não
-- reconhece o cargo 'socio' e desloga quem tiver esse cargo.
--
-- Se 20261118_bot_unificado.sql for reaplicado no futuro, reaplique ESTA
-- migração depois: ela redefine dfu_ofertar, dfu_criar_ficha e dfu_confirmar
-- para incluir sócios no rodízio.
BEGIN;

DO $crm4_preflight$
BEGIN
  IF to_regprocedure('public.pode_acessar_ficha(uuid)') IS NULL
     OR to_regprocedure('public.advogado_atual_id()') IS NULL THEN
    RAISE EXCEPTION 'Pré-requisito ausente: funções das seções 5 e 7 do schema.sql.';
  END IF;
  IF to_regprocedure('public.dfu_ofertar(text)') IS NULL
     OR to_regprocedure('public.dfu_criar_ficha(text)') IS NULL
     OR to_regprocedure('public.dfu_confirmar(text,integer)') IS NULL THEN
    RAISE EXCEPTION 'Pré-requisito ausente: aplique 20261118_bot_unificado.sql antes.';
  END IF;
  IF to_regprocedure('public.crm_indicadores(timestamptz,timestamptz)') IS NULL
     OR to_regprocedure('public.crm_titular_da_area(text)') IS NULL
     OR to_regclass('public.processos_prazos') IS NULL THEN
    RAISE EXCEPTION 'Pré-requisito ausente: aplique 20261118_v3_crm_modulos.sql antes.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgrelid = 'public.agenda_advogados'::regclass
                   AND tgname = 'dfu_prevenir_sobreposicao_agenda' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'Trigger dfu_prevenir_sobreposicao_agenda ausente: aplique 20261118_bot_unificado.sql antes.';
  END IF;
END $crm4_preflight$;


-- =====================================================================
-- 1. CARGO VÁLIDO: advogado, socio, estagiario, desenvolvedor
-- Troca qualquer CHECK existente sobre "cargo" por um com os 4 valores.
-- Criado NOT VALID (vale para gravações novas) e validado em seguida se não
-- houver linha fora da lista; se houver, só avisa (corrija e rode
-- ALTER TABLE public.advogados VALIDATE CONSTRAINT advogados_cargo_valido;).
-- =====================================================================
DO $crm4_cargo$
DECLARE r record; v_invalidos int;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.advogados'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) ILIKE '%cargo%' LOOP
    EXECUTE format('ALTER TABLE public.advogados DROP CONSTRAINT %I', r.conname);
  END LOOP;

  ALTER TABLE public.advogados
    ADD CONSTRAINT advogados_cargo_valido
    CHECK (cargo IN ('advogado', 'socio', 'estagiario', 'desenvolvedor')) NOT VALID;

  SELECT count(*) INTO v_invalidos FROM public.advogados
   WHERE cargo IS NULL OR cargo NOT IN ('advogado', 'socio', 'estagiario', 'desenvolvedor');
  IF v_invalidos = 0 THEN
    ALTER TABLE public.advogados VALIDATE CONSTRAINT advogados_cargo_valido;
  ELSE
    RAISE NOTICE '% linha(s) de advogados com cargo fora da lista; CHECK criado sem validar as antigas. Confira: SELECT cargo, count(*) FROM public.advogados GROUP BY 1;', v_invalidos;
  END IF;
END $crm4_cargo$;


-- =====================================================================
-- 2. AUTORIZAÇÃO CENTRAL: pode_acessar_ficha(responsavel_id)
-- Mesma assinatura (todas as políticas existentes continuam usando-a).
-- Responsável NULL continua dando falso para todos: registros sem
-- responsável são tratados à parte (crm_titular_da_area, seção 3).
-- =====================================================================
CREATE OR REPLACE FUNCTION public.pode_acessar_ficha(responsavel_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.advogados eu
    WHERE lower(eu.email) = lower(auth.jwt() ->> 'email')
      AND eu.ativo IS TRUE
      AND (
        -- registro atribuído ao próprio usuário
        (eu.id = responsavel_id AND eu.cargo IN ('advogado', 'socio', 'estagiario', 'desenvolvedor'))
        OR
        -- titular (advogado ou sócio) enxergando um estagiário que supervisiona
        (
          eu.cargo IN ('advogado', 'socio')
          AND EXISTS (
            SELECT 1 FROM public.advogados est
            WHERE est.id = responsavel_id
              AND est.cargo = 'estagiario'
              AND est.supervisor_id = eu.id
          )
        )
        OR
        -- sócio: todo o escritório. Lista explícita de cargos: contas
        -- 'desenvolvedor' (e qualquer cargo desconhecido) ficam de fora.
        (
          eu.cargo = 'socio'
          AND EXISTS (
            SELECT 1 FROM public.advogados outro
            WHERE outro.id = responsavel_id
              AND outro.cargo IN ('advogado', 'socio', 'estagiario')
          )
        )
      )
  );
$$;

REVOKE EXECUTE ON FUNCTION public.pode_acessar_ficha(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.pode_acessar_ficha(uuid) TO authenticated;


-- =====================================================================
-- 3. REGISTROS SEM RESPONSÁVEL
-- advogado: os da(s) área(s) dele; socio: todos. Estagiário/desenvolvedor: nenhum.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.crm_titular_da_area(p_area text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.advogados eu
    WHERE lower(eu.email) = lower(auth.jwt() ->> 'email')
      AND eu.ativo IS TRUE
      AND eu.cargo IN ('advogado', 'socio')
      AND (eu.cargo = 'socio' OR p_area IS NULL OR p_area = ANY(eu.areas_atuacao))
  );
$$;

REVOKE EXECUTE ON FUNCTION public.crm_titular_da_area(text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.crm_titular_da_area(text) TO authenticated;

-- 3.1 Fichas sem responsável: leitura (soma-se à política original). A
-- atribuição é feita só pela RPC crm_ficha_assumir (não há UPDATE direto).
DROP POLICY IF EXISTS "crm fichas sem responsavel" ON public.fichas_clientes;
CREATE POLICY "crm fichas sem responsavel" ON public.fichas_clientes
  FOR SELECT TO authenticated
  USING (advogado_id IS NULL AND public.crm_titular_da_area(area_identificada));

-- 3.2 Assumir ficha sem responsável: atribui ao titular que assumiu, mantém o
-- rodízio (ultima_atribuicao) e leva junto o atendimento do bot vinculado.
CREATE OR REPLACE FUNCTION public.crm_ficha_assumir(p_ficha uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_eu uuid := public.advogado_atual_id(); v_cargo text; f public.fichas_clientes%ROWTYPE;
BEGIN
  SELECT cargo INTO v_cargo FROM public.advogados WHERE id = v_eu;
  IF v_eu IS NULL OR v_cargo IS NULL OR v_cargo NOT IN ('advogado', 'socio') THEN
    RAISE EXCEPTION 'Só advogados titulares e sócios assumem fichas sem responsável.'
      USING ERRCODE = '42501', HINT = 'crm_sem_acesso';
  END IF;
  SELECT * INTO f FROM public.fichas_clientes WHERE id = p_ficha FOR UPDATE;
  IF NOT FOUND OR NOT public.crm_titular_da_area(f.area_identificada) THEN
    RAISE EXCEPTION 'Ficha não encontrada ou fora da sua área.' USING ERRCODE = '42501', HINT = 'crm_sem_acesso';
  END IF;
  IF f.advogado_id IS NOT NULL THEN
    RAISE EXCEPTION 'Esta ficha já tem responsável.' USING HINT = 'crm_estado_invalido';
  END IF;
  UPDATE public.fichas_clientes SET advogado_id = v_eu WHERE id = p_ficha;
  UPDATE public.advogados SET ultima_atribuicao = now() WHERE id = v_eu;
  UPDATE public.dfu_atendimentos SET advogado_id = v_eu, atualizado_em = now()
   WHERE ficha_id = p_ficha AND advogado_id IS NULL;
  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.crm_ficha_assumir(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.crm_ficha_assumir(uuid) TO authenticated;


-- =====================================================================
-- 4. TRANSFERÊNCIA DE ATENDIMENTO
-- Destino: titular ativo (advogado ou sócio) ou estagiário que quem transfere
-- supervisiona. Sócio pode transferir para qualquer estagiário ativo.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.crm_atendimento_transferir(p_telefone text, p_destino uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.dfu_atendimentos%ROWTYPE; v_eu uuid := public.advogado_atual_id();
        eu public.advogados%ROWTYPE; d public.advogados%ROWTYPE;
BEGIN
  SELECT * INTO eu FROM public.advogados WHERE id = v_eu;
  SELECT * INTO a FROM public.dfu_atendimentos WHERE telefone = p_telefone FOR UPDATE;
  IF NOT FOUND OR v_eu IS NULL OR NOT public.crm_pode_acessar_atendimento(p_telefone) THEN
    RAISE EXCEPTION 'Atendimento não encontrado ou sem permissão.' USING ERRCODE = '42501', HINT = 'crm_sem_acesso';
  END IF;
  IF eu.cargo = 'desenvolvedor' THEN
    RAISE EXCEPTION 'Conta de desenvolvedor não transfere atendimentos.' USING ERRCODE = '42501', HINT = 'crm_sem_acesso';
  END IF;
  SELECT * INTO d FROM public.advogados WHERE id = p_destino AND ativo IS TRUE;
  IF NOT FOUND OR NOT (d.cargo IN ('advogado', 'socio')
                       OR (d.cargo = 'estagiario' AND (d.supervisor_id = v_eu OR eu.cargo = 'socio'))) THEN
    RAISE EXCEPTION 'Destino inválido: escolha um titular ativo ou um estagiário que você supervisiona.' USING HINT = 'crm_destino_invalido';
  END IF;
  IF d.id IS NOT DISTINCT FROM a.advogado_id THEN
    RAISE EXCEPTION 'O atendimento já está com esta pessoa.' USING HINT = 'crm_destino_invalido';
  END IF;
  UPDATE public.dfu_atendimentos SET advogado_id = d.id, atualizado_em = now() WHERE telefone = p_telefone;
  IF a.ficha_id IS NOT NULL THEN
    UPDATE public.fichas_clientes SET advogado_id = d.id WHERE id = a.ficha_id;
  END IF;
  INSERT INTO public.dfu_notas_internas (telefone, autor_id, texto, sistema)
  VALUES (p_telefone, v_eu, 'Transferiu o atendimento para ' || d.nome || '.', true);
  RETURN true;
END;
$$;


-- =====================================================================
-- 5. PRAZOS: exclusão também pelo sócio (estagiário continua sem excluir)
-- =====================================================================
DROP POLICY IF EXISTS "prazos: exclusão por titular" ON public.processos_prazos;
CREATE POLICY "prazos: exclusão por titular" ON public.processos_prazos
  FOR DELETE TO authenticated
  USING (public.pode_acessar_ficha(advogado_id)
         AND EXISTS (SELECT 1 FROM public.advogados eu
                     WHERE eu.id = (SELECT public.advogado_atual_id())
                       AND eu.cargo IN ('advogado', 'socio', 'desenvolvedor')));


-- =====================================================================
-- 6. INDICADORES: visão do escritório só para o sócio.
-- advogado / estagiário / desenvolvedor: escopo próprio (pode_acessar_ficha).
-- =====================================================================

CREATE OR REPLACE FUNCTION public.crm_indicadores(p_inicio timestamptz, p_fim timestamptz)
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
  ), ate AS (
    SELECT a.telefone, a.status, a.advogado_id, a.ficha_id FROM public.dfu_atendimentos a
     WHERE a.criado_em >= p_inicio AND a.criado_em < p_fim
       AND CASE WHEN v_escritorio THEN a.advogado_id IS NULL OR a.advogado_id NOT IN (SELECT id FROM devs)
                ELSE public.pode_acessar_ficha(a.advogado_id) END
  ), fic AS (
    SELECT f.id, f.area_identificada, f.advogado_id FROM public.fichas_clientes f
     WHERE f.created_at >= p_inicio AND f.created_at < p_fim
       AND CASE WHEN v_escritorio THEN f.advogado_id IS NULL OR f.advogado_id NOT IN (SELECT id FROM devs)
                ELSE public.pode_acessar_ficha(f.advogado_id) END
  ), agd AS (
    SELECT g.id, g.status, g.advogado_id FROM public.agenda_advogados g
     WHERE g.criado_em >= p_inicio AND g.criado_em < p_fim AND g.status <> 'cancelado'
       AND CASE WHEN v_escritorio THEN g.advogado_id NOT IN (SELECT id FROM devs)
                ELSE public.pode_acessar_ficha(g.advogado_id) END
  ), prz AS (
    SELECT p.data_fatal, p.status FROM public.processos_prazos p
     WHERE p.status <> 'cumprido'
       AND CASE WHEN v_escritorio THEN p.advogado_id NOT IN (SELECT id FROM devs)
                ELSE public.pode_acessar_ficha(p.advogado_id) END
  )
  SELECT jsonb_build_object(
    'escopo', CASE WHEN v_escritorio THEN 'escritorio' ELSE 'proprio' END,
    'leads', (SELECT count(*) FROM ate),
    'leads_sem_responsavel', (SELECT count(*) FROM ate WHERE advogado_id IS NULL),
    'leads_com_reuniao', (SELECT count(*) FROM ate
                          WHERE ate.ficha_id IS NOT NULL AND EXISTS (
                            SELECT 1 FROM public.agenda_advogados g
                             WHERE g.ficha_id = ate.ficha_id AND g.status <> 'cancelado')),
    'leads_por_status', (SELECT coalesce(jsonb_object_agg(s.status, s.n), '{}'::jsonb)
                           FROM (SELECT status, count(*) AS n FROM ate GROUP BY status) s),
    'fichas', (SELECT count(*) FROM fic),
    'reunioes', (SELECT count(*) FROM agd),
    'reunioes_realizadas', (SELECT count(*) FROM agd WHERE status = 'realizado'),
    'por_area', (SELECT coalesce(jsonb_agg(jsonb_build_object('area', s.area, 'fichas', s.n) ORDER BY s.n DESC), '[]'::jsonb)
                   FROM (SELECT area_identificada AS area, count(*) AS n FROM fic GROUP BY 1) s),
    'por_advogado', (SELECT coalesce(jsonb_agg(x.obj ORDER BY (x.obj->>'fichas')::int DESC, x.obj->>'nome'), '[]'::jsonb)
                       FROM (SELECT jsonb_build_object(
                                'advogado_id', adv.id, 'nome', adv.nome, 'cargo', adv.cargo,
                                'atendimentos', (SELECT count(*) FROM ate WHERE ate.advogado_id = adv.id),
                                'fichas', (SELECT count(*) FROM fic WHERE fic.advogado_id = adv.id),
                                'reunioes', (SELECT count(*) FROM agd WHERE agd.advogado_id = adv.id)) AS obj
                               FROM public.advogados adv
                              WHERE EXISTS (SELECT 1 FROM ate WHERE ate.advogado_id = adv.id)
                                 OR EXISTS (SELECT 1 FROM fic WHERE fic.advogado_id = adv.id)
                                 OR EXISTS (SELECT 1 FROM agd WHERE agd.advogado_id = adv.id)) x),
    'prazos_vencidos', (SELECT count(*) FROM prz WHERE data_fatal < (now() AT TIME ZONE 'America/Sao_Paulo')::date),
    'prazos_proximos_7d', (SELECT count(*) FROM prz
                            WHERE data_fatal >= (now() AT TIME ZONE 'America/Sao_Paulo')::date
                              AND data_fatal <= (now() AT TIME ZONE 'America/Sao_Paulo')::date + 7)
  ) INTO v;
  RETURN v;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.crm_indicadores(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.crm_indicadores(timestamptz, timestamptz) TO authenticated;


-- =====================================================================
-- 7. RODÍZIO DO BOT: sócios atuam como titulares e continuam recebendo leads.
-- Cópia LITERAL das funções de 20261118_bot_unificado.sql (v2.1); a ÚNICA
-- mudança é o filtro de cargo, que passa a aceitar 'advogado' OU 'socio'.
-- Estagiários e desenvolvedores continuam FORA do rodízio. Permissões
-- (GRANT/REVOKE) das funções são preservadas pelo CREATE OR REPLACE.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.dfu_ofertar(p_telefone text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.dfu_atendimentos%ROWTYPE; v_advogado uuid; v_slots jsonb; v_texto text;
BEGIN
 SELECT * INTO a FROM public.dfu_atendimentos WHERE telefone=p_telefone FOR UPDATE;
 IF NOT FOUND OR a.bloqueado OR a.area IS NULL THEN
   RETURN jsonb_build_object('ok',false,'motivo','sem_area');
 END IF;
 WITH candidatos AS (
   SELECT DISTINCT ON (adv.id,disp.dia_semana) adv.id, adv.ultima_atribuicao, disp.dia_semana,disp.hora_inicio,
     disp.hora_fim,disp.duracao_reuniao_min,disp.max_reunioes_dia
   FROM public.advogados adv JOIN public.disponibilidade_advogados disp ON disp.advogado_id=adv.id
   WHERE adv.ativo IS TRUE AND adv.cargo IN ('advogado','socio')
     AND a.area=ANY(adv.areas_atuacao) AND disp.ativo IS TRUE
     AND disp.duracao_reuniao_min BETWEEN 10 AND 480
   ORDER BY adv.id,disp.dia_semana,disp.id
 ), dias AS (
   SELECT x::date AS dia FROM generate_series(
     (now() AT TIME ZONE 'America/Sao_Paulo')::date,
     (now() AT TIME ZONE 'America/Sao_Paulo')::date+6,interval '1 day') x
 ), possibilidades AS (
   SELECT c.id AS advogado_id,c.ultima_atribuicao,d.dia,
     (d.dia+c.hora_inicio+make_interval(mins=>step.minutos)) AT TIME ZONE 'America/Sao_Paulo' AS inicio,
     (d.dia+c.hora_inicio+make_interval(mins=>step.minutos+c.duracao_reuniao_min)) AT TIME ZONE 'America/Sao_Paulo' AS fim,
     c.max_reunioes_dia
   FROM candidatos c JOIN dias d ON extract(dow from d.dia)::int=c.dia_semana
   CROSS JOIN LATERAL generate_series(0,
     floor(extract(epoch from (c.hora_fim-c.hora_inicio))/60)::int-c.duracao_reuniao_min,
     c.duracao_reuniao_min) step(minutos)
   WHERE NOT EXISTS(SELECT 1 FROM public.dfu_feriados f WHERE f.dia=d.dia)
 ), livres AS (
  SELECT p.* FROM possibilidades p WHERE p.inicio>=now()+interval '2 hours'
  AND (SELECT count(*) FROM public.agenda_advogados g
       WHERE g.advogado_id=p.advogado_id AND g.status IN ('agendado','confirmado')
         AND (g.data_hora_inicio AT TIME ZONE 'America/Sao_Paulo')::date=p.dia) < p.max_reunioes_dia
  AND NOT EXISTS(SELECT 1 FROM public.agenda_advogados g WHERE g.advogado_id=p.advogado_id
       AND g.status IN ('agendado','confirmado') AND g.data_hora_inicio<p.fim
       AND coalesce(g.data_hora_fim,g.data_hora_inicio+interval '60 minutes')>p.inicio)
 ), vencedor AS (
   SELECT advogado_id FROM livres GROUP BY advogado_id
   ORDER BY count(*) DESC,
     min(ultima_atribuicao) NULLS FIRST, advogado_id LIMIT 1
 ), por_dia AS (
   SELECT l.*,row_number() OVER(PARTITION BY l.dia ORDER BY l.inicio) dia_ord
   FROM livres l JOIN vencedor v ON v.advogado_id=l.advogado_id
 ), opcoes AS (
   SELECT *,row_number() OVER(ORDER BY inicio) AS opcao FROM por_dia WHERE dia_ord=1
   ORDER BY inicio LIMIT 3
 )
 SELECT (array_agg(advogado_id ORDER BY opcao))[1],coalesce(jsonb_agg(jsonb_build_object(
   'opcao',opcao,'advogado_id',advogado_id,'inicio',inicio,'fim',fim,
   'exibicao',to_char(inicio AT TIME ZONE 'America/Sao_Paulo','DD/MM/YYYY "às" HH24:MI')
 ) ORDER BY opcao),'[]'::jsonb)
 INTO v_advogado,v_slots FROM opcoes;
 IF v_advogado IS NULL OR jsonb_array_length(v_slots)=0 THEN
   RETURN jsonb_build_object('ok',false,'motivo','sem_horarios');
 END IF;
 -- Ofertas antigas ainda não expedidas não devem chegar fora de ordem.
 UPDATE public.dfu_outbox SET status='BLOQUEADO',concluido_em=now()
 WHERE telefone=p_telefone AND tipo='horarios' AND status='PENDENTE';
 UPDATE public.dfu_atendimentos SET advogado_id=v_advogado,
  slots_oferecidos=v_slots,slots_expiram_em=now()+interval '30 minutes',
  status='aguardando_horario',atualizado_em=now() WHERE telefone=p_telefone;
 UPDATE public.advogados SET ultima_atribuicao=now() WHERE id=v_advogado;
 RETURN jsonb_build_object('ok',true,'slots',v_slots,'advogado_id',v_advogado);
END;
$$;

CREATE OR REPLACE FUNCTION public.dfu_criar_ficha(p_telefone text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.dfu_atendimentos%ROWTYPE; v_id uuid; v_area text; v_adv uuid;
BEGIN
 SELECT * INTO a FROM public.dfu_atendimentos WHERE telefone=p_telefone FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF a.area IS NULL THEN RETURN NULL; END IF;
 v_area:=a.area;
 v_adv:=a.advogado_id;
 IF v_adv IS NULL THEN
  SELECT id INTO v_adv FROM public.advogados
  WHERE ativo IS TRUE AND cargo IN ('advogado','socio') AND v_area=ANY(areas_atuacao)
  ORDER BY ultima_atribuicao NULLS FIRST,id LIMIT 1;
 END IF;
 IF v_adv IS NULL THEN RETURN NULL; END IF;
 IF a.ficha_id IS NULL THEN
  INSERT INTO public.fichas_clientes(nome_cliente,telefone,area_identificada,prioridade,
      motivo_prioridade,resumo_fatos,advogado_id,status_atendimento)
  VALUES(coalesce(nullif(btrim(a.nome_cliente),''),'Contato WhatsApp'),p_telefone,v_area,
      a.prioridade,a.motivo_prioridade,coalesce(nullif(a.resumo_fatos,''),'Triagem inicial: dados ainda pendentes.'),
      v_adv,CASE WHEN a.status='agendado' THEN 'agendado' ELSE 'novo' END)
  RETURNING id INTO v_id;
 ELSE
  v_id:=a.ficha_id;
  UPDATE public.fichas_clientes SET
   nome_cliente=coalesce(nullif(btrim(a.nome_cliente),''),'Contato WhatsApp'),
   area_identificada=v_area,prioridade=a.prioridade,
   motivo_prioridade=a.motivo_prioridade,
   resumo_fatos=coalesce(nullif(a.resumo_fatos,''),'Triagem inicial: dados ainda pendentes.'),
   advogado_id=v_adv,
   status_atendimento=CASE WHEN a.status='agendado' THEN 'agendado' ELSE status_atendimento END
   WHERE id=v_id;
 END IF;
 UPDATE public.dfu_atendimentos SET ficha_id=v_id,advogado_id=v_adv WHERE telefone=p_telefone;
 RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.dfu_confirmar(p_telefone text,p_opcao int)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.dfu_atendimentos%ROWTYPE; s jsonb; v_inicio timestamptz;
 v_fim timestamptz; v_adv uuid; v_id uuid; v_grade public.disponibilidade_advogados%ROWTYPE;
 v_count int;
BEGIN
 SELECT * INTO a FROM public.dfu_atendimentos WHERE telefone=p_telefone FOR UPDATE;
 IF NOT FOUND OR a.bloqueado OR a.status<>'aguardando_horario' OR
     a.slots_expiram_em<=now() OR p_opcao NOT BETWEEN 1 AND 3 THEN
   RETURN jsonb_build_object('ok',false,'motivo','oferta_expirada');
 END IF;
 SELECT value INTO s FROM jsonb_array_elements(a.slots_oferecidos) value
 WHERE (value->>'opcao')::int=p_opcao LIMIT 1;
 IF s IS NULL THEN RETURN jsonb_build_object('ok',false,'motivo','opcao_invalida'); END IF;
 v_inicio:=(s->>'inicio')::timestamptz;v_fim:=(s->>'fim')::timestamptz;
 v_adv:=(s->>'advogado_id')::uuid;
 PERFORM pg_advisory_xact_lock(hashtext(v_adv::text));
 SELECT * INTO v_grade FROM public.disponibilidade_advogados WHERE advogado_id=v_adv
   AND dia_semana=extract(dow from (v_inicio AT TIME ZONE 'America/Sao_Paulo'))::int
   AND ativo IS TRUE ORDER BY id LIMIT 1;
 IF NOT FOUND OR v_inicio<now()+interval '2 hours' OR
   NOT EXISTS(SELECT 1 FROM public.advogados WHERE id=v_adv AND ativo IS TRUE
     AND cargo IN ('advogado','socio') AND a.area=ANY(areas_atuacao)) OR
   EXISTS (SELECT 1 FROM public.dfu_feriados
       WHERE dia=(v_inicio AT TIME ZONE 'America/Sao_Paulo')::date) THEN
    RETURN jsonb_build_object('ok',false,'motivo','indisponivel');
 END IF;
 IF (v_inicio AT TIME ZONE 'America/Sao_Paulo')::time<v_grade.hora_inicio OR
    (v_fim AT TIME ZONE 'America/Sao_Paulo')::time>v_grade.hora_fim OR
    extract(epoch FROM (v_fim-v_inicio))/60<>v_grade.duracao_reuniao_min THEN
    RETURN jsonb_build_object('ok',false,'motivo','fora_da_grade');
 END IF;
 SELECT count(*) INTO v_count FROM public.agenda_advogados
 WHERE advogado_id=v_adv AND status IN ('agendado','confirmado')
  AND (data_hora_inicio AT TIME ZONE 'America/Sao_Paulo')::date=
        (v_inicio AT TIME ZONE 'America/Sao_Paulo')::date;
 IF v_count>=v_grade.max_reunioes_dia OR EXISTS(
    SELECT 1 FROM public.agenda_advogados WHERE advogado_id=v_adv
    AND status IN ('agendado','confirmado') AND data_hora_inicio<v_fim
    AND coalesce(data_hora_fim,data_hora_inicio+interval '60 minutes')>v_inicio
 ) THEN RETURN jsonb_build_object('ok',false,'motivo','ocupado'); END IF;
 -- Cria/atualiza a ficha para o CRM na mesma transação do compromisso.
 v_id:=public.dfu_criar_ficha(p_telefone);
 IF v_id IS NULL THEN RETURN jsonb_build_object('ok',false,'motivo','sem_advogado'); END IF;
 INSERT INTO public.agenda_advogados(advogado_id,ficha_id,titulo_evento,
    area_juridica,prioridade,data_hora_inicio,data_hora_fim,status)
 VALUES(v_adv,v_id,'Triagem — '||coalesce(nullif(a.nome_cliente,''),'Cliente WhatsApp'),
    a.area,a.prioridade,v_inicio,v_fim,'confirmado');
 UPDATE public.dfu_atendimentos SET status='agendado',advogado_id=v_adv,
   slots_oferecidos='[]'::jsonb,slots_expiram_em=NULL,atualizado_em=now()
 WHERE telefone=p_telefone;
 UPDATE public.fichas_clientes SET status_atendimento='agendado' WHERE id=v_id;
 UPDATE public.dfu_outbox SET status='BLOQUEADO',concluido_em=now()
 WHERE telefone=p_telefone AND status='PENDENTE' AND tipo IN ('horarios','followup');
 RETURN jsonb_build_object('ok',true,'ficha_id',v_id,
    'data_hora',s->>'exibicao','advogado_id',v_adv);
EXCEPTION WHEN unique_violation THEN
 RETURN jsonb_build_object('ok',false,'motivo','ocupado');
END;
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;

-- =====================================================================
-- DEPOIS de publicar o CRM com suporte a 'socio', promova os sócios
-- (rode separadamente; confira o resultado do RETURNING):
--
-- UPDATE public.advogados
--    SET cargo = 'socio'
--  WHERE nome IN ('Fernanda Lemos Fernandes Rigo', 'Kayo Ronnaro Silva Dias')
--    AND cargo = 'advogado' AND supervisor_id IS NULL AND ativo IS TRUE
-- RETURNING id, nome, cargo;
--
-- Para desfazer: o mesmo UPDATE com SET cargo = 'advogado' WHERE cargo = 'socio'.
-- =====================================================================

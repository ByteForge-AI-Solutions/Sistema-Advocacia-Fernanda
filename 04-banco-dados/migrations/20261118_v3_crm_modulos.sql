-- Dias & Fernandes | CRM v3 — Inbox omnichannel, agenda/Google, prazos e indicadores | 2026-11-18
--
-- PRÉ-REQUISITOS (nesta ordem):
--   1. CRM já instalado (schema.sql seções 1–8) — NUNCA reexecute schema.sql inteiro.
--   2. 20261118_bot_unificado.sql (v2.1) aplicado.
-- Esta migração é INCREMENTAL e idempotente (pode rodar mais de uma vez).
--
-- O QUE ELA NÃO TOCA (preservado byte a byte):
--   * funções pode_acessar_ficha(), advogado_atual_id(), agenda_valida_ficha();
--   * políticas RLS existentes de advogados, fichas_clientes, agenda_advogados,
--     disponibilidade_advogados, dfu_atendimentos e dfu_mensagens;
--   * trigger dfu_prevenir_sobreposicao_agenda (apenas verifica que existe);
--   * funções dfu_* do bot (nenhuma é redefinida).
--
-- Escrita do CRM nas tabelas dfu_* acontece SOMENTE por RPCs SECURITY DEFINER
-- que revalidam o acesso; authenticated continua sem INSERT/UPDATE direto nelas.
BEGIN;

DO $crm3_preflight$
DECLARE v text;
BEGIN
  FOREACH v IN ARRAY ARRAY['advogados','fichas_clientes','agenda_advogados','disponibilidade_advogados',
                           'dfu_atendimentos','dfu_mensagens','dfu_outbox','dfu_feriados'] LOOP
    IF to_regclass('public.'||v) IS NULL THEN
      RAISE EXCEPTION 'Pré-requisito ausente: tabela public.%. Aplique o CRM e a migração do bot (v2.1) antes.', v;
    END IF;
  END LOOP;
  IF to_regprocedure('public.pode_acessar_ficha(uuid)') IS NULL
     OR to_regprocedure('public.advogado_atual_id()') IS NULL
     OR to_regprocedure('public.agenda_valida_ficha()') IS NULL THEN
    RAISE EXCEPTION 'Pré-requisito ausente: funções das seções 5 e 7 do schema.sql.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgrelid = 'public.agenda_advogados'::regclass
                   AND tgname = 'dfu_prevenir_sobreposicao_agenda' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'Trigger dfu_prevenir_sobreposicao_agenda ausente: aplique 20261118_bot_unificado.sql antes.';
  END IF;
  -- Colunas de data usadas por crm_indicadores. O banco real diverge do schema.sql:
  -- agenda_advogados usa criado_em (não created_at); fichas_clientes usa created_at.
  FOREACH v IN ARRAY ARRAY['agenda_advogados.criado_em','fichas_clientes.created_at','dfu_atendimentos.criado_em'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_attribute
                   WHERE attrelid = to_regclass('public.'||split_part(v, '.', 1))
                     AND attname = split_part(v, '.', 2) AND attnum > 0 AND NOT attisdropped) THEN
      RAISE EXCEPTION 'Coluna ausente: public.%. Confira a estrutura real antes de aplicar.', v;
    END IF;
  END LOOP;
END $crm3_preflight$;


-- =====================================================================
-- 1. AUTORIZAÇÃO DOS ATENDIMENTOS (inbox)
-- =====================================================================

-- 1.1 Titular ativo cuja área cobre um atendimento AINDA SEM responsável.
-- Motivo: com advogado_id NULL, pode_acessar_ficha() é falso para todos, e
-- conversas em triagem (ou que pediram humano antes de a área ser definida)
-- ficavam invisíveis no CRM. Estagiários e desenvolvedores NÃO entram aqui.
CREATE OR REPLACE FUNCTION public.crm_titular_da_area(p_area text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.advogados eu
    WHERE lower(eu.email) = lower(auth.jwt() ->> 'email')
      AND eu.ativo IS TRUE
      AND eu.cargo = 'advogado'
      AND (p_area IS NULL OR p_area = ANY(eu.areas_atuacao))
  );
$$;

-- 1.2 Acesso a um atendimento: com responsável → pode_acessar_ficha (regra
-- original, inclusive isolamento do desenvolvedor); sem responsável → 1.1.
CREATE OR REPLACE FUNCTION public.crm_pode_acessar_atendimento(p_telefone text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.dfu_atendimentos a
    WHERE a.telefone = p_telefone
      AND CASE WHEN a.advogado_id IS NOT NULL THEN public.pode_acessar_ficha(a.advogado_id)
               ELSE public.crm_titular_da_area(a.area) END
  );
$$;

REVOKE EXECUTE ON FUNCTION public.crm_titular_da_area(text), public.crm_pode_acessar_atendimento(text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.crm_titular_da_area(text), public.crm_pode_acessar_atendimento(text) TO authenticated;

-- 1.3 Leitura de atendimentos/mensagens sem responsável (soma-se às políticas
-- originais "dfu atendimento da equipe" e "dfu mensagens da equipe").
DROP POLICY IF EXISTS "crm atendimento sem responsavel" ON public.dfu_atendimentos;
CREATE POLICY "crm atendimento sem responsavel" ON public.dfu_atendimentos
  FOR SELECT TO authenticated
  USING (advogado_id IS NULL AND public.crm_titular_da_area(area));

DROP POLICY IF EXISTS "crm mensagens sem responsavel" ON public.dfu_mensagens;
CREATE POLICY "crm mensagens sem responsavel" ON public.dfu_mensagens
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.dfu_atendimentos a
                 WHERE a.telefone = dfu_mensagens.telefone
                   AND a.advogado_id IS NULL AND public.crm_titular_da_area(a.area)));


-- =====================================================================
-- 2. INBOX: etiquetas, autoria de respostas humanas e notas internas
-- =====================================================================

ALTER TABLE public.dfu_atendimentos
  ADD COLUMN IF NOT EXISTS etiquetas text[] NOT NULL DEFAULT '{}';

-- Respostas humanas entram na MESMA fila do bot (dfu_outbox, tipo 'resposta',
-- status 'PENDENTE'); o n8n ("10 | Fila de saída (cada minuto)") as envia com
-- os mesmos portões de compliance. autor_advogado_id NULL = mensagem do bot.
ALTER TABLE public.dfu_outbox
  ADD COLUMN IF NOT EXISTS autor_advogado_id uuid REFERENCES public.advogados(id);

-- A equipe acompanha o status das próprias respostas (PENDENTE/AMBIGUO/ENVIADO/BLOQUEADO).
GRANT SELECT ON public.dfu_outbox TO authenticated;
DROP POLICY IF EXISTS "crm outbox da equipe" ON public.dfu_outbox;
CREATE POLICY "crm outbox da equipe" ON public.dfu_outbox
  FOR SELECT TO authenticated
  USING (public.crm_pode_acessar_atendimento(telefone));

-- Notas internas: nunca são enviadas ao cliente. Sem UPDATE/DELETE (trilha de auditoria).
-- sistema = true: registro automático das ações (assumir, transferir, encerrar...).
CREATE TABLE IF NOT EXISTS public.dfu_notas_internas (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telefone  text NOT NULL REFERENCES public.dfu_atendimentos(telefone),
  autor_id  uuid NOT NULL REFERENCES public.advogados(id),
  texto     text NOT NULL CHECK (char_length(btrim(texto)) BETWEEN 1 AND 4000),
  sistema   boolean NOT NULL DEFAULT false,
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dfu_notas_tel ON public.dfu_notas_internas (telefone, criado_em);

ALTER TABLE public.dfu_notas_internas ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dfu_notas_internas FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.dfu_notas_internas TO authenticated;
GRANT ALL ON public.dfu_notas_internas TO service_role;

DROP POLICY IF EXISTS "crm notas leitura" ON public.dfu_notas_internas;
CREATE POLICY "crm notas leitura" ON public.dfu_notas_internas
  FOR SELECT TO authenticated
  USING (public.crm_pode_acessar_atendimento(telefone));

DROP POLICY IF EXISTS "crm notas criacao" ON public.dfu_notas_internas;
CREATE POLICY "crm notas criacao" ON public.dfu_notas_internas
  FOR INSERT TO authenticated
  WITH CHECK (autor_id = (SELECT public.advogado_atual_id())
              AND sistema = false
              AND public.crm_pode_acessar_atendimento(telefone));


-- =====================================================================
-- 3. INBOX: ações (RPCs). Erros trazem HINT 'crm_*' para a tela traduzir.
-- =====================================================================

-- 3.1 Assumir: pausa o bot, bloqueia saídas automáticas pendentes e, se não
-- houver responsável, atribui ao titular que assumiu. Também reabre conversas
-- encerradas/agendadas. Opt-out (descadastrado/bloqueado) NUNCA é reaberto.
-- (Para o caso comum o CRM continua usando a RPC original dfu_assumir_atendimento.)
CREATE OR REPLACE FUNCTION public.crm_atendimento_assumir(p_telefone text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.dfu_atendimentos%ROWTYPE; v_eu uuid := public.advogado_atual_id();
BEGIN
  SELECT * INTO a FROM public.dfu_atendimentos WHERE telefone = p_telefone FOR UPDATE;
  IF NOT FOUND OR v_eu IS NULL OR NOT public.crm_pode_acessar_atendimento(p_telefone) THEN
    RAISE EXCEPTION 'Atendimento não encontrado ou sem permissão.' USING ERRCODE = '42501', HINT = 'crm_sem_acesso';
  END IF;
  IF a.bloqueado OR a.status = 'descadastrado' THEN
    RAISE EXCEPTION 'O cliente pediu para não receber mensagens (opt-out).' USING HINT = 'crm_optout';
  END IF;
  UPDATE public.dfu_atendimentos
     SET status = 'humano', advogado_id = coalesce(advogado_id, v_eu),
         em_processamento_ate = NULL, slots_oferecidos = '[]'::jsonb, slots_expiram_em = NULL,
         atualizado_em = now()
   WHERE telefone = p_telefone;
  UPDATE public.dfu_outbox SET status = 'BLOQUEADO', concluido_em = now()
   WHERE telefone = p_telefone AND status = 'PENDENTE' AND tipo <> 'optout' AND autor_advogado_id IS NULL;
  INSERT INTO public.dfu_notas_internas (telefone, autor_id, texto, sistema)
  VALUES (p_telefone, v_eu,
          CASE WHEN a.advogado_id IS NULL THEN 'Assumiu o atendimento (estava sem responsável). Bot pausado.'
               WHEN a.status IN ('encerrado','agendado') THEN 'Reabriu o atendimento para conversa humana.'
               ELSE 'Assumiu o atendimento. Bot pausado.' END,
          true);
  RETURN true;
END;
$$;

-- 3.2 Responder ao cliente: só com atendimento humano ativo e dentro da janela
-- de 24 h do WhatsApp (fora dela, a Meta só aceita template).
CREATE OR REPLACE FUNCTION public.crm_atendimento_responder(p_telefone text, p_texto text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.dfu_atendimentos%ROWTYPE; v_eu uuid := public.advogado_atual_id();
        v_texto text := btrim(coalesce(p_texto, '')); v_id uuid;
BEGIN
  SELECT * INTO a FROM public.dfu_atendimentos WHERE telefone = p_telefone FOR UPDATE;
  IF NOT FOUND OR v_eu IS NULL OR NOT public.crm_pode_acessar_atendimento(p_telefone) THEN
    RAISE EXCEPTION 'Atendimento não encontrado ou sem permissão.' USING ERRCODE = '42501', HINT = 'crm_sem_acesso';
  END IF;
  IF a.bloqueado OR a.status = 'descadastrado' THEN
    RAISE EXCEPTION 'O cliente pediu para não receber mensagens (opt-out).' USING HINT = 'crm_optout';
  END IF;
  IF a.status <> 'humano' THEN
    RAISE EXCEPTION 'Assuma o atendimento antes de responder.' USING HINT = 'crm_assuma_primeiro';
  END IF;
  IF char_length(v_texto) NOT BETWEEN 1 AND 4000 THEN
    RAISE EXCEPTION 'A mensagem deve ter entre 1 e 4000 caracteres.' USING HINT = 'crm_texto_invalido';
  END IF;
  IF a.ultima_msg_cliente_em IS NULL OR a.ultima_msg_cliente_em < now() - interval '24 hours' THEN
    RAISE EXCEPTION 'Janela de 24 h do WhatsApp encerrada.' USING HINT = 'crm_janela_24h';
  END IF;
  INSERT INTO public.dfu_outbox (chave, telefone, tipo, texto, autor_advogado_id)
  VALUES ('humano:' || gen_random_uuid()::text, p_telefone, 'resposta', v_texto, v_eu)
  RETURNING id INTO v_id;
  UPDATE public.dfu_atendimentos SET atualizado_em = now() WHERE telefone = p_telefone;
  RETURN v_id;
END;
$$;

-- 3.3 Transferir: para qualquer titular ativo ou para estagiário supervisionado
-- por quem transfere. A ficha vinculada acompanha o novo responsável.
-- Desenvolvedor não transfere (mantém o isolamento dos dados de teste).
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
  IF NOT FOUND OR NOT (d.cargo = 'advogado' OR (d.cargo = 'estagiario' AND d.supervisor_id = v_eu)) THEN
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

-- 3.4 Devolver ao bot: só a partir de 'humano'. Marca a última mensagem do
-- cliente como processada para o bot NÃO responder de novo algo que a equipe
-- já respondeu; ele volta a agir na próxima mensagem do cliente.
CREATE OR REPLACE FUNCTION public.crm_atendimento_devolver_bot(p_telefone text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.dfu_atendimentos%ROWTYPE; v_eu uuid := public.advogado_atual_id();
BEGIN
  SELECT * INTO a FROM public.dfu_atendimentos WHERE telefone = p_telefone FOR UPDATE;
  IF NOT FOUND OR v_eu IS NULL OR NOT public.crm_pode_acessar_atendimento(p_telefone) THEN
    RAISE EXCEPTION 'Atendimento não encontrado ou sem permissão.' USING ERRCODE = '42501', HINT = 'crm_sem_acesso';
  END IF;
  IF a.bloqueado OR a.status <> 'humano' THEN
    RAISE EXCEPTION 'Só é possível devolver ao bot um atendimento humano ativo.' USING HINT = 'crm_estado_invalido';
  END IF;
  UPDATE public.dfu_atendimentos
     SET status = 'em_andamento', em_processamento_ate = NULL, tentativas_ia = 0,
         ultima_msg_processada_id = ultima_msg_id, atualizado_em = now()
   WHERE telefone = p_telefone;
  INSERT INTO public.dfu_notas_internas (telefone, autor_id, texto, sistema)
  VALUES (p_telefone, v_eu, 'Devolveu o atendimento ao bot.', true);
  RETURN true;
END;
$$;

-- 3.5 Resolver/encerrar: bloqueia saídas AUTOMÁTICAS pendentes; respostas
-- humanas já enfileiradas continuam sendo enviadas. Opt-out permanece opt-out.
CREATE OR REPLACE FUNCTION public.crm_atendimento_encerrar(p_telefone text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.dfu_atendimentos%ROWTYPE; v_eu uuid := public.advogado_atual_id();
BEGIN
  SELECT * INTO a FROM public.dfu_atendimentos WHERE telefone = p_telefone FOR UPDATE;
  IF NOT FOUND OR v_eu IS NULL OR NOT public.crm_pode_acessar_atendimento(p_telefone) THEN
    RAISE EXCEPTION 'Atendimento não encontrado ou sem permissão.' USING ERRCODE = '42501', HINT = 'crm_sem_acesso';
  END IF;
  IF a.status IN ('descadastrado', 'encerrado') THEN
    RAISE EXCEPTION 'Este atendimento já está encerrado.' USING HINT = 'crm_estado_invalido';
  END IF;
  UPDATE public.dfu_atendimentos
     SET status = 'encerrado', em_processamento_ate = NULL, slots_oferecidos = '[]'::jsonb,
         slots_expiram_em = NULL, ultima_msg_processada_id = ultima_msg_id, atualizado_em = now()
   WHERE telefone = p_telefone;
  UPDATE public.dfu_outbox SET status = 'BLOQUEADO', concluido_em = now()
   WHERE telefone = p_telefone AND status = 'PENDENTE' AND tipo <> 'optout' AND autor_advogado_id IS NULL;
  INSERT INTO public.dfu_notas_internas (telefone, autor_id, texto, sistema)
  VALUES (p_telefone, v_eu, 'Encerrou o atendimento.', true);
  RETURN true;
END;
$$;

-- 3.6 Etiquetas: minúsculas, sem repetição, até 12 de até 30 caracteres.
CREATE OR REPLACE FUNCTION public.crm_atendimento_etiquetas(p_telefone text, p_etiquetas text[])
RETURNS text[] LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v text[];
BEGIN
  IF public.advogado_atual_id() IS NULL OR NOT public.crm_pode_acessar_atendimento(p_telefone) THEN
    RAISE EXCEPTION 'Atendimento não encontrado ou sem permissão.' USING ERRCODE = '42501', HINT = 'crm_sem_acesso';
  END IF;
  SELECT coalesce(array_agg(DISTINCT t ORDER BY t), '{}') INTO v
    FROM (SELECT left(lower(btrim(x)), 30) AS t FROM unnest(coalesce(p_etiquetas, '{}')) AS x) s
   WHERE t <> '';
  IF cardinality(v) > 12 THEN
    RAISE EXCEPTION 'Use no máximo 12 etiquetas.' USING HINT = 'crm_texto_invalido';
  END IF;
  UPDATE public.dfu_atendimentos SET etiquetas = v, atualizado_em = now() WHERE telefone = p_telefone;
  RETURN v;
END;
$$;

REVOKE EXECUTE ON FUNCTION
  public.crm_atendimento_assumir(text), public.crm_atendimento_responder(text, text),
  public.crm_atendimento_transferir(text, uuid), public.crm_atendimento_devolver_bot(text),
  public.crm_atendimento_encerrar(text), public.crm_atendimento_etiquetas(text, text[])
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION
  public.crm_atendimento_assumir(text), public.crm_atendimento_responder(text, text),
  public.crm_atendimento_transferir(text, uuid), public.crm_atendimento_devolver_bot(text),
  public.crm_atendimento_encerrar(text), public.crm_atendimento_etiquetas(text, text[])
  TO authenticated;

-- 3.7 Supabase Realtime (o RLS acima continua filtrando o que cada um recebe).
DO $crm3_realtime$
DECLARE t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RAISE NOTICE 'Publicação supabase_realtime não encontrada: o CRM usará atualização periódica.';
  ELSIF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime' AND puballtables) THEN
    RAISE NOTICE 'supabase_realtime já publica todas as tabelas.';
  ELSE
    FOREACH t IN ARRAY ARRAY['dfu_atendimentos','dfu_mensagens','dfu_outbox','dfu_notas_internas'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
      END IF;
    END LOOP;
  END IF;
END $crm3_realtime$;


-- =====================================================================
-- 4. AGENDA: campos e fila para sincronização com Google Calendar
-- (preparação: nada é enviado ao Google até agenda_google_contas.ativo = true
--  para o advogado E um worker — n8n — consumir a fila).
-- =====================================================================

ALTER TABLE public.agenda_advogados
  ADD COLUMN IF NOT EXISTS link_reuniao           text,
  ADD COLUMN IF NOT EXISTS google_calendar_id     text,
  ADD COLUMN IF NOT EXISTS google_event_id        text,
  ADD COLUMN IF NOT EXISTS google_etag            text,
  ADD COLUMN IF NOT EXISTS google_sincronizado_em timestamptz;

DO $crm3_link$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agenda_link_reuniao_https'
                 AND conrelid = 'public.agenda_advogados'::regclass) THEN
    ALTER TABLE public.agenda_advogados ADD CONSTRAINT agenda_link_reuniao_https
      CHECK (link_reuniao IS NULL OR link_reuniao ~ '^https://');
  END IF;
END $crm3_link$;

CREATE UNIQUE INDEX IF NOT EXISTS agenda_google_evento_unico
  ON public.agenda_advogados (google_calendar_id, google_event_id) WHERE google_event_id IS NOT NULL;

-- 4.1 Agenda Google de cada advogado. Tokens OAuth NÃO ficam no banco: vivem
-- nas credenciais do n8n. O advogado só enxerga a própria configuração.
CREATE TABLE IF NOT EXISTS public.agenda_google_contas (
  advogado_id        uuid PRIMARY KEY REFERENCES public.advogados(id) ON DELETE CASCADE,
  google_calendar_id text NOT NULL,
  ativo              boolean NOT NULL DEFAULT false,
  sync_token         text,
  canal_id           text,
  canal_resource_id  text,
  canal_expira_em    timestamptz,
  atualizado_em      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.agenda_google_contas ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.agenda_google_contas FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.agenda_google_contas TO authenticated;
GRANT ALL ON public.agenda_google_contas TO service_role;
DROP POLICY IF EXISTS "google contas leitura" ON public.agenda_google_contas;
CREATE POLICY "google contas leitura" ON public.agenda_google_contas
  FOR SELECT TO authenticated USING (public.pode_acessar_ficha(advogado_id));

-- 4.2 Fila de saída CRM → Google (consumida só pelo worker com service_role).
CREATE TABLE IF NOT EXISTS public.agenda_google_fila (
  id                 bigserial PRIMARY KEY,
  agenda_id          uuid NOT NULL,           -- sem FK: exclusões precisam continuar na fila
  advogado_id        uuid NOT NULL,
  operacao           text NOT NULL CHECK (operacao IN ('upsert', 'delete')),
  google_calendar_id text,
  google_event_id    text,
  status             text NOT NULL DEFAULT 'PENDENTE'
                     CHECK (status IN ('PENDENTE', 'PROCESSANDO', 'OK', 'ERRO', 'IGNORADO')),
  tentativas         int NOT NULL DEFAULT 0,
  erro               text,
  criado_em          timestamptz NOT NULL DEFAULT now(),
  processado_em      timestamptz
);
CREATE INDEX IF NOT EXISTS agenda_google_fila_status ON public.agenda_google_fila (status, id);

-- 4.3 Notificações push recebidas do Google (Edge Function google-calendar-webhook).
CREATE TABLE IF NOT EXISTS public.agenda_google_notificacoes (
  id              bigserial PRIMARY KEY,
  canal_id        text NOT NULL,
  resource_id     text,
  estado          text NOT NULL,
  mensagem_numero bigint,
  recebido_em     timestamptz NOT NULL DEFAULT now(),
  processado      boolean NOT NULL DEFAULT false
);

ALTER TABLE public.agenda_google_fila ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agenda_google_notificacoes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.agenda_google_fila, public.agenda_google_notificacoes FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.agenda_google_fila_id_seq, public.agenda_google_notificacoes_id_seq
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.agenda_google_fila, public.agenda_google_notificacoes TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.agenda_google_fila_id_seq, public.agenda_google_notificacoes_id_seq
  TO service_role;

-- 4.4 Enfileira alterações relevantes. Ignora: mudanças só em colunas google_*
-- (retorno do próprio sincronizador) e alterações vindas do Google
-- (crm.origem_sync = 'google'), evitando eco infinito.
CREATE OR REPLACE FUNCTION public.crm_agenda_enfileirar_google()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.agenda_advogados%ROWTYPE; v_cal text;
BEGIN
  IF coalesce(current_setting('crm.origem_sync', true), '') = 'google' THEN RETURN NULL; END IF;
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  IF TG_OP = 'UPDATE' AND
     (NEW.advogado_id, NEW.titulo_evento, NEW.area_juridica, NEW.data_hora_inicio,
      NEW.data_hora_fim, NEW.status, NEW.link_reuniao, NEW.ficha_id)
     IS NOT DISTINCT FROM
     (OLD.advogado_id, OLD.titulo_evento, OLD.area_juridica, OLD.data_hora_inicio,
      OLD.data_hora_fim, OLD.status, OLD.link_reuniao, OLD.ficha_id) THEN
    RETURN NULL;
  END IF;
  SELECT c.google_calendar_id INTO v_cal FROM public.agenda_google_contas c
   WHERE c.advogado_id = r.advogado_id AND c.ativo IS TRUE;
  IF v_cal IS NULL AND r.google_event_id IS NULL THEN RETURN NULL; END IF;  -- sincronização desligada
  INSERT INTO public.agenda_google_fila (agenda_id, advogado_id, operacao, google_calendar_id, google_event_id)
  VALUES (r.id, r.advogado_id,
          CASE WHEN TG_OP = 'DELETE' OR r.status = 'cancelado' THEN 'delete' ELSE 'upsert' END,
          coalesce(r.google_calendar_id, v_cal), r.google_event_id);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS crm_agenda_google_sync ON public.agenda_advogados;
CREATE TRIGGER crm_agenda_google_sync
  AFTER INSERT OR UPDATE OR DELETE ON public.agenda_advogados
  FOR EACH ROW EXECUTE FUNCTION public.crm_agenda_enfileirar_google();

-- 4.5 Worker: retira lote da fila (com retentativa de erros após 10 min, até 5 vezes).
CREATE OR REPLACE FUNCTION public.crm_google_retirar_fila(p_limite int DEFAULT 20)
RETURNS TABLE (fila_id bigint, agenda_id uuid, operacao text, google_calendar_id text,
               google_event_id text, titulo text, area text, inicio timestamptz, fim timestamptz,
               link_reuniao text, status_evento text)
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  WITH claim AS (
    SELECT f.id FROM public.agenda_google_fila f
     WHERE f.status = 'PENDENTE'
        OR (f.status IN ('ERRO', 'PROCESSANDO') AND f.tentativas < 5
            AND f.processado_em < now() - interval '10 minutes')
     ORDER BY f.id
     LIMIT least(greatest(coalesce(p_limite, 20), 1), 100)
     FOR UPDATE SKIP LOCKED
  ), upd AS (
    UPDATE public.agenda_google_fila f
       SET status = 'PROCESSANDO', tentativas = f.tentativas + 1, processado_em = now()
      FROM claim WHERE f.id = claim.id
    RETURNING f.id, f.agenda_id, f.operacao, f.google_calendar_id, f.google_event_id
  )
  SELECT u.id, u.agenda_id, u.operacao, u.google_calendar_id, coalesce(u.google_event_id, g.google_event_id),
         g.titulo_evento, g.area_juridica, g.data_hora_inicio, g.data_hora_fim, g.link_reuniao, g.status
    FROM upd u LEFT JOIN public.agenda_advogados g ON g.id = u.agenda_id
   ORDER BY u.id;
$$;

-- 4.6 Worker: conclui um item; em sucesso grava o id/etag do evento no CRM.
CREATE OR REPLACE FUNCTION public.crm_google_concluir(
  p_fila_id bigint, p_ok boolean, p_google_event_id text DEFAULT NULL,
  p_google_calendar_id text DEFAULT NULL, p_etag text DEFAULT NULL, p_erro text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_agenda uuid; v_op text;
BEGIN
  UPDATE public.agenda_google_fila
     SET status = CASE WHEN p_ok THEN 'OK' ELSE 'ERRO' END, erro = left(p_erro, 500), processado_em = now()
   WHERE id = p_fila_id AND status = 'PROCESSANDO'
  RETURNING agenda_id, operacao INTO v_agenda, v_op;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_ok AND v_op = 'upsert' THEN
    UPDATE public.agenda_advogados
       SET google_event_id = coalesce(p_google_event_id, google_event_id),
           google_calendar_id = coalesce(p_google_calendar_id, google_calendar_id),
           google_etag = p_etag, google_sincronizado_em = now()
     WHERE id = v_agenda;
  ELSIF p_ok AND v_op = 'delete' THEN
    UPDATE public.agenda_advogados
       SET google_event_id = NULL, google_etag = NULL, google_sincronizado_em = now()
     WHERE id = v_agenda;
  END IF;
  RETURN true;
END;
$$;

-- 4.7 Worker: aplica no CRM uma alteração feita no Google (sentido Google → CRM).
-- Só atualiza compromissos que nasceram no CRM (achados por google_event_id);
-- eventos pessoais criados direto no Google NÃO são importados nesta fase.
-- O trigger dfu_prevenir_sobreposicao_agenda continua valendo: conflito → 'conflito'.
CREATE OR REPLACE FUNCTION public.crm_google_aplicar_alteracao(
  p_calendar_id text, p_event_id text, p_inicio timestamptz, p_fim timestamptz,
  p_cancelado boolean DEFAULT false, p_etag text DEFAULT NULL)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE g public.agenda_advogados%ROWTYPE;
BEGIN
  PERFORM set_config('crm.origem_sync', 'google', true);
  SELECT * INTO g FROM public.agenda_advogados
   WHERE google_calendar_id = p_calendar_id AND google_event_id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'ignorado'; END IF;
  IF p_etag IS NOT NULL AND p_etag IS NOT DISTINCT FROM g.google_etag THEN RETURN 'sem_alteracao'; END IF;
  BEGIN
    IF p_cancelado THEN
      UPDATE public.agenda_advogados SET status = 'cancelado', google_etag = p_etag, google_sincronizado_em = now()
       WHERE id = g.id;
    ELSE
      UPDATE public.agenda_advogados
         SET data_hora_inicio = p_inicio, data_hora_fim = p_fim, google_etag = p_etag, google_sincronizado_em = now()
       WHERE id = g.id;
    END IF;
  EXCEPTION
    WHEN unique_violation THEN RETURN 'conflito';   -- agenda ocupada (trigger dfu)
    WHEN check_violation THEN RETURN 'invalido';    -- ex.: término antes do início
  END;
  RETURN 'atualizado';
END;
$$;

-- (A função de trigger crm_agenda_enfileirar_google não recebe REVOKE: funções de
-- trigger não podem ser chamadas diretamente, e o disparo não deve depender de grants.)
REVOKE EXECUTE ON FUNCTION
  public.crm_google_retirar_fila(int),
  public.crm_google_concluir(bigint, boolean, text, text, text, text),
  public.crm_google_aplicar_alteracao(text, text, timestamptz, timestamptz, boolean, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.crm_google_retirar_fila(int),
  public.crm_google_concluir(bigint, boolean, text, text, text, text),
  public.crm_google_aplicar_alteracao(text, text, timestamptz, timestamptz, boolean, text)
  TO service_role;


-- =====================================================================
-- 5. PROCESSOS E PRAZOS FATAIS
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.processos_prazos (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ficha_id        uuid REFERENCES public.fichas_clientes(id) ON DELETE SET NULL,  -- prazo nunca some junto
  advogado_id     uuid NOT NULL REFERENCES public.advogados(id),
  numero_cnj      text NOT NULL CHECK (numero_cnj ~ '^[0-9]{7}-[0-9]{2}\.[0-9]{4}\.[0-9]\.[0-9]{2}\.[0-9]{4}$'),
  tribunal_vara   text,
  fase_processual text,
  descricao_prazo text NOT NULL CHECK (btrim(descricao_prazo) <> ''),
  data_fatal      date NOT NULL,
  tipo_contagem   text NOT NULL DEFAULT 'uteis' CHECK (tipo_contagem IN ('uteis', 'corridos')),
  status          text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'cumprido', 'urgente')),
  observacoes     text,
  cumprido_em     timestamptz,
  criado_por      uuid REFERENCES public.advogados(id) DEFAULT public.advogado_atual_id(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS processos_prazos_advogado_data ON public.processos_prazos (advogado_id, data_fatal);
CREATE INDEX IF NOT EXISTS processos_prazos_ficha ON public.processos_prazos (ficha_id);

-- Reaproveita a regra existente: só vincula ficha que o usuário consegue ver.
DROP TRIGGER IF EXISTS crm_prazos_valida_ficha ON public.processos_prazos;
CREATE TRIGGER crm_prazos_valida_ficha
  BEFORE INSERT OR UPDATE ON public.processos_prazos
  FOR EACH ROW EXECUTE FUNCTION public.agenda_valida_ficha();

CREATE OR REPLACE FUNCTION public.crm_prazos_carimbos()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  NEW.updated_at := now();
  IF NEW.status = 'cumprido' THEN
    IF TG_OP = 'INSERT' OR OLD.status <> 'cumprido' THEN NEW.cumprido_em := now(); END IF;
  ELSE
    NEW.cumprido_em := NULL;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS crm_prazos_carimbos ON public.processos_prazos;
CREATE TRIGGER crm_prazos_carimbos
  BEFORE INSERT OR UPDATE ON public.processos_prazos
  FOR EACH ROW EXECUTE FUNCTION public.crm_prazos_carimbos();

ALTER TABLE public.processos_prazos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.processos_prazos FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.processos_prazos TO authenticated;

DROP POLICY IF EXISTS "prazos: leitura pela equipe responsável" ON public.processos_prazos;
CREATE POLICY "prazos: leitura pela equipe responsável" ON public.processos_prazos
  FOR SELECT TO authenticated USING (public.pode_acessar_ficha(advogado_id));

DROP POLICY IF EXISTS "prazos: criação pela equipe responsável" ON public.processos_prazos;
CREATE POLICY "prazos: criação pela equipe responsável" ON public.processos_prazos
  FOR INSERT TO authenticated WITH CHECK (public.pode_acessar_ficha(advogado_id));

DROP POLICY IF EXISTS "prazos: atualização pela equipe responsável" ON public.processos_prazos;
CREATE POLICY "prazos: atualização pela equipe responsável" ON public.processos_prazos
  FOR UPDATE TO authenticated
  USING (public.pode_acessar_ficha(advogado_id))
  WITH CHECK (public.pode_acessar_ficha(advogado_id));

-- Exclusão: estagiário não exclui prazo (só marca como cumprido); titular e
-- desenvolvedor (dados de teste próprios) podem excluir.
DROP POLICY IF EXISTS "prazos: exclusão por titular" ON public.processos_prazos;
CREATE POLICY "prazos: exclusão por titular" ON public.processos_prazos
  FOR DELETE TO authenticated
  USING (public.pode_acessar_ficha(advogado_id)
         AND EXISTS (SELECT 1 FROM public.advogados eu
                     WHERE eu.id = (SELECT public.advogado_atual_id())
                       AND eu.cargo IN ('advogado', 'desenvolvedor')));

-- Feriados (dfu_feriados) passam a ser legíveis pela equipe: usados no cálculo
-- de dias úteis e na agenda. Não contêm dado pessoal.
GRANT SELECT ON public.dfu_feriados TO authenticated;
DROP POLICY IF EXISTS "crm feriados leitura" ON public.dfu_feriados;
CREATE POLICY "crm feriados leitura" ON public.dfu_feriados FOR SELECT TO authenticated USING (true);


-- =====================================================================
-- 6. INDICADORES (somente contagens agregadas, sem dado pessoal)
-- Titular (cargo 'advogado'): visão do escritório. Estagiário/desenvolvedor:
-- só o próprio escopo (pode_acessar_ficha). Dados de contas 'desenvolvedor'
-- nunca entram na visão do escritório.
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
  SELECT cargo = 'advogado' INTO v_escritorio FROM public.advogados WHERE id = v_eu;

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

NOTIFY pgrst, 'reload schema';
COMMIT;

-- Dias & Fernandes | BOT UNIFICADO / CRM | v2.1 - 2026-11-18
-- PRE-REQUISITO: o esquema atual do CRM JA DEVE ESTAR INSTALADO.
-- NUNCA execute schema.sql inteiro como etapa de instalacao deste bot em banco existente.
-- Primeiro rode o diagnostico de leitura 00_diagnostico_preinstalacao.sql.
-- Usa as tabelas EXISTENTES: advogados, fichas_clientes, agenda_advogados,
-- disponibilidade_advogados e conversas_memoria. NÃO cria CRM paralelo.
-- Execute em ambiente de testes antes de qualquer execução em produção.
BEGIN;

-- Fail-fast: protege o CRM contra a tentativa de instalar a extensao sem as
-- estruturas preexistentes. Nao cria nem atualiza tabelas historicas do CRM.
DO $dfu_preflight$
DECLARE v_tabela text; v_coluna text; v_requeridas text[];
BEGIN
  FOREACH v_tabela IN ARRAY ARRAY['advogados','fichas_clientes','agenda_advogados',
                                   'disponibilidade_advogados','conversas_memoria'] LOOP
    IF to_regclass('public.'||v_tabela) IS NULL THEN
      RAISE EXCEPTION 'CRM incompleto: tabela public.% ausente. Corrija em homologacao sem reexecutar schema.sql inteiro.',v_tabela;
    END IF;
  END LOOP;
  IF to_regprocedure('public.pode_acessar_ficha(uuid)') IS NULL THEN
    RAISE EXCEPTION 'CRM incompleto: funcao de acesso pode_acessar_ficha(uuid) ausente';
  END IF;
  FOREACH v_coluna IN ARRAY ARRAY['advogado_id','data_hora_inicio','data_hora_fim','status','ficha_id','titulo_evento','area_juridica','prioridade'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_attribute
       WHERE attrelid='public.agenda_advogados'::regclass AND attname=v_coluna AND attnum>0 AND NOT attisdropped) THEN
      RAISE EXCEPTION 'CRM incompleto: coluna agenda_advogados.% ausente',v_coluna;
    END IF;
  END LOOP;
  FOREACH v_coluna IN ARRAY ARRAY['advogado_id','dia_semana','hora_inicio','hora_fim','duracao_reuniao_min','max_reunioes_dia','ativo'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_attribute
       WHERE attrelid='public.disponibilidade_advogados'::regclass AND attname=v_coluna AND attnum>0 AND NOT attisdropped) THEN
      RAISE EXCEPTION 'CRM incompleto: coluna disponibilidade_advogados.% ausente',v_coluna;
    END IF;
  END LOOP;
END;
$dfu_preflight$;

CREATE TABLE IF NOT EXISTS public.dfu_atendimentos (
 telefone text PRIMARY KEY CHECK (telefone ~ '^55[1-9][0-9]9[0-9]{8}$'),
 nome_cliente text, area text, tipo_caso text NOT NULL DEFAULT 'geral',
 etapa text NOT NULL DEFAULT 'recepcao', prioridade text NOT NULL DEFAULT 'media',
 motivo_prioridade text, dados_coletados jsonb NOT NULL DEFAULT '{}'::jsonb,
 resumo_fatos text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'em_andamento' CHECK (status IN ('em_andamento','aguardando_horario','agendado','humano','encerrado','descadastrado')),
 advogado_id uuid REFERENCES public.advogados(id), ficha_id uuid REFERENCES public.fichas_clientes(id),
 slots_oferecidos jsonb NOT NULL DEFAULT '[]'::jsonb, slots_expiram_em timestamptz,
 bloqueado boolean NOT NULL DEFAULT false,
 intro_enviada boolean NOT NULL DEFAULT false,
 consentimento_proativo boolean NOT NULL DEFAULT false,
 optin_origem text,
 ultima_msg_cliente_em timestamptz, ultima_msg_bot_em timestamptz,
 ultima_msg_id text, ultima_msg_processada_id text,
 em_processamento_ate timestamptz, tentativas_ia int NOT NULL DEFAULT 0,
 followup_enviado_em timestamptz, followup_tentativas int NOT NULL DEFAULT 0,
 criado_em timestamptz NOT NULL DEFAULT now(), atualizado_em timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT dfu_area_check CHECK (area IS NULL OR area IN ('trabalhista','empresarial','civil','cartorario_reurb','previdenciario','tributario')),
 CONSTRAINT dfu_prioridade_check CHECK (prioridade IN ('alta','media','baixa'))
);

CREATE INDEX IF NOT EXISTS dfu_atendimentos_recuperacao
  ON public.dfu_atendimentos(status, em_processamento_ate, ultima_msg_cliente_em);

CREATE TABLE IF NOT EXISTS public.dfu_mensagens (
 id bigserial PRIMARY KEY,
 provider_id text UNIQUE,
 telefone text NOT NULL REFERENCES public.dfu_atendimentos(telefone),
 direcao text NOT NULL CHECK (direcao IN ('IN','OUT')),
 tipo text NOT NULL DEFAULT 'texto',
 conteudo text NOT NULL DEFAULT '',
 criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dfu_mensagens_tel_id ON public.dfu_mensagens(telefone,id DESC);

CREATE TABLE IF NOT EXISTS public.dfu_outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 chave text NOT NULL UNIQUE,
 telefone text NOT NULL REFERENCES public.dfu_atendimentos(telefone),
 tipo text NOT NULL CHECK (tipo IN ('intro','resposta','horarios','confirmacao','optout','followup')),
 texto text NOT NULL,
 status text NOT NULL DEFAULT 'PENDENTE' CHECK (status IN ('PENDENTE','AMBIGUO','ENVIADO','BLOQUEADO')),
 provider_id text UNIQUE,
 criado_em timestamptz NOT NULL DEFAULT now(),
 tentado_em timestamptz,
 concluido_em timestamptz
);
CREATE INDEX IF NOT EXISTS dfu_outbox_fila ON public.dfu_outbox(status,criado_em);
CREATE TABLE IF NOT EXISTS public.dfu_feriados (
 dia date PRIMARY KEY,
 descricao text NOT NULL DEFAULT 'Sem atendimento'
);
CREATE TABLE IF NOT EXISTS public.dfu_erros (
 id bigserial PRIMARY KEY,
 etapa text NOT NULL,
 codigo text NOT NULL,
 referencia text,
 criado_em timestamptz NOT NULL DEFAULT now()
);

-- Estrutura compatível com o parser do DF_01_Importacao.json original.
-- NUNCA equivale a opt-in, nem habilita contato ativo por conter CPF/CNPJ.
CREATE TABLE IF NOT EXISTS public.dfu_origens (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 origem text NOT NULL, linha_origem int, tipo_pessoa text,
 nome text, nome_exibicao text, empresa text,
 cpf_cnpj text NOT NULL, telefone_e164 text, telefone_status text,
 email text, numero_processo text NOT NULL, numero_processo_fmt text,
 tribunal text, classe_judicial text, polo_ativo text,
 valor_causa numeric(18,2), data_distribuicao date,
 status_contato text NOT NULL DEFAULT 'NOVO_CONTATO',
 data_ultimo_contato timestamptz, conversa_id uuid, reserva boolean DEFAULT false,
 contato_bloqueado boolean DEFAULT false, erro_envio boolean DEFAULT false,
 lock_envio_em timestamptz, dados_brutos jsonb,
 criado_em timestamptz DEFAULT now(), atualizado_em timestamptz DEFAULT now(),
 UNIQUE(cpf_cnpj, numero_processo, telefone_e164)
);
CREATE TABLE IF NOT EXISTS public.dfu_revisoes (
 id bigserial PRIMARY KEY, origem text, linha_origem int,
 motivo text, dados_brutos jsonb, resolvido boolean DEFAULT false,
 criado_em timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dfu_origens_tel ON public.dfu_origens(telefone_e164);

ALTER TABLE public.dfu_atendimentos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dfu_mensagens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dfu_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dfu_feriados ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dfu_erros ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dfu_origens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dfu_revisoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversas_memoria ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dfu_atendimentos, public.dfu_mensagens, public.dfu_outbox,
 public.dfu_feriados, public.dfu_erros, public.dfu_origens, public.dfu_revisoes,
 public.conversas_memoria FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.dfu_mensagens_id_seq, public.dfu_erros_id_seq,
 public.dfu_revisoes_id_seq FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.dfu_atendimentos, public.dfu_mensagens, public.dfu_outbox,
 public.dfu_feriados, public.dfu_erros, public.dfu_origens, public.dfu_revisoes,
 public.conversas_memoria TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.dfu_mensagens_id_seq,
 public.dfu_erros_id_seq, public.dfu_revisoes_id_seq TO service_role;

-- Protecao contra sobreposicao para compromissos NOVOS ou REAGENDADOS.
-- Compatibilidade com legado: atualizacoes de status entre dois estados
-- ativos SEM mudar advogado/inicio/fim nao revalidam colisao preexistente.
-- Nao altera, completa nem limpa data_hora_fim de compromissos antigos.
-- Compromissos sem termino continuam contando como 60 minutos (fallback
-- conservador); analise-os no diagnostico antes de habilitar o bot.
-- Lock transacional por advogado serializa agendamentos concorrentes.
CREATE OR REPLACE FUNCTION public.dfu_proteger_agenda()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
 IF NEW.status NOT IN ('agendado','confirmado') THEN RETURN NEW; END IF;
 IF TG_OP = 'UPDATE' THEN
   IF OLD.status IN ('agendado','confirmado')
      AND NEW.advogado_id IS NOT DISTINCT FROM OLD.advogado_id
      AND NEW.data_hora_inicio IS NOT DISTINCT FROM OLD.data_hora_inicio
      AND NEW.data_hora_fim IS NOT DISTINCT FROM OLD.data_hora_fim THEN
     RETURN NEW; -- confirma/edita status do registro legado, sem reagendar
   END IF;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtext(NEW.advogado_id::text));
 IF EXISTS (
   SELECT 1 FROM public.agenda_advogados g
   WHERE g.advogado_id = NEW.advogado_id AND g.id <> NEW.id
     AND g.status IN ('agendado','confirmado')
     AND g.data_hora_inicio < COALESCE(NEW.data_hora_fim, NEW.data_hora_inicio + interval '60 minutes')
     AND COALESCE(g.data_hora_fim, g.data_hora_inicio + interval '60 minutes') > NEW.data_hora_inicio
 ) THEN
   RAISE EXCEPTION 'Agenda ocupada: reunião sobreposta para o advogado.' USING ERRCODE = '23505';
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS dfu_prevenir_sobreposicao_agenda ON public.agenda_advogados;
CREATE TRIGGER dfu_prevenir_sobreposicao_agenda
 BEFORE INSERT OR UPDATE OF advogado_id,data_hora_inicio,data_hora_fim,status
 ON public.agenda_advogados
 FOR EACH ROW EXECUTE FUNCTION public.dfu_proteger_agenda();

CREATE OR REPLACE FUNCTION public.dfu_receber(
 p_telefone text, p_provider_id text, p_texto text, p_tipo text DEFAULT 'texto',
 p_nome_whatsapp text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.dfu_atendimentos%ROWTYPE; v_nova boolean := false; v_texto text;
 v_processo boolean; v_mensagens jsonb; v_optout boolean;
BEGIN
 IF p_telefone IS NULL OR p_telefone !~ '^55[1-9][0-9]9[0-9]{8}$'
    OR nullif(btrim(p_provider_id),'') IS NULL THEN
  RETURN jsonb_build_object('processar_ia',false,'motivo','entrada_invalida');
 END IF;
 v_texto := left(btrim(coalesce(p_texto,'')),3000);
 INSERT INTO public.dfu_atendimentos(telefone,nome_cliente,ultima_msg_cliente_em)
 VALUES(p_telefone,nullif(left(btrim(coalesce(p_nome_whatsapp,'')),120),''),now())
 ON CONFLICT (telefone) DO NOTHING;
 SELECT * INTO v FROM public.dfu_atendimentos WHERE telefone=p_telefone FOR UPDATE;
 INSERT INTO public.dfu_mensagens(provider_id,telefone,direcao,tipo,conteudo)
 VALUES(p_provider_id,p_telefone,'IN',left(coalesce(p_tipo,'texto'),30),v_texto)
 ON CONFLICT (provider_id) DO NOTHING;
 IF NOT FOUND THEN RETURN jsonb_build_object('processar_ia',false,'motivo','duplicada','telefone',p_telefone); END IF;
 UPDATE public.dfu_atendimentos SET ultima_msg_cliente_em=now(),ultima_msg_id=p_provider_id,
 atualizado_em=now(),tentativas_ia=0
 WHERE telefone=p_telefone;
 UPDATE public.dfu_outbox SET status='BLOQUEADO'
 WHERE telefone=p_telefone AND tipo='followup' AND status='PENDENTE';
 -- Proteção rígida: opt-out antes de qualquer ação de IA.
 v_optout := lower(v_texto) ~ '(^|[[:space:][:punct:]])(sair|pare|parar|stop|descadastrar|remova|nao quero receber|não quero receber|não me contate)([[:space:][:punct:]]|$)';
 IF v_optout THEN
   UPDATE public.dfu_atendimentos SET status='descadastrado',bloqueado=true,
      slots_oferecidos='[]'::jsonb,slots_expiram_em=NULL,atualizado_em=now()
    WHERE telefone=p_telefone;
   UPDATE public.dfu_outbox SET status='BLOQUEADO' WHERE telefone=p_telefone AND status='PENDENTE';
   INSERT INTO public.dfu_outbox(chave,telefone,tipo,texto)
    VALUES('optout:'||p_telefone,p_telefone,'optout',
      'Seu pedido foi registrado. Não enviaremos novas mensagens. Se precisar, procure nossos canais oficiais.')
    ON CONFLICT (chave) DO NOTHING;
   RETURN jsonb_build_object('processar_ia',false,'motivo','optout','telefone',p_telefone);
 END IF;
 IF v.bloqueado OR v.status IN ('descadastrado','encerrado','agendado','humano') THEN
   RETURN jsonb_build_object('processar_ia',false,'motivo','atendimento_finalizado','telefone',p_telefone);
 END IF;
 -- Primeiro contato FIXO para todos os novos atendimentos espontâneos.
 IF NOT v.intro_enviada THEN
   UPDATE public.dfu_atendimentos SET intro_enviada=true,ultima_msg_processada_id=p_provider_id,atualizado_em=now() WHERE telefone=p_telefone;
   INSERT INTO public.dfu_outbox(chave,telefone,tipo,texto)
   VALUES('intro:'||p_telefone,p_telefone,'intro',
    'Olá! 👋 Sou a assistente virtual do escritório Dias & Fernandes. Vou conhecer seu caso e, se desejar, verificar um horário com um advogado da área. Você não precisa enviar documentos pessoais por aqui. Para começar, pode me dizer seu nome e o que aconteceu?')
   ON CONFLICT (chave) DO NOTHING;
   RETURN jsonb_build_object('processar_ia',false,'motivo','primeira_mensagem','telefone',p_telefone);
 END IF;
 IF v.em_processamento_ate IS NOT NULL AND v.em_processamento_ate > now() THEN
   RETURN jsonb_build_object('processar_ia',false,'motivo','processamento_em_curso','telefone',p_telefone);
 END IF;
 IF v.tentativas_ia >= 3 THEN
   UPDATE public.dfu_atendimentos SET status='humano',em_processamento_ate=NULL
   WHERE telefone=p_telefone;
   INSERT INTO public.dfu_erros(etapa,codigo,referencia)
   VALUES('receber','IA_TENTATIVAS_EXCEDIDAS',left(p_telefone,25));
   RETURN jsonb_build_object('processar_ia',false,'motivo','limite_ia','telefone',p_telefone);
 END IF;
 UPDATE public.dfu_atendimentos SET em_processamento_ate=now()+interval '120 seconds',
  tentativas_ia=tentativas_ia+1 WHERE telefone=p_telefone;
 SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.id),'[]'::jsonb)
 INTO v_mensagens FROM (
   SELECT id,direcao,tipo,conteudo,criado_em
   FROM public.dfu_mensagens WHERE telefone=p_telefone ORDER BY id DESC LIMIT 16
 ) m;
 RETURN jsonb_build_object('processar_ia',true,'telefone',p_telefone,
    'mensagem_atual',v_texto,'provider_id',p_provider_id,'tipo',p_tipo,'nome',coalesce(v.nome_cliente,p_nome_whatsapp),
    'estado',jsonb_build_object('area',v.area,'tipo_caso',v.tipo_caso,'etapa',v.etapa,
      'dados_coletados',v.dados_coletados,'status',v.status,
      'slots',v.slots_oferecidos,'prioridade',v.prioridade,'resumo_fatos',v.resumo_fatos),
    'historico',v_mensagens);
END;
$$;

-- Após um debounce de 8 segundos, recupera o histórico REAL já agregado.
-- A IA só recebe os dados necessários do próprio atendimento.
CREATE OR REPLACE FUNCTION public.dfu_contexto(p_telefone text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.dfu_atendimentos%ROWTYPE; v_hist jsonb;v_tipo text;v_texto text;
BEGIN
 SELECT * INTO v FROM public.dfu_atendimentos WHERE telefone=p_telefone;
 IF NOT FOUND OR v.bloqueado OR v.status IN ('humano','encerrado','agendado','descadastrado')
   OR v.em_processamento_ate IS NULL OR v.em_processamento_ate<now() THEN
   RETURN jsonb_build_object('processar_ia',false,'motivo','conversa_indisponivel');
 END IF;
 SELECT conteudo,tipo INTO v_texto,v_tipo FROM public.dfu_mensagens
  WHERE telefone=p_telefone AND direcao='IN' ORDER BY id DESC LIMIT 1;
 SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.id),'[]'::jsonb)
 INTO v_hist FROM (SELECT id,direcao,tipo,conteudo,criado_em FROM public.dfu_mensagens
    WHERE telefone=p_telefone ORDER BY id DESC LIMIT 16) m;
 RETURN jsonb_build_object('processar_ia',true,'telefone',p_telefone,
   'provider_id',v.ultima_msg_id,'mensagem_atual',coalesce(v_texto,''),
   'nome',v.nome_cliente,'tipo',v_tipo,
   'estado',jsonb_build_object('area',v.area,'tipo_caso',v.tipo_caso,
     'etapa',v.etapa,'dados_coletados',v.dados_coletados,'status',v.status,
     'slots',v.slots_oferecidos,'prioridade',v.prioridade,'resumo_fatos',v.resumo_fatos),
   'historico',v_hist);
END;
$$;

-- Recuperação durável de mensagens que chegaram durante um lease ou quando
-- n8n/OpenAI falhou. O cron do n8n chama esta função periodicamente.
-- Não envia mensagens nem reabre conversas finais.
CREATE OR REPLACE FUNCTION public.dfu_recuperar_pendentes(p_limite int DEFAULT 5)
RETURNS TABLE(telefone text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.dfu_atendimentos%ROWTYPE;
BEGIN
 FOR v IN
  SELECT * FROM public.dfu_atendimentos a
  WHERE a.intro_enviada=true AND a.bloqueado=false
   AND a.status IN ('em_andamento','aguardando_horario')
   AND a.ultima_msg_id IS NOT NULL
   AND a.ultima_msg_id IS DISTINCT FROM a.ultima_msg_processada_id
   AND (a.em_processamento_ate IS NULL OR a.em_processamento_ate < now())
  ORDER BY a.ultima_msg_cliente_em
  LIMIT least(greatest(coalesce(p_limite,5),1),20)
  FOR UPDATE SKIP LOCKED
 LOOP
  IF v.tentativas_ia >= 3 THEN
   UPDATE public.dfu_atendimentos a SET status='humano',em_processamento_ate=NULL,
       atualizado_em=now() WHERE a.telefone=v.telefone;
   INSERT INTO public.dfu_erros(etapa,codigo,referencia)
    VALUES('recuperacao','IA_TENTATIVAS_EXCEDIDAS',right(v.telefone,4));
   IF v.area IS NOT NULL THEN PERFORM public.dfu_criar_ficha(v.telefone); END IF;
  ELSE
   UPDATE public.dfu_atendimentos a
    SET em_processamento_ate=now()+interval '120 seconds',
        tentativas_ia=a.tentativas_ia+1,atualizado_em=now()
   WHERE a.telefone=v.telefone;
   telefone:=v.telefone;
   RETURN NEXT;
  END IF;
 END LOOP;
END;
$$;

-- Sugere opções EXCLUSIVAMENTE a partir da grade real do CRM.
-- Seleciona o especialista com maior quantidade de slots efetivamente livres
-- nos próximos 7 dias; desempata pela atribuição mais antiga.
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
   WHERE adv.ativo IS TRUE AND adv.cargo='advogado'
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
  WHERE ativo IS TRUE AND cargo='advogado' AND v_area=ANY(areas_atuacao)
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
     AND cargo='advogado' AND a.area=ANY(areas_atuacao)) OR
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

CREATE OR REPLACE FUNCTION public.dfu_aplicar_ia(p_telefone text,p_provider_id text,p_ia jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.dfu_atendimentos%ROWTYPE; v_acao text;v_area text;v_tipo text;
 v_msg text;v_nome text;v_prio text;v_result jsonb;v_reserva jsonb;
 v_opcao int;v_relatorio text;v_ficha uuid;v_vindo text;
BEGIN
 SELECT * INTO a FROM public.dfu_atendimentos WHERE telefone=p_telefone FOR UPDATE;
 IF NOT FOUND OR a.bloqueado OR a.status IN ('encerrado','humano','agendado','descadastrado') THEN
  RETURN jsonb_build_object('ok',false,'motivo','bloqueado_ou_finalizado');
 END IF;
 IF p_provider_id IS DISTINCT FROM a.ultima_msg_id OR
    NOT EXISTS(SELECT 1 FROM public.dfu_mensagens WHERE provider_id=p_provider_id
      AND telefone=p_telefone AND direcao='IN') THEN
  UPDATE public.dfu_atendimentos SET em_processamento_ate=NULL WHERE telefone=p_telefone;
  RETURN jsonb_build_object('ok',false,'motivo','mensagem_obsoleta');
 END IF;
 v_acao:=coalesce(p_ia->>'acao','humano');
 IF v_acao NOT IN ('perguntar','oferecer_horarios','confirmar_horario','humano','encerrar') THEN v_acao:='humano';END IF;
 v_area:=p_ia->>'area';
 IF v_area NOT IN ('trabalhista','empresarial','civil','cartorario_reurb','previdenciario','tributario') THEN v_area:=a.area;END IF;
 v_tipo:=CASE WHEN p_ia->>'tipo_caso'='sem_registro' THEN 'sem_registro' ELSE coalesce(a.tipo_caso,'geral') END;
 v_prio:=CASE WHEN p_ia->>'prioridade' IN ('alta','media','baixa') THEN p_ia->>'prioridade' ELSE a.prioridade END;
 v_msg:=left(coalesce(p_ia->>'mensagem_ao_cliente',''),650);
 v_nome:=nullif(left(btrim(coalesce(p_ia->>'nome_cliente','')),120),'');
 v_relatorio:=left(btrim(coalesce(p_ia->>'resumo_fatos','')),3500);
 UPDATE public.dfu_atendimentos SET
   nome_cliente=coalesce(v_nome,nome_cliente), area=coalesce(v_area,area),
   tipo_caso=v_tipo, prioridade=v_prio,
   motivo_prioridade=nullif(left(btrim(coalesce(p_ia->>'motivo_prioridade','')),250),''),
   dados_coletados=CASE WHEN jsonb_typeof(p_ia->'dados_coletados')='object'
      THEN coalesce(dados_coletados,'{}'::jsonb) || (p_ia->'dados_coletados')
      ELSE dados_coletados END,
   etapa=left(coalesce(nullif(p_ia->>'etapa',''),etapa),60),
   resumo_fatos=CASE WHEN v_relatorio<>'' THEN v_relatorio ELSE resumo_fatos END,
   em_processamento_ate=NULL,ultima_msg_processada_id=p_provider_id,
   tentativas_ia=0,atualizado_em=now()
   WHERE telefone=p_telefone;
 IF v_acao='confirmar_horario' THEN
   v_vindo:=(SELECT conteudo FROM public.dfu_mensagens WHERE provider_id=p_provider_id LIMIT 1);
   BEGIN v_opcao:=(p_ia->>'slot_escolhido')::int;
   EXCEPTION WHEN invalid_text_representation THEN v_opcao:=NULL; END;
   -- Confirmação só com escolha EXPRESSA: número ou ordinal na última mensagem.
   IF v_opcao BETWEEN 1 AND 3 AND
    (v_vindo ~ ('(^|[^0-9])'||v_opcao::text||'([^0-9]|$)') OR
       (v_opcao=1 AND lower(v_vindo) ~ '(primeir|1ª|1º)') OR
       (v_opcao=2 AND lower(v_vindo) ~ '(segund|2ª|2º)') OR
       (v_opcao=3 AND lower(v_vindo) ~ '(terceir|3ª|3º)')) THEN
     v_reserva:=public.dfu_confirmar(p_telefone,v_opcao);
   ELSE v_reserva:=jsonb_build_object('ok',false,'motivo','escolha_nao_explicita');
   END IF;
   IF coalesce((v_reserva->>'ok')::boolean,false) THEN
     v_msg:='Sua reunião foi agendada para '||(v_reserva->>'data_hora')||
       ' (horário de Brasília). O advogado terá acesso ao resumo do seu caso no CRM. A modalidade do encontro será confirmada pela equipe.';
   ELSE
     v_msg:='Esse horário não pôde ser confirmado. Vou verificar novas opções ou pedir que nossa equipe entre em contato.';
     v_result:=public.dfu_ofertar(p_telefone);
     IF coalesce((v_result->>'ok')::boolean,false) THEN
       v_msg:='O horário ficou indisponível. Estas são novas opções (Brasília): '||
         (SELECT string_agg((x->>'opcao')||') '||(x->>'exibicao'),'; ' ORDER BY (x->>'opcao')::int)
          FROM jsonb_array_elements(v_result->'slots') x)||'. Qual opção prefere?';
     ELSE
       UPDATE public.dfu_atendimentos SET status='humano' WHERE telefone=p_telefone;
       PERFORM public.dfu_criar_ficha(p_telefone);
     END IF;
   END IF;
 ELSIF v_acao='oferecer_horarios' THEN
   v_result:=public.dfu_ofertar(p_telefone);
   IF coalesce((v_result->>'ok')::boolean,false) THEN
     v_ficha:=public.dfu_criar_ficha(p_telefone);
     v_msg:='Posso agendar seu atendimento com um advogado da área. Horários livres (Brasília): '||
       (SELECT string_agg((x->>'opcao')||') '||(x->>'exibicao'),'; ' ORDER BY (x->>'opcao')::int)
        FROM jsonb_array_elements(v_result->'slots') x)||'. Qual opção prefere: 1, 2 ou 3?';
   ELSE
     UPDATE public.dfu_atendimentos SET status='humano' WHERE telefone=p_telefone;
     v_ficha:=public.dfu_criar_ficha(p_telefone);
     v_msg:='Já encaminhei as informações ao nosso escritório. No momento não há horários disponíveis na agenda cadastrada; a equipe poderá combinar um atendimento com você.';
   END IF;
 ELSIF v_acao='humano' THEN
   UPDATE public.dfu_atendimentos SET status='humano' WHERE telefone=p_telefone;
   UPDATE public.dfu_outbox SET status='BLOQUEADO',concluido_em=now()
   WHERE telefone=p_telefone AND status='PENDENTE' AND tipo IN ('horarios','followup');
   v_ficha:=public.dfu_criar_ficha(p_telefone);
   v_msg:='Vou encaminhar seu relato para nossa equipe jurídica. Um profissional poderá continuar o atendimento pelos canais oficiais.';
 ELSIF v_acao='encerrar' THEN
   UPDATE public.dfu_atendimentos SET status='encerrado' WHERE telefone=p_telefone;
   UPDATE public.dfu_outbox SET status='BLOQUEADO',concluido_em=now()
   WHERE telefone=p_telefone AND status='PENDENTE' AND tipo IN ('horarios','followup');
   v_msg:='Compreendido. Agradecemos o contato com Dias & Fernandes. Se precisar futuramente, estamos à disposição.';
 ELSE
   IF a.status='aguardando_horario' THEN
     -- IA pode esclarecer dúvidas, mas não desfaz oferta válida.
     UPDATE public.dfu_atendimentos SET status='aguardando_horario' WHERE telefone=p_telefone;
   END IF;
   IF v_msg='' THEN v_msg:='Entendi. Poderia me contar um pouco mais para que eu encaminhe seu caso corretamente?'; END IF;
 END IF;
 -- Sincronização com a memória do CRM (últimas 20 mensagens somente).
 INSERT INTO public.conversas_memoria(telefone_cliente,historico_mensagens,status,updated_at)
 VALUES(p_telefone,(SELECT coalesce(jsonb_agg(jsonb_build_object('role',CASE WHEN m.direcao='IN' THEN 'user' ELSE 'assistant' END,'content',m.conteudo) ORDER BY m.id),'[]'::jsonb) FROM (SELECT id,direcao,conteudo FROM public.dfu_mensagens WHERE telefone=p_telefone ORDER BY id DESC LIMIT 20) m),'em_andamento',now())
 ON CONFLICT(telefone_cliente) DO UPDATE SET
   historico_mensagens=EXCLUDED.historico_mensagens,
   status=(SELECT status FROM public.dfu_atendimentos WHERE telefone=p_telefone),updated_at=now();
 INSERT INTO public.dfu_outbox(chave,telefone,tipo,texto)
 VALUES('resposta:'||p_provider_id,p_telefone,
   CASE WHEN v_acao='oferecer_horarios' THEN 'horarios'
      WHEN v_acao='confirmar_horario' THEN 'confirmacao' ELSE 'resposta' END,v_msg)
 ON CONFLICT (chave) DO NOTHING;
 RETURN jsonb_build_object('ok',true,'telefone',p_telefone,'acao',v_acao,
    'ficha_id',(SELECT ficha_id FROM public.dfu_atendimentos WHERE telefone=p_telefone),
    'status',(SELECT status FROM public.dfu_atendimentos WHERE telefone=p_telefone));
END;
$$;

-- Claims marcam AMBIGUO ANTES do POST à Meta: uma falha/timeout não
-- provoca reenvio cego. O administrador deve reconciliar manualmente.
CREATE OR REPLACE FUNCTION public.dfu_retirar_saida(p_telefone text DEFAULT NULL,p_limite int DEFAULT 1)
RETURNS TABLE(id uuid,telefone text,tipo text,texto text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
 RETURN QUERY
 WITH claim AS (
   SELECT o.id FROM public.dfu_outbox o
   JOIN public.dfu_atendimentos a ON a.telefone=o.telefone
   WHERE o.status='PENDENTE' AND (p_telefone IS NULL OR o.telefone=p_telefone)
     AND (NOT a.bloqueado OR o.tipo='optout')
     AND (o.tipo IN ('optout','followup') OR a.ultima_msg_cliente_em>=now()-interval '24 hours')
     AND (o.tipo<>'followup' OR a.ultima_msg_cliente_em<=o.criado_em)
   ORDER BY o.criado_em LIMIT least(greatest(p_limite,1),10) FOR UPDATE OF o SKIP LOCKED
 )
 UPDATE public.dfu_outbox o SET status='AMBIGUO',tentado_em=now()
 FROM claim WHERE o.id=claim.id
 RETURNING o.id,o.telefone,o.tipo,o.texto;
END;
$$;

CREATE OR REPLACE FUNCTION public.dfu_marcar_saida(
 p_id uuid,p_status text,p_provider_id text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tel text; v_texto text;
BEGIN
 IF p_status NOT IN ('ENVIADO','BLOQUEADO') THEN RETURN false;END IF;
 UPDATE public.dfu_outbox SET status=p_status,provider_id=nullif(p_provider_id,''),concluido_em=now()
 WHERE id=p_id AND status='AMBIGUO' RETURNING telefone,texto INTO v_tel,v_texto;
 IF v_tel IS NULL THEN RETURN false; END IF;
 IF p_status='ENVIADO' THEN
   INSERT INTO public.dfu_mensagens(provider_id,telefone,direcao,tipo,conteudo)
   VALUES(p_provider_id,v_tel,'OUT','texto',v_texto) ON CONFLICT(provider_id) DO NOTHING;
   UPDATE public.dfu_atendimentos SET ultima_msg_bot_em=now() WHERE telefone=v_tel;
   INSERT INTO public.conversas_memoria(telefone_cliente,historico_mensagens,status,updated_at)
   VALUES(v_tel,(SELECT coalesce(jsonb_agg(jsonb_build_object('role',CASE WHEN m.direcao='IN' THEN 'user' ELSE 'assistant' END,'content',m.conteudo) ORDER BY m.id),'[]'::jsonb) FROM (SELECT id,direcao,conteudo FROM public.dfu_mensagens WHERE telefone=v_tel ORDER BY id DESC LIMIT 20) m),
     (SELECT status FROM public.dfu_atendimentos WHERE telefone=v_tel),now())
   ON CONFLICT(telefone_cliente) DO UPDATE SET
      historico_mensagens=EXCLUDED.historico_mensagens,
      status=EXCLUDED.status,updated_at=now();
 END IF;
 RETURN true;
END;
$$;

-- Revalidação imediatamente ANTES de encaminhar a requisição à Meta.
CREATE OR REPLACE FUNCTION public.dfu_verificar_saida(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o public.dfu_outbox%ROWTYPE; a public.dfu_atendimentos%ROWTYPE;
BEGIN
 SELECT * INTO o FROM public.dfu_outbox WHERE id=p_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('id',p_id,'permitir',false); END IF;
 SELECT * INTO a FROM public.dfu_atendimentos WHERE telefone=o.telefone;
 RETURN jsonb_build_object('id',p_id,'permitir',
    o.status='AMBIGUO' AND
    (NOT a.bloqueado OR o.tipo='optout') AND
    (o.tipo IN ('optout','followup') OR a.ultima_msg_cliente_em>=now()-interval '24 hours') AND
    (o.tipo<>'followup' OR a.ultima_msg_cliente_em<=o.criado_em));
END;
$$;

-- Follow-up único, somente para leads que iniciaram o contato e com opt-in
-- de reengajamento comprovado. É liberado como TEMPLATE pela API Meta,
-- nunca como texto livre fora da janela de atendimento de 24 horas.
CREATE OR REPLACE FUNCTION public.dfu_gerar_followups(p_habilitado boolean DEFAULT false)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_count int:=0;v public.dfu_atendimentos%ROWTYPE;
BEGIN
 IF NOT p_habilitado THEN RETURN 0;END IF;
 FOR v IN SELECT * FROM public.dfu_atendimentos a
   WHERE a.status='em_andamento' AND a.consentimento_proativo IS TRUE
    AND NOT a.bloqueado AND a.followup_tentativas=0
    AND a.ultima_msg_cliente_em<now()-interval '2 days'
   ORDER BY a.ultima_msg_cliente_em LIMIT 10 FOR UPDATE SKIP LOCKED
 LOOP
   INSERT INTO public.dfu_outbox(chave,telefone,tipo,texto)
   VALUES('followup:'||v.telefone,v.telefone,'followup',
     'Olá! Aqui é do escritório Dias & Fernandes. Gostaria de continuar seu atendimento?')
   ON CONFLICT (chave) DO NOTHING;
   UPDATE public.dfu_atendimentos SET followup_tentativas=1,followup_enviado_em=now()
   WHERE telefone=v.telefone;
   v_count:=v_count+1;
 END LOOP;
 RETURN v_count;
END;
$$;

-- Endpoints RPC só para o servidor n8n.
REVOKE ALL ON FUNCTION public.dfu_receber(text,text,text,text,text),
 public.dfu_contexto(text),public.dfu_recuperar_pendentes(int),public.dfu_ofertar(text),public.dfu_criar_ficha(text),public.dfu_confirmar(text,int),
 public.dfu_aplicar_ia(text,text,jsonb),public.dfu_retirar_saida(text,int),
 public.dfu_marcar_saida(uuid,text,text),public.dfu_verificar_saida(uuid),public.dfu_gerar_followups(boolean)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.dfu_receber(text,text,text,text,text),
 public.dfu_contexto(text),public.dfu_recuperar_pendentes(int),public.dfu_ofertar(text),public.dfu_criar_ficha(text),public.dfu_confirmar(text,int),
 public.dfu_aplicar_ia(text,text,jsonb),public.dfu_retirar_saida(text,int),
 public.dfu_marcar_saida(uuid,text,text),public.dfu_verificar_saida(uuid),public.dfu_gerar_followups(boolean)
 TO service_role;

-- Visibilidade interna: o advogado responsável acompanha o chat no CRM.
GRANT SELECT ON public.dfu_atendimentos,public.dfu_mensagens TO authenticated;
DROP POLICY IF EXISTS "dfu atendimento da equipe" ON public.dfu_atendimentos;
CREATE POLICY "dfu atendimento da equipe" ON public.dfu_atendimentos
 FOR SELECT TO authenticated USING(public.pode_acessar_ficha(advogado_id));
DROP POLICY IF EXISTS "dfu mensagens da equipe" ON public.dfu_mensagens;
CREATE POLICY "dfu mensagens da equipe" ON public.dfu_mensagens
 FOR SELECT TO authenticated USING(EXISTS(
    SELECT 1 FROM public.dfu_atendimentos a WHERE a.telefone=dfu_mensagens.telefone
      AND public.pode_acessar_ficha(a.advogado_id)));

CREATE OR REPLACE FUNCTION public.dfu_assumir_atendimento(p_telefone text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_adv uuid; v_qtd integer;
BEGIN
 SELECT advogado_id INTO v_adv FROM public.dfu_atendimentos
 WHERE telefone=p_telefone FOR UPDATE;
 IF v_adv IS NULL OR NOT public.pode_acessar_ficha(v_adv) THEN RETURN false; END IF;
 UPDATE public.dfu_atendimentos SET status='humano',em_processamento_ate=NULL,
 atualizado_em=now() WHERE telefone=p_telefone AND status NOT IN ('descadastrado','agendado','encerrado');
 GET DIAGNOSTICS v_qtd=ROW_COUNT;
 IF v_qtd>0 THEN
   UPDATE public.dfu_outbox SET status='BLOQUEADO',concluido_em=now()
   WHERE telefone=p_telefone AND status='PENDENTE' AND tipo<>'optout';
 END IF;
 RETURN v_qtd>0;
END;
$$;
REVOKE ALL ON FUNCTION public.dfu_assumir_atendimento(text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.dfu_assumir_atendimento(text) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;

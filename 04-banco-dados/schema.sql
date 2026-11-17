-- 1. TABELA DE ADVOGADOS E ESTAGIÁRIOS
CREATE TABLE advogados (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  nome TEXT NOT NULL,
  email TEXT UNIQUE,
  cargo TEXT DEFAULT 'advogado', -- 'advogado' ou 'estagiario'
  supervisor_id UUID REFERENCES advogados(id), -- Preenchido apenas para estagiários
  areas_atuacao TEXT[] NOT NULL,
  ativo BOOLEAN DEFAULT true,
  ultima_atribuicao TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 2. TABELA DE MEMÓRIA DA CONVERSA
CREATE TABLE conversas_memoria (
  telefone_cliente TEXT PRIMARY KEY,
  historico_mensagens JSONB DEFAULT '[]'::jsonb,
  status TEXT DEFAULT 'em_andamento',
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 3. TABELA DE FICHAS DOS CLIENTES
CREATE TABLE fichas_clientes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  nome_cliente TEXT NOT NULL,
  cpf TEXT,
  telefone TEXT NOT NULL,
  area_identificada TEXT NOT NULL,
  prioridade TEXT NOT NULL DEFAULT 'media',
  motivo_prioridade TEXT,
  resumo_fatos TEXT NOT NULL,
  documentos_urls TEXT[] DEFAULT '{}',
  processos_encontrados JSONB DEFAULT '[]'::jsonb,
  advogado_id UUID REFERENCES advogados(id),
  status_atendimento TEXT DEFAULT 'novo',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 4. OS 5 ADVOGADOS + 1 ESTAGIÁRIA DO ESCRITÓRIO
INSERT INTO advogados (nome, areas_atuacao, cargo) VALUES
  ('Fernanda Lemos Fernandes Rigo', ARRAY['trabalhista', 'empresarial'], 'advogado'),
  ('Kayo Ronnaro Silva Dias', ARRAY['civil'], 'advogado'),
  ('Guilherme Alves da Silva', ARRAY['cartorario_reurb'], 'advogado'),
  ('Karolina Kedma Araujo', ARRAY['trabalhista', 'previdenciario'], 'advogado'),
  ('Caio Pereira Melo', ARRAY['tributario'], 'advogado');

INSERT INTO advogados (nome, areas_atuacao, cargo, supervisor_id) VALUES
  (
    'Ana Júlia Rodrigues de Souza',
    ARRAY['trabalhista'],
    'estagiario',
    (SELECT id FROM advogados WHERE nome = 'Fernanda Lemos Fernandes Rigo' LIMIT 1)
  );

-- =====================================================================
-- 5. SEGURANÇA: ROW LEVEL SECURITY (RLS)
-- ---------------------------------------------------------------------
-- Pode ser executado mais de uma vez (idempotente). Para aplicar em um
-- banco já criado, rode APENAS esta seção no SQL Editor do Supabase.
--
-- Regras:
--   * Titular (cargo = 'advogado') vê e edita as fichas atribuídas a ele
--     e as fichas dos estagiários que ele supervisiona. Também pode
--     delegar fichas para esses estagiários e pegá-las de volta.
--   * Estagiário (cargo = 'estagiario') vê e edita só as fichas
--     atribuídas a ele e não pode repassá-las a ninguém.
--   * Advogado inativo (ativo = false) não vê nada.
--   * INSERT e DELETE não são liberados para usuários do CRM. O bot (n8n)
--     cria as fichas com a chave service_role, que ignora o RLS e deve
--     ficar SOMENTE no servidor.
--   * O usuário do Supabase Auth é ligado a advogados.email pelo e-mail
--     do JWT, sem diferenciar maiúsculas de minúsculas.
-- =====================================================================

-- 5.1 Índices usados pelas políticas
CREATE INDEX IF NOT EXISTS idx_fichas_clientes_advogado_id ON public.fichas_clientes (advogado_id);
CREATE INDEX IF NOT EXISTS idx_advogados_supervisor_id     ON public.advogados (supervisor_id);
CREATE INDEX IF NOT EXISTS idx_advogados_email_lower       ON public.advogados (lower(email));

-- 5.2 Função de autorização
-- SECURITY DEFINER: lê a tabela advogados sem depender das políticas dela.
-- search_path vazio: impede sequestro de objetos por outro schema.
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
        -- ficha atribuída ao próprio usuário (titular ou estagiário)
        (eu.id = responsavel_id AND eu.cargo IN ('advogado', 'estagiario'))
        OR
        -- titular enxergando a ficha de um estagiário que supervisiona
        (
          eu.cargo = 'advogado'
          AND EXISTS (
            SELECT 1
            FROM public.advogados est
            WHERE est.id = responsavel_id
              AND est.cargo = 'estagiario'
              AND est.supervisor_id = eu.id
          )
        )
      )
  );
$$;

REVOKE EXECUTE ON FUNCTION public.pode_acessar_ficha(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.pode_acessar_ficha(uuid) TO authenticated;

-- 5.3 advogados: qualquer usuário logado lê a equipe (necessário para o
-- login achar o perfil e para o titular listar seus estagiários).
ALTER TABLE public.advogados ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "equipe lê advogados" ON public.advogados;
CREATE POLICY "equipe lê advogados" ON public.advogados
  FOR SELECT TO authenticated
  USING (true);

-- 5.4 fichas_clientes
ALTER TABLE public.fichas_clientes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "fichas: leitura pela equipe responsável" ON public.fichas_clientes;
CREATE POLICY "fichas: leitura pela equipe responsável" ON public.fichas_clientes
  FOR SELECT TO authenticated
  USING (public.pode_acessar_ficha(advogado_id));

-- USING: só altera fichas que já pode ver.
-- WITH CHECK: o novo responsável também precisa estar no seu alcance. Assim o
-- titular delega apenas para os próprios estagiários e o estagiário não repassa.
DROP POLICY IF EXISTS "fichas: atualização pela equipe responsável" ON public.fichas_clientes;
CREATE POLICY "fichas: atualização pela equipe responsável" ON public.fichas_clientes
  FOR UPDATE TO authenticated
  USING (public.pode_acessar_ficha(advogado_id))
  WITH CHECK (public.pode_acessar_ficha(advogado_id));

-- Sem políticas de INSERT/DELETE: com RLS ativo, ficam bloqueados para
-- anon e authenticated. Apenas service_role (bot/servidor) consegue.

-- 5.5 (RECOMENDADO) conversas_memoria: histórico de WhatsApp, só para o bot.
-- Descomente SOMENTE depois de confirmar que o n8n usa a chave service_role.
-- Se ele usar a chave anon, ativar isto vai parar o bot.
-- ALTER TABLE public.conversas_memoria ENABLE ROW LEVEL SECURITY;


-- =====================================================================
-- 6. AGENDA DE REUNIÕES (agenda_advogados)
-- ---------------------------------------------------------------------
-- Depende da função public.pode_acessar_ficha() criada na seção 5.
-- Pode ser executado mais de uma vez (idempotente). Para aplicar em um
-- banco já criado, rode as seções 5 e 6 juntas no SQL Editor do Supabase.
--
-- Regras (as mesmas de fichas_clientes, via pode_acessar_ficha):
--   * Titular vê, cria, edita e exclui os compromissos dele e os dos
--     estagiários que supervisiona. Pode passar um compromisso para um
--     desses estagiários e pegá-lo de volta.
--   * Estagiário vê, cria, edita e exclui só os próprios compromissos e
--     não pode transferi-los para outra pessoa.
--   * Advogado inativo não vê nada. A chave anon não tem acesso.
-- =====================================================================

-- 6.1 Tabela
CREATE TABLE IF NOT EXISTS public.agenda_advogados (
  id               UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  advogado_id      UUID        NOT NULL REFERENCES public.advogados(id),
  titulo_evento    TEXT        NOT NULL,
  area_juridica    TEXT        NOT NULL,
  prioridade       TEXT        NOT NULL DEFAULT 'media',
  data_hora_inicio TIMESTAMPTZ NOT NULL,
  data_hora_fim    TIMESTAMPTZ,
  status           TEXT        NOT NULL DEFAULT 'agendado',
  created_at       TIMESTAMPTZ DEFAULT now(),

  CONSTRAINT agenda_titulo_nao_vazio CHECK (btrim(titulo_evento) <> ''),
  CONSTRAINT agenda_area_valida CHECK (area_juridica IN (
    'trabalhista', 'empresarial', 'civil', 'cartorario_reurb', 'previdenciario', 'tributario'
  )),
  CONSTRAINT agenda_prioridade_valida CHECK (prioridade IN ('alta', 'media', 'baixa')),
  CONSTRAINT agenda_status_valido CHECK (status IN ('agendado', 'confirmado', 'realizado', 'cancelado')),
  CONSTRAINT agenda_fim_depois_do_inicio CHECK (data_hora_fim IS NULL OR data_hora_fim > data_hora_inicio)
);

-- 6.2 Índice: filtro por responsável + ordenação cronológica
CREATE INDEX IF NOT EXISTS idx_agenda_advogado_inicio
  ON public.agenda_advogados (advogado_id, data_hora_inicio);

-- 6.3 Permissões da API: só usuários logados; o RLS filtra as linhas
REVOKE ALL ON public.agenda_advogados FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.agenda_advogados TO authenticated;

-- 6.4 RLS
ALTER TABLE public.agenda_advogados ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "agenda: leitura pela equipe responsável" ON public.agenda_advogados;
CREATE POLICY "agenda: leitura pela equipe responsável" ON public.agenda_advogados
  FOR SELECT TO authenticated
  USING (public.pode_acessar_ficha(advogado_id));

-- Só cria compromisso para si ou para um estagiário que supervisiona.
DROP POLICY IF EXISTS "agenda: criação pela equipe responsável" ON public.agenda_advogados;
CREATE POLICY "agenda: criação pela equipe responsável" ON public.agenda_advogados
  FOR INSERT TO authenticated
  WITH CHECK (public.pode_acessar_ficha(advogado_id));

-- USING: só edita o que já pode ver.
-- WITH CHECK: o novo responsável também precisa estar no seu alcance.
DROP POLICY IF EXISTS "agenda: atualização pela equipe responsável" ON public.agenda_advogados;
CREATE POLICY "agenda: atualização pela equipe responsável" ON public.agenda_advogados
  FOR UPDATE TO authenticated
  USING (public.pode_acessar_ficha(advogado_id))
  WITH CHECK (public.pode_acessar_ficha(advogado_id));

DROP POLICY IF EXISTS "agenda: exclusão pela equipe responsável" ON public.agenda_advogados;
CREATE POLICY "agenda: exclusão pela equipe responsável" ON public.agenda_advogados
  FOR DELETE TO authenticated
  USING (public.pode_acessar_ficha(advogado_id));


-- =====================================================================
-- 7. FORMULÁRIO DE REUNIÕES + DISPONIBILIDADE DOS ADVOGADOS
-- ---------------------------------------------------------------------
-- Depende das seções 5 e 6. Idempotente: rode as seções 5, 6 e 7 juntas.
-- =====================================================================

-- 7.1 Vínculo opcional da reunião com a ficha do cliente.
-- ON DELETE SET NULL: se a ficha for apagada, a reunião continua na agenda.
ALTER TABLE public.agenda_advogados
  ADD COLUMN IF NOT EXISTS ficha_id UUID REFERENCES public.fichas_clientes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_agenda_ficha_id ON public.agenda_advogados (ficha_id);

-- 7.2 Só dá para vincular uma ficha que o próprio usuário consegue ver.
-- O SELECT abaixo roda com as permissões de quem salva, então o RLS de
-- fichas_clientes vale aqui. A checagem só acontece quando a ficha é
-- definida ou trocada: um estagiário consegue alterar o status de uma
-- reunião que o titular vinculou a uma ficha que ele mesmo não vê.
-- O bot (service_role) ignora o RLS e passa direto.
CREATE OR REPLACE FUNCTION public.agenda_valida_ficha()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.ficha_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.ficha_id IS DISTINCT FROM OLD.ficha_id)
     AND NOT EXISTS (SELECT 1 FROM public.fichas_clientes f WHERE f.id = NEW.ficha_id)
  THEN
    RAISE EXCEPTION 'Ficha vinculada não encontrada ou sem permissão de acesso.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_agenda_valida_ficha ON public.agenda_advogados;
CREATE TRIGGER trg_agenda_valida_ficha
  BEFORE INSERT OR UPDATE ON public.agenda_advogados
  FOR EACH ROW EXECUTE FUNCTION public.agenda_valida_ficha();

-- 7.3 ID do advogado logado (ativo), usado nas regras de "somente o próprio".
CREATE OR REPLACE FUNCTION public.advogado_atual_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT a.id
  FROM public.advogados a
  WHERE lower(a.email) = lower(auth.jwt() ->> 'email')
    AND a.ativo IS TRUE
  LIMIT 1;
$$;

REVOKE EXECUTE ON FUNCTION public.advogado_atual_id() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.advogado_atual_id() TO authenticated;

-- 7.4 Grade de atendimento: uma linha por advogado.
-- Horários sem fuso: representam o horário local do escritório (Brasília).
-- dias_semana usa a numeração do Postgres/JS: 0 = domingo ... 6 = sábado.
CREATE TABLE IF NOT EXISTS public.disponibilidade_advogados (
  advogado_id         UUID        PRIMARY KEY REFERENCES public.advogados(id) ON DELETE CASCADE,
  dias_semana         SMALLINT[]  NOT NULL DEFAULT '{1,2,3,4,5}',
  hora_inicio         TIME        NOT NULL DEFAULT '09:00',
  hora_fim            TIME        NOT NULL DEFAULT '18:00',
  duracao_reuniao_min INTEGER     NOT NULL DEFAULT 60,
  max_reunioes_dia    INTEGER     NOT NULL DEFAULT 6,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT disp_dias_validos   CHECK (dias_semana <@ ARRAY[0,1,2,3,4,5,6]::SMALLINT[]),
  CONSTRAINT disp_horario_valido CHECK (hora_fim > hora_inicio),
  CONSTRAINT disp_duracao_valida CHECK (duracao_reuniao_min BETWEEN 10 AND 480),
  CONSTRAINT disp_max_valido     CHECK (max_reunioes_dia BETWEEN 1 AND 30)
);

REVOKE ALL ON public.disponibilidade_advogados FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.disponibilidade_advogados TO authenticated;

ALTER TABLE public.disponibilidade_advogados ENABLE ROW LEVEL SECURITY;

-- Leitura: a própria grade e a dos estagiários supervisionados (usada nos
-- avisos de conflito ao agendar para eles).
DROP POLICY IF EXISTS "disponibilidade: leitura pela equipe" ON public.disponibilidade_advogados;
CREATE POLICY "disponibilidade: leitura pela equipe" ON public.disponibilidade_advogados
  FOR SELECT TO authenticated
  USING (public.pode_acessar_ficha(advogado_id));

-- Escrita: cada um define somente a própria grade.
DROP POLICY IF EXISTS "disponibilidade: criação pelo próprio" ON public.disponibilidade_advogados;
CREATE POLICY "disponibilidade: criação pelo próprio" ON public.disponibilidade_advogados
  FOR INSERT TO authenticated
  WITH CHECK (advogado_id = (SELECT public.advogado_atual_id()));

DROP POLICY IF EXISTS "disponibilidade: atualização pelo próprio" ON public.disponibilidade_advogados;
CREATE POLICY "disponibilidade: atualização pelo próprio" ON public.disponibilidade_advogados
  FOR UPDATE TO authenticated
  USING (advogado_id = (SELECT public.advogado_atual_id()))
  WITH CHECK (advogado_id = (SELECT public.advogado_atual_id()));

DROP POLICY IF EXISTS "disponibilidade: exclusão pelo próprio" ON public.disponibilidade_advogados;
CREATE POLICY "disponibilidade: exclusão pelo próprio" ON public.disponibilidade_advogados
  FOR DELETE TO authenticated
  USING (advogado_id = (SELECT public.advogado_atual_id()));

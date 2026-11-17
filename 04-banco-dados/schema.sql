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

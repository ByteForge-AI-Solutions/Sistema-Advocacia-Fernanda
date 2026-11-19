-- Dias & Fernandes | CRM v7 — Cadastro do cliente, honorários e repositório de documentos | 2026-11-19
--
-- PRÉ-REQUISITOS (nesta ordem): schema.sql (seções 1–8, NUNCA reexecute inteiro),
-- 20261118_bot_unificado.sql, v3, v4, v5 e 20261118_v6_funil_followup.sql.
-- Incremental e idempotente (pode rodar mais de uma vez).
--
-- O QUE CRIA:
--   1. crm_pode_acessar_ficha_id(): quem enxerga a ficha enxerga cadastro, finanças e arquivos
--      dela (mesma regra de fichas_clientes: pode_acessar_ficha + sem responsável da área).
--   2. clientes_cadastro: dados de qualificação (PF/PJ) para contratos e procurações.
--      Separado da ficha: a fila NUNCA carrega esses dados (LGPD, minimização).
--   3. fin_contratos + fin_parcelas: honorários (diagnóstico, contratuais, êxito), forma de
--      pagamento, parcelas e entradas (PIX etc.). RPC atômica crm_fin_criar_contrato.
--      Pagamento confirmado move o funil: diagnóstico → "Diagnóstico pago";
--      honorários → "Cliente ativo" (documento de leads, seções 2 e 9).
--   4. fichas_documentos + bucket privado "documentos-clientes" (Supabase Storage), com
--      políticas em storage.objects pela mesma regra de acesso. Download só por URL assinada.
--
-- NÃO MUDA: pode_acessar_ficha, políticas existentes, funções dfu_*, triggers do funil.
-- Contas 'desenvolvedor' continuam isoladas (a regra passa por pode_acessar_ficha).
BEGIN;

DO $crm7_preflight$
BEGIN
  IF to_regprocedure('public.crm_fichas_lead()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.fichas_clientes'::regclass
                    AND attname = 'etapa_funil' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'Pré-requisito ausente: aplique 20261118_v6_funil_followup.sql antes.';
  END IF;
  IF to_regprocedure('public.crm_titular_da_area(text)') IS NULL OR to_regprocedure('public.agenda_valida_ficha()') IS NULL THEN
    RAISE EXCEPTION 'Pré-requisito ausente: funções do CRM (schema.sql seção 7) e da v3/v4.';
  END IF;
  IF to_regclass('storage.buckets') IS NULL OR to_regclass('storage.objects') IS NULL THEN
    RAISE EXCEPTION 'Supabase Storage não encontrado (schema storage). Este projeto precisa do Storage habilitado.';
  END IF;
END $crm7_preflight$;


-- =====================================================================
-- 1. ACESSO POR FICHA
-- =====================================================================
CREATE OR REPLACE FUNCTION public.crm_pode_acessar_ficha_id(p_ficha uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.fichas_clientes f
     WHERE f.id = p_ficha
       AND (public.pode_acessar_ficha(f.advogado_id)
            OR (f.advogado_id IS NULL AND public.crm_titular_da_area(f.area_identificada)))
  );
$$;

-- Cargos que podem excluir registros financeiros e arquivos (estagiário não exclui).
CREATE OR REPLACE FUNCTION public.crm_pode_excluir()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.advogados eu
                  WHERE eu.id = public.advogado_atual_id()
                    AND eu.cargo IN ('advogado', 'socio', 'desenvolvedor'));
$$;

REVOKE EXECUTE ON FUNCTION public.crm_pode_acessar_ficha_id(uuid), public.crm_pode_excluir() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.crm_pode_acessar_ficha_id(uuid), public.crm_pode_excluir() TO authenticated;


-- =====================================================================
-- 2. CADASTRO DO CLIENTE (qualificação para contratos e procurações)
-- documento: só dígitos (CPF 11 / CNPJ 14). Nunca entra em listas nem logs.
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.clientes_cadastro (
  ficha_id          uuid PRIMARY KEY REFERENCES public.fichas_clientes(id) ON DELETE CASCADE,
  tipo_pessoa       text NOT NULL DEFAULT 'pf' CHECK (tipo_pessoa IN ('pf', 'pj')),
  nome              text NOT NULL CHECK (btrim(nome) <> '' AND char_length(nome) <= 200),
  documento         text CHECK (documento IS NULL OR documento ~ '^([0-9]{11}|[0-9]{14})$'),
  rg                text CHECK (rg IS NULL OR char_length(rg) <= 40),
  nacionalidade     text CHECK (nacionalidade IS NULL OR char_length(nacionalidade) <= 60),
  estado_civil      text CHECK (estado_civil IS NULL OR char_length(estado_civil) <= 60),
  profissao         text CHECK (profissao IS NULL OR char_length(profissao) <= 120),
  endereco          text CHECK (endereco IS NULL OR char_length(endereco) <= 300),
  email             text CHECK (email IS NULL OR char_length(email) <= 200),
  representante_nome text CHECK (representante_nome IS NULL OR char_length(representante_nome) <= 200),
  representante_cpf  text CHECK (representante_cpf IS NULL OR representante_cpf ~ '^[0-9]{11}$'),
  atualizado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_por    uuid REFERENCES public.advogados(id) DEFAULT public.advogado_atual_id(),
  CONSTRAINT cadastro_documento_tipo CHECK (
    documento IS NULL
    OR (tipo_pessoa = 'pf' AND char_length(documento) = 11)
    OR (tipo_pessoa = 'pj' AND char_length(documento) = 14))
);

CREATE OR REPLACE FUNCTION public.crm_cadastro_carimbo()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  NEW.atualizado_em := now();
  NEW.atualizado_por := coalesce(public.advogado_atual_id(), NEW.atualizado_por);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS crm_cadastro_carimbo ON public.clientes_cadastro;
CREATE TRIGGER crm_cadastro_carimbo BEFORE INSERT OR UPDATE ON public.clientes_cadastro
  FOR EACH ROW EXECUTE FUNCTION public.crm_cadastro_carimbo();

ALTER TABLE public.clientes_cadastro ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.clientes_cadastro FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.clientes_cadastro TO authenticated;

DROP POLICY IF EXISTS "cadastro: leitura pela equipe responsável" ON public.clientes_cadastro;
CREATE POLICY "cadastro: leitura pela equipe responsável" ON public.clientes_cadastro
  FOR SELECT TO authenticated USING (public.crm_pode_acessar_ficha_id(ficha_id));
DROP POLICY IF EXISTS "cadastro: gravação pela equipe responsável" ON public.clientes_cadastro;
CREATE POLICY "cadastro: gravação pela equipe responsável" ON public.clientes_cadastro
  FOR INSERT TO authenticated WITH CHECK (public.crm_pode_acessar_ficha_id(ficha_id));
DROP POLICY IF EXISTS "cadastro: atualização pela equipe responsável" ON public.clientes_cadastro;
CREATE POLICY "cadastro: atualização pela equipe responsável" ON public.clientes_cadastro
  FOR UPDATE TO authenticated
  USING (public.crm_pode_acessar_ficha_id(ficha_id)) WITH CHECK (public.crm_pode_acessar_ficha_id(ficha_id));
DROP POLICY IF EXISTS "cadastro: exclusão por titular" ON public.clientes_cadastro;
CREATE POLICY "cadastro: exclusão por titular" ON public.clientes_cadastro
  FOR DELETE TO authenticated USING (public.crm_pode_acessar_ficha_id(ficha_id) AND public.crm_pode_excluir());


-- =====================================================================
-- 3. REPOSITÓRIO DE DOCUMENTOS
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.fichas_documentos (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- RESTRICT: o arquivo não pode ficar órfão no Storage se a ficha for apagada.
  ficha_id      uuid NOT NULL REFERENCES public.fichas_clientes(id) ON DELETE RESTRICT,
  categoria     text NOT NULL CHECK (categoria IN ('procuracao', 'contrato', 'parecer', 'comprovante',
                                                   'documento_pessoal', 'peticao', 'outro')),
  nome          text NOT NULL CHECK (btrim(nome) <> '' AND char_length(nome) <= 200),
  descricao     text CHECK (descricao IS NULL OR char_length(descricao) <= 500),
  caminho       text NOT NULL UNIQUE,
  tamanho_bytes bigint NOT NULL CHECK (tamanho_bytes > 0 AND tamanho_bytes <= 20971520),
  tipo_mime     text NOT NULL,
  enviado_por   uuid NOT NULL REFERENCES public.advogados(id) DEFAULT public.advogado_atual_id(),
  criado_em     timestamptz NOT NULL DEFAULT now(),
  -- O caminho no bucket começa pelo id da ficha: é isso que o RLS do Storage confere.
  CONSTRAINT documentos_caminho_da_ficha CHECK (split_part(caminho, '/', 1) = ficha_id::text)
);
CREATE INDEX IF NOT EXISTS fichas_documentos_ficha ON public.fichas_documentos (ficha_id, criado_em DESC);

ALTER TABLE public.fichas_documentos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fichas_documentos FROM PUBLIC, anon;
GRANT SELECT, INSERT, DELETE ON public.fichas_documentos TO authenticated;   -- sem UPDATE: histórico

DROP POLICY IF EXISTS "documentos: leitura pela equipe responsável" ON public.fichas_documentos;
CREATE POLICY "documentos: leitura pela equipe responsável" ON public.fichas_documentos
  FOR SELECT TO authenticated USING (public.crm_pode_acessar_ficha_id(ficha_id));
DROP POLICY IF EXISTS "documentos: envio pela equipe responsável" ON public.fichas_documentos;
CREATE POLICY "documentos: envio pela equipe responsável" ON public.fichas_documentos
  FOR INSERT TO authenticated
  WITH CHECK (public.crm_pode_acessar_ficha_id(ficha_id) AND enviado_por = (SELECT public.advogado_atual_id()));
DROP POLICY IF EXISTS "documentos: exclusão por titular" ON public.fichas_documentos;
CREATE POLICY "documentos: exclusão por titular" ON public.fichas_documentos
  FOR DELETE TO authenticated USING (public.crm_pode_acessar_ficha_id(ficha_id) AND public.crm_pode_excluir());

-- 3.1 Bucket privado (sem URL pública; arquivos só por URL assinada de curta duração).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('documentos-clientes', 'documentos-clientes', false, 20971520, ARRAY[
  'application/pdf', 'image/jpeg', 'image/png', 'image/webp',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
ON CONFLICT (id) DO UPDATE
  SET public = false, file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types;

-- 3.2 Acesso a um objeto do bucket pelo 1º segmento do caminho (id da ficha).
CREATE OR REPLACE FUNCTION public.crm_pode_acessar_objeto(p_nome text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v text := split_part(coalesce(p_nome, ''), '/', 1);
BEGIN
  IF v !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;
  RETURN public.crm_pode_acessar_ficha_id(v::uuid);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.crm_pode_acessar_objeto(text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.crm_pode_acessar_objeto(text) TO authenticated;

DROP POLICY IF EXISTS "crm documentos: leitura" ON storage.objects;
CREATE POLICY "crm documentos: leitura" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'documentos-clientes' AND public.crm_pode_acessar_objeto(name));
DROP POLICY IF EXISTS "crm documentos: envio" ON storage.objects;
CREATE POLICY "crm documentos: envio" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'documentos-clientes' AND public.crm_pode_acessar_objeto(name));
DROP POLICY IF EXISTS "crm documentos: exclusão" ON storage.objects;
CREATE POLICY "crm documentos: exclusão" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'documentos-clientes' AND public.crm_pode_acessar_objeto(name) AND public.crm_pode_excluir());
-- Sem política de UPDATE: arquivo enviado não é sobrescrito (envie uma nova versão).


-- =====================================================================
-- 4. HONORÁRIOS: contratos e parcelas
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.fin_contratos (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- RESTRICT: histórico financeiro não some junto com a ficha.
  ficha_id          uuid NOT NULL REFERENCES public.fichas_clientes(id) ON DELETE RESTRICT,
  advogado_id       uuid NOT NULL REFERENCES public.advogados(id),
  tipo              text NOT NULL CHECK (tipo IN ('diagnostico', 'honorarios', 'exito', 'outro')),
  descricao         text NOT NULL CHECK (btrim(descricao) <> '' AND char_length(descricao) <= 300),
  valor_total       numeric(14,2) CHECK (valor_total IS NULL OR valor_total > 0),
  forma_pagamento   text NOT NULL DEFAULT 'a_vista' CHECK (forma_pagamento IN ('a_vista', 'parcelado')),
  percentual_exito  numeric(5,2) CHECK (percentual_exito IS NULL OR (percentual_exito > 0 AND percentual_exito <= 100)),
  cancelado         boolean NOT NULL DEFAULT false,
  observacoes       text CHECK (observacoes IS NULL OR char_length(observacoes) <= 500),
  criado_por        uuid REFERENCES public.advogados(id) DEFAULT public.advogado_atual_id(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- Êxito pode não ter valor fechado (só percentual); os demais exigem valor.
  CONSTRAINT fin_contrato_valor CHECK (tipo = 'exito' OR valor_total IS NOT NULL),
  CONSTRAINT fin_contrato_exito CHECK (tipo <> 'exito' OR percentual_exito IS NOT NULL OR valor_total IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS fin_contratos_ficha ON public.fin_contratos (ficha_id);
CREATE INDEX IF NOT EXISTS fin_contratos_advogado ON public.fin_contratos (advogado_id);

-- Só vincula ficha que o usuário consegue ver (mesma regra da agenda e dos prazos).
DROP TRIGGER IF EXISTS crm_fin_valida_ficha ON public.fin_contratos;
CREATE TRIGGER crm_fin_valida_ficha BEFORE INSERT OR UPDATE ON public.fin_contratos
  FOR EACH ROW EXECUTE FUNCTION public.agenda_valida_ficha();

CREATE TABLE IF NOT EXISTS public.fin_parcelas (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contrato_id    uuid NOT NULL REFERENCES public.fin_contratos(id) ON DELETE CASCADE,
  numero         integer NOT NULL CHECK (numero BETWEEN 1 AND 240),
  valor          numeric(14,2) NOT NULL CHECK (valor > 0),
  vencimento     date NOT NULL,
  pago_em        date,
  valor_pago     numeric(14,2) CHECK (valor_pago IS NULL OR valor_pago > 0),
  meio           text CHECK (meio IS NULL OR meio IN ('pix', 'boleto', 'transferencia', 'dinheiro', 'cartao', 'outro')),
  comprovante_id uuid REFERENCES public.fichas_documentos(id) ON DELETE SET NULL,
  observacao     text CHECK (observacao IS NULL OR char_length(observacao) <= 300),
  registrado_por uuid REFERENCES public.advogados(id),
  registrado_em  timestamptz,
  UNIQUE (contrato_id, numero),
  -- Pagamento é registrado por inteiro: data, valor e meio juntos (ou nenhum).
  CONSTRAINT fin_parcela_pagamento CHECK (
    (pago_em IS NULL AND valor_pago IS NULL AND meio IS NULL)
    OR (pago_em IS NOT NULL AND valor_pago IS NOT NULL AND meio IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS fin_parcelas_vencimento ON public.fin_parcelas (vencimento) WHERE pago_em IS NULL;

ALTER TABLE public.fin_contratos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fin_parcelas ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fin_contratos, public.fin_parcelas FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.fin_contratos, public.fin_parcelas TO authenticated;

DROP POLICY IF EXISTS "fin contratos: leitura" ON public.fin_contratos;
CREATE POLICY "fin contratos: leitura" ON public.fin_contratos
  FOR SELECT TO authenticated USING (public.pode_acessar_ficha(advogado_id));
DROP POLICY IF EXISTS "fin contratos: criação" ON public.fin_contratos;
CREATE POLICY "fin contratos: criação" ON public.fin_contratos
  FOR INSERT TO authenticated WITH CHECK (public.pode_acessar_ficha(advogado_id));
DROP POLICY IF EXISTS "fin contratos: atualização" ON public.fin_contratos;
CREATE POLICY "fin contratos: atualização" ON public.fin_contratos
  FOR UPDATE TO authenticated USING (public.pode_acessar_ficha(advogado_id)) WITH CHECK (public.pode_acessar_ficha(advogado_id));
DROP POLICY IF EXISTS "fin contratos: exclusão por titular" ON public.fin_contratos;
CREATE POLICY "fin contratos: exclusão por titular" ON public.fin_contratos
  FOR DELETE TO authenticated USING (public.pode_acessar_ficha(advogado_id) AND public.crm_pode_excluir());

DROP POLICY IF EXISTS "fin parcelas: leitura" ON public.fin_parcelas;
CREATE POLICY "fin parcelas: leitura" ON public.fin_parcelas
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.fin_contratos c WHERE c.id = fin_parcelas.contrato_id AND public.pode_acessar_ficha(c.advogado_id)));
DROP POLICY IF EXISTS "fin parcelas: criação" ON public.fin_parcelas;
CREATE POLICY "fin parcelas: criação" ON public.fin_parcelas
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.fin_contratos c WHERE c.id = fin_parcelas.contrato_id AND public.pode_acessar_ficha(c.advogado_id)));
DROP POLICY IF EXISTS "fin parcelas: atualização" ON public.fin_parcelas;
CREATE POLICY "fin parcelas: atualização" ON public.fin_parcelas
  FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.fin_contratos c WHERE c.id = fin_parcelas.contrato_id AND public.pode_acessar_ficha(c.advogado_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.fin_contratos c WHERE c.id = fin_parcelas.contrato_id AND public.pode_acessar_ficha(c.advogado_id)));
DROP POLICY IF EXISTS "fin parcelas: exclusão por titular" ON public.fin_parcelas;
CREATE POLICY "fin parcelas: exclusão por titular" ON public.fin_parcelas
  FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.fin_contratos c WHERE c.id = fin_parcelas.contrato_id AND public.pode_acessar_ficha(c.advogado_id))
         AND public.crm_pode_excluir());

-- 4.1 Comprovante só da MESMA ficha do contrato; carimbo de quem registrou o pagamento.
CREATE OR REPLACE FUNCTION public.crm_fin_parcela_valida()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
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
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS crm_fin_parcela_valida ON public.fin_parcelas;
CREATE TRIGGER crm_fin_parcela_valida BEFORE INSERT OR UPDATE ON public.fin_parcelas
  FOR EACH ROW EXECUTE FUNCTION public.crm_fin_parcela_valida();

-- 4.2 Pagamento confirmado move o funil (documento de leads: "PIX confirma o pagamento e
-- move para Diagnóstico pago"; "Cliente ativo: contrato assinado e 1ª parcela paga").
-- SECURITY DEFINER: a mudança de etapa é do sistema, então define também a próxima ação
-- (a regra de ouro continua valendo para edições feitas na tela). Só AVANÇA, nunca recua.
CREATE OR REPLACE FUNCTION public.crm_fin_avancar_funil()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.fin_contratos%ROWTYPE; v_etapa text; v_nova text; v_acao text;
BEGIN
  IF NEW.pago_em IS NULL OR (TG_OP = 'UPDATE' AND OLD.pago_em IS NOT NULL) THEN
    RETURN NULL;
  END IF;
  SELECT * INTO c FROM public.fin_contratos WHERE id = NEW.contrato_id;
  IF NOT FOUND OR c.cancelado THEN RETURN NULL; END IF;
  SELECT etapa_funil INTO v_etapa FROM public.fichas_clientes WHERE id = c.ficha_id;

  IF c.tipo = 'diagnostico'
     AND v_etapa IN ('novo_lead', 'primeiro_contato', 'em_conversa', 'horario_confirmado',
                     'diagnostico_ofertado', 'sem_resposta') THEN
    v_nova := 'diagnostico_pago';
    v_acao := 'Cadastrar a procuração (e-CAC/sistemas) e iniciar a análise';
  ELSIF c.tipo IN ('honorarios', 'exito')
     AND v_etapa IN ('novo_lead', 'primeiro_contato', 'em_conversa', 'horario_confirmado',
                     'diagnostico_ofertado', 'diagnostico_pago', 'em_analise', 'proposta', 'sem_resposta') THEN
    v_nova := 'cliente_ativo';
    v_acao := 'Boas-vindas ao cliente e próximos passos do caso';
  END IF;

  IF v_nova IS NOT NULL THEN
    UPDATE public.fichas_clientes
       SET etapa_funil = v_nova, proxima_acao = v_acao, proxima_acao_em = now() + interval '1 day'
     WHERE id = c.ficha_id;
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS crm_fin_avancar_funil ON public.fin_parcelas;
CREATE TRIGGER crm_fin_avancar_funil AFTER INSERT OR UPDATE OF pago_em ON public.fin_parcelas
  FOR EACH ROW EXECUTE FUNCTION public.crm_fin_avancar_funil();

-- 4.3 Criação atômica do contrato com as parcelas (SECURITY INVOKER: RLS vale normalmente).
-- p_parcelas: [{"numero":1,"valor":1500.00,"vencimento":"2026-12-10"}, ...]
-- A soma das parcelas precisa bater com o valor total (centavo a centavo).
CREATE OR REPLACE FUNCTION public.crm_fin_criar_contrato(
  p_ficha uuid, p_advogado uuid, p_tipo text, p_descricao text, p_valor_total numeric,
  p_forma text, p_percentual numeric, p_observacoes text, p_parcelas jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE v_id uuid; v_soma numeric; v_qtd int;
BEGIN
  SELECT coalesce(sum((x->>'valor')::numeric), 0), count(*) INTO v_soma, v_qtd
    FROM jsonb_array_elements(coalesce(p_parcelas, '[]'::jsonb)) x;
  IF p_valor_total IS NOT NULL AND v_qtd > 0 AND v_soma <> p_valor_total THEN
    RAISE EXCEPTION 'A soma das parcelas (%) difere do valor total (%).', v_soma, p_valor_total
      USING ERRCODE = '23514', HINT = 'crm_parcelas_soma';
  END IF;
  IF p_tipo <> 'exito' AND v_qtd = 0 THEN
    RAISE EXCEPTION 'Informe ao menos uma parcela.' USING ERRCODE = '23514', HINT = 'crm_parcelas_soma';
  END IF;
  IF p_forma = 'a_vista' AND v_qtd > 1 THEN
    RAISE EXCEPTION 'Pagamento à vista tem uma única parcela.' USING ERRCODE = '23514', HINT = 'crm_parcelas_soma';
  END IF;

  INSERT INTO public.fin_contratos (ficha_id, advogado_id, tipo, descricao, valor_total, forma_pagamento,
                                    percentual_exito, observacoes)
  VALUES (p_ficha, p_advogado, p_tipo, btrim(p_descricao), p_valor_total, p_forma, p_percentual,
          nullif(btrim(coalesce(p_observacoes, '')), ''))
  RETURNING id INTO v_id;

  INSERT INTO public.fin_parcelas (contrato_id, numero, valor, vencimento)
  SELECT v_id, (x->>'numero')::int, (x->>'valor')::numeric, (x->>'vencimento')::date
    FROM jsonb_array_elements(coalesce(p_parcelas, '[]'::jsonb)) x;
  RETURN v_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.crm_fin_criar_contrato(uuid, uuid, text, text, numeric, text, numeric, text, jsonb) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.crm_fin_criar_contrato(uuid, uuid, text, text, numeric, text, numeric, text, jsonb) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;

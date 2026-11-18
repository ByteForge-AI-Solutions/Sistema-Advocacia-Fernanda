-- PATCH PARA QUEM JA APLICOU A MIGRACAO V2.0 EM BANCO EXISTENTE.
-- Se esta e sua primeira instalacao, NAO rode este arquivo; use apenas
-- 20261118_bot_unificado.sql, cuja funcao ja inclui a correcao.
-- Nao modifica dados; atualiza apenas a funcao do trigger existente.
BEGIN;
DO $v21check$ BEGIN
 IF to_regprocedure('public.dfu_proteger_agenda()') IS NULL
    OR to_regclass('public.dfu_atendimentos') IS NULL THEN
  RAISE EXCEPTION 'V2.0 nao encontrada. Nao aplique este patch; instale a migracao principal v2.1.';
 END IF;
END $v21check$;
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
COMMIT;

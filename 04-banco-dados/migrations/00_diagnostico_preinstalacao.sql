-- DIAGNOSTICO DE INSTALACAO (SOMENTE LEITURA)
-- Execute no SQL Editor do Supabase do ambiente de HOMOLOGACAO.
-- Nenhuma instrucao desta consulta escreve ou corrige dados.
-- Caso alguma tabela da relacao de prerequisitos esteja ausente, pare antes
-- dos blocos seguintes e compare a estrutura do CRM existente.

-- 1) Confirme estruturas do CRM sem executar schema.sql novamente.
SELECT nome, to_regclass('public.'||nome) AS existe
FROM (VALUES ('advogados'), ('fichas_clientes'), ('agenda_advogados'),
             ('disponibilidade_advogados'), ('conversas_memoria')) AS t(nome);
SELECT to_regprocedure('public.pode_acessar_ficha(uuid)') AS politica_necessaria;

-- 2) Estatisticas dos compromissos que merecem revisao manual.
SELECT
 COUNT(*) AS total_agenda,
 COUNT(*) FILTER (WHERE status IN ('agendado','confirmado')) AS compromissos_ativos,
 COUNT(*) FILTER (WHERE status IN ('agendado','confirmado') AND data_hora_fim IS NULL) AS ativos_sem_fim,
 COUNT(*) FILTER (WHERE status IN ('agendado','confirmado') AND data_hora_fim IS NULL
                  AND data_hora_inicio >= now()) AS futuros_ativos_sem_fim
FROM public.agenda_advogados;

-- 3) Conflitos ativos PREEXISTENTES por advogado, incluindo horarios sem fim.
-- Retorna somente UUIDs/horarios, nao nomes nem dados de clientes.
SELECT a.advogado_id, a.id AS reuniao_a, b.id AS reuniao_b,
       a.data_hora_inicio AS inicio_a, a.data_hora_fim AS fim_a,
       b.data_hora_inicio AS inicio_b, b.data_hora_fim AS fim_b
FROM public.agenda_advogados a
JOIN public.agenda_advogados b
 ON b.advogado_id = a.advogado_id AND b.id > a.id
 AND b.status IN ('agendado','confirmado')
WHERE a.status IN ('agendado','confirmado')
  AND a.data_hora_inicio < coalesce(b.data_hora_fim,b.data_hora_inicio+interval '60 minutes')
  AND b.data_hora_inicio < coalesce(a.data_hora_fim,a.data_hora_inicio+interval '60 minutes')
ORDER BY a.data_hora_inicio DESC LIMIT 100;

-- 4) Dias repetidos de disponibilidade (potencial ambiguidade da grade).
SELECT advogado_id, dia_semana, count(*) AS qtd_linhas
FROM public.disponibilidade_advogados
GROUP BY advogado_id,dia_semana HAVING count(*) > 1
ORDER BY qtd_linhas DESC,advogado_id,dia_semana;

-- 5) Grade com parametros inadequados para o agendamento do bot.
SELECT id, advogado_id, dia_semana, hora_inicio,hora_fim,
       duracao_reuniao_min,max_reunioes_dia
FROM public.disponibilidade_advogados
WHERE ativo IS TRUE AND (hora_inicio >= hora_fim
   OR duracao_reuniao_min IS NULL OR duracao_reuniao_min NOT BETWEEN 10 AND 480
   OR max_reunioes_dia IS NULL OR max_reunioes_dia < 1)
ORDER BY advogado_id,dia_semana;

-- Nao altere registros automaticamente. Corrija manualmente em homologacao,
-- confirme os compromissos com a equipe e repita o diagnostico.

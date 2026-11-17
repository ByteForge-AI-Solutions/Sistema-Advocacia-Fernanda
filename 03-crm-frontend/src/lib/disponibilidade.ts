import type { PostgrestError } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase/client";

/**
 * Modelo da tabela `disponibilidade_advogados` (como existe no Supabase):
 * UMA LINHA POR ADVOGADO POR DIA DA SEMANA, com `ativo` indicando se atende naquele dia.
 * dia_semana: 0 = domingo ... 6 = sábado (igual a Date#getDay e EXTRACT(DOW)).
 */
export const DIAS_SEMANA = [
  { valor: 1, curto: "Seg", longo: "segunda-feira" },
  { valor: 2, curto: "Ter", longo: "terça-feira" },
  { valor: 3, curto: "Qua", longo: "quarta-feira" },
  { valor: 4, curto: "Qui", longo: "quinta-feira" },
  { valor: 5, curto: "Sex", longo: "sexta-feira" },
  { valor: 6, curto: "Sáb", longo: "sábado" },
  { valor: 0, curto: "Dom", longo: "domingo" },
] as const;

export const DURACOES_REUNIAO = [15, 20, 30, 45, 60, 90, 120] as const;
export const LIMITE_MAX_REUNIOES = 30;

/** Linha da tabela, exatamente como vem do banco. */
export interface DisponibilidadeRow {
  id: string;
  advogado_id: string;
  dia_semana: number;
  /** "HH:MM:SS" */
  hora_inicio: string | null;
  hora_fim: string | null;
  duracao_reuniao_min: number | null;
  max_reunioes_dia: number | null;
  ativo: boolean | null;
}

/** Janela de atendimento de um dia ("HH:MM"). */
export interface HorarioDia {
  dia_semana: number;
  hora_inicio: string;
  hora_fim: string;
}

/** Grade consolidada de um advogado (usada nos avisos do formulário de reunião). */
export interface DisponibilidadeAdvogado {
  advogado_id: string;
  /** Apenas os dias ativos, em ordem. */
  dias: HorarioDia[];
  duracao_reuniao_min: number;
  max_reunioes_dia: number;
  /** Linhas originais (ids necessários para atualizar sem duplicar). */
  linhas: DisponibilidadeRow[];
}

/** Estado do formulário. NaN = campo numérico ainda não preenchido. */
export interface GradeDisponibilidade {
  dias: HorarioDia[];
  duracao_reuniao_min: number;
  max_reunioes_dia: number;
}

export const GRADE_VAZIA: GradeDisponibilidade = { dias: [], duracao_reuniao_min: NaN, max_reunioes_dia: NaN };

export const GRADE_SUGERIDA: GradeDisponibilidade = {
  dias: [1, 2, 3, 4, 5].map((d) => ({ dia_semana: d, hora_inicio: "09:00", hora_fim: "18:00" })),
  duracao_reuniao_min: 60,
  max_reunioes_dia: 6,
};

const COLUNAS = "id, advogado_id, dia_semana, hora_inicio, hora_fim, duracao_reuniao_min, max_reunioes_dia, ativo";

export class ErroDisponibilidade extends Error {
  constructor(
    message: string,
    readonly tabelaAusente: boolean,
    /** Código e mensagem do banco, para diagnóstico na tela. */
    readonly detalhe: string,
  ) {
    super(message);
    this.name = "ErroDisponibilidade";
  }
}

function detalheDoErro(error: PostgrestError) {
  return `${error.code}: ${error.message}`;
}

const hhmm = (t: string | null) => (t ?? "").slice(0, 5);

function consolidar(advogadoId: string, linhas: DisponibilidadeRow[]): DisponibilidadeAdvogado {
  const ordenadas = [...linhas].sort((a, b) => a.dia_semana - b.dia_semana);
  // Se houver linha duplicada para o mesmo dia, vale a primeira ativa.
  const ativas = new Map<number, DisponibilidadeRow>();
  for (const l of ordenadas) if (l.ativo !== false && !ativas.has(l.dia_semana)) ativas.set(l.dia_semana, l);
  const referencia = [...ativas.values()][0] ?? ordenadas[0];

  return {
    advogado_id: advogadoId,
    dias: [...ativas.values()].map((l) => ({
      dia_semana: l.dia_semana,
      hora_inicio: hhmm(l.hora_inicio),
      hora_fim: hhmm(l.hora_fim),
    })),
    duracao_reuniao_min: referencia?.duracao_reuniao_min ?? NaN,
    max_reunioes_dia: referencia?.max_reunioes_dia ?? NaN,
    linhas,
  };
}

/** Grades dos advogados informados (o RLS só devolve a própria e a dos estagiários supervisionados). */
export async function buscarDisponibilidades(ids: string[]): Promise<Map<string, DisponibilidadeAdvogado>> {
  const { data, error } = await supabase
    .from("disponibilidade_advogados")
    .select(COLUNAS)
    .in("advogado_id", ids)
    .overrideTypes<DisponibilidadeRow[], { merge: false }>();

  if (error) {
    throw new ErroDisponibilidade(
      error.message,
      error.code === "PGRST205" || error.code === "42P01",
      detalheDoErro(error),
    );
  }

  const porAdvogado = new Map<string, DisponibilidadeRow[]>();
  for (const l of data ?? []) porAdvogado.set(l.advogado_id, [...(porAdvogado.get(l.advogado_id) ?? []), l]);
  return new Map([...porAdvogado].map(([id, linhas]) => [id, consolidar(id, linhas)]));
}

/** Grade do próprio advogado; null quando ainda não há nenhuma linha cadastrada. */
export async function buscarMinhaDisponibilidade(advogadoId: string): Promise<DisponibilidadeAdvogado | null> {
  const mapa = await buscarDisponibilidades([advogadoId]);
  return mapa.get(advogadoId) ?? null;
}

/** Problemas de preenchimento (vazio = válido). */
export function validarGrade(g: GradeDisponibilidade): string[] {
  const erros: string[] = [];
  if (g.dias.length === 0) erros.push("Selecione pelo menos um dia de atendimento.");
  for (const d of g.dias) {
    const nome = nomeDia(d.dia_semana);
    if (!d.hora_inicio || !d.hora_fim) erros.push(`Informe o horário de início e de término de ${nome}.`);
    else if (d.hora_fim <= d.hora_inicio) erros.push(`Em ${nome}, o término precisa ser depois do início.`);
  }
  if (!Number.isInteger(g.duracao_reuniao_min) || g.duracao_reuniao_min < 10 || g.duracao_reuniao_min > 480) {
    erros.push("Escolha a duração padrão da reunião.");
  }
  if (!Number.isInteger(g.max_reunioes_dia) || g.max_reunioes_dia < 1 || g.max_reunioes_dia > LIMITE_MAX_REUNIOES) {
    erros.push(`Informe o máximo de reuniões por dia (entre 1 e ${LIMITE_MAX_REUNIOES}).`);
  }
  return erros;
}

/**
 * Salva a grade do advogado logado em uma única operação (upsert por id):
 * - dia marcado: atualiza a linha existente do dia (ou cria uma nova) com ativo = true;
 * - dia desmarcado que já tinha linha: mantém a linha com ativo = false (não apaga histórico);
 * - linhas duplicadas do mesmo dia: ficam inativas.
 * Devolve a grade como ficou no banco.
 */
export async function salvarMinhaDisponibilidade(
  advogadoId: string,
  g: GradeDisponibilidade,
  linhasExistentes: DisponibilidadeRow[],
): Promise<DisponibilidadeAdvogado> {
  const porDia = new Map<number, DisponibilidadeRow[]>();
  for (const l of linhasExistentes) porDia.set(l.dia_semana, [...(porDia.get(l.dia_semana) ?? []), l]);

  const linhas: DisponibilidadeRow[] = [];
  for (const { valor: dia } of DIAS_SEMANA) {
    const marcado = g.dias.find((d) => d.dia_semana === dia);
    const existentes = porDia.get(dia) ?? [];
    const comum = {
      advogado_id: advogadoId,
      dia_semana: dia,
      duracao_reuniao_min: g.duracao_reuniao_min,
      max_reunioes_dia: g.max_reunioes_dia,
    };

    existentes.forEach((l, i) => {
      linhas.push({
        ...comum,
        id: l.id,
        hora_inicio: marcado ? marcado.hora_inicio : l.hora_inicio,
        hora_fim: marcado ? marcado.hora_fim : l.hora_fim,
        ativo: Boolean(marcado) && i === 0,
      });
    });

    if (marcado && existentes.length === 0) {
      linhas.push({ ...comum, id: crypto.randomUUID(), hora_inicio: marcado.hora_inicio, hora_fim: marcado.hora_fim, ativo: true });
    }
  }

  const { data, error } = await supabase
    .from("disponibilidade_advogados")
    .upsert(linhas, { onConflict: "id" })
    .select(COLUNAS)
    .overrideTypes<DisponibilidadeRow[], { merge: false }>();

  if (error) {
    console.error("Erro ao salvar disponibilidade:", error.code, error.message);
    const detalhe = ` (${detalheDoErro(error)})`;
    if (error.code === "PGRST205" || error.code === "42P01") {
      throw new Error("A tabela disponibilidade_advogados não foi encontrada no Supabase." + detalhe);
    }
    if (error.code === "42501") {
      throw new Error(
        "Sem permissão para salvar. Confira se as políticas RLS da seção 7 do schema.sql foram aplicadas." + detalhe,
      );
    }
    if (error.code === "23514") throw new Error("Algum valor está fora do permitido pelo banco." + detalhe);
    if (error.code === "42P10") {
      throw new Error("A coluna id da tabela precisa ser chave primária para salvar." + detalhe);
    }
    throw new Error("Não foi possível salvar. Verifique sua conexão e tente novamente." + detalhe);
  }

  const todas = [
    ...linhasExistentes.filter((l) => !(data ?? []).some((d) => d.id === l.id)),
    ...(data ?? []),
  ];
  return consolidar(advogadoId, todas);
}

// ---------- utilitários de horário ----------

/** "HH:MM" → minutos desde 00:00 (NaN se vazio). */
export function paraMinutos(hhmm: string): number {
  if (!hhmm) return NaN;
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** Quantas reuniões da duração informada cabem na janela de um dia. */
export function capacidadeDoDia(dia: HorarioDia, duracaoMin: number): number {
  const janela = paraMinutos(dia.hora_fim) - paraMinutos(dia.hora_inicio);
  return janela > 0 && duracaoMin > 0 ? Math.floor(janela / duracaoMin) : 0;
}

export function nomeDia(dia: number): string {
  return DIAS_SEMANA.find((d) => d.valor === dia)?.longo ?? "";
}

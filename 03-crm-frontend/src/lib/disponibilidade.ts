import type { PostgrestError } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase/client";

/** Numeração do Postgres e do JS (Date#getDay): 0 = domingo ... 6 = sábado. */
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

/** Linha da tabela `disponibilidade_advogados` (seção 7 do schema.sql). */
export interface DisponibilidadeAdvogado {
  advogado_id: string;
  dias_semana: number[];
  /** "HH:MM" (o banco devolve "HH:MM:SS"; normalizamos ao ler). */
  hora_inicio: string;
  hora_fim: string;
  duracao_reuniao_min: number;
  max_reunioes_dia: number;
}

export type GradeDisponibilidade = Omit<DisponibilidadeAdvogado, "advogado_id">;

export const GRADE_PADRAO: GradeDisponibilidade = {
  dias_semana: [1, 2, 3, 4, 5],
  hora_inicio: "09:00",
  hora_fim: "18:00",
  duracao_reuniao_min: 60,
  max_reunioes_dia: 6,
};

const COLUNAS = "advogado_id, dias_semana, hora_inicio, hora_fim, duracao_reuniao_min, max_reunioes_dia";

export class ErroDisponibilidade extends Error {
  constructor(
    message: string,
    readonly tabelaAusente: boolean,
  ) {
    super(message);
    this.name = "ErroDisponibilidade";
  }
}

function tabelaAusente(error: PostgrestError) {
  return error.code === "PGRST205" || error.code === "42P01";
}

function normalizarLinha(row: DisponibilidadeAdvogado): DisponibilidadeAdvogado {
  return {
    ...row,
    dias_semana: [...(row.dias_semana ?? [])].sort((a, b) => a - b),
    hora_inicio: row.hora_inicio.slice(0, 5),
    hora_fim: row.hora_fim.slice(0, 5),
  };
}

/** Grades dos advogados informados (o RLS só devolve a própria e a dos estagiários supervisionados). */
export async function buscarDisponibilidades(ids: string[]): Promise<Map<string, DisponibilidadeAdvogado>> {
  const { data, error } = await supabase
    .from("disponibilidade_advogados")
    .select(COLUNAS)
    .in("advogado_id", ids)
    .overrideTypes<DisponibilidadeAdvogado[], { merge: false }>();

  if (error) throw new ErroDisponibilidade(error.message, tabelaAusente(error));
  return new Map((data ?? []).map((d) => [d.advogado_id, normalizarLinha(d)]));
}

/** Grade do próprio advogado; null se ainda não configurou. */
export async function buscarMinhaDisponibilidade(advogadoId: string): Promise<DisponibilidadeAdvogado | null> {
  const mapa = await buscarDisponibilidades([advogadoId]);
  return mapa.get(advogadoId) ?? null;
}

/** Problemas de preenchimento (vazio = válido). Espelha os CHECKs do banco. */
export function validarGrade(g: GradeDisponibilidade): string[] {
  const erros: string[] = [];
  if (g.dias_semana.length === 0) erros.push("Selecione pelo menos um dia de atendimento.");
  if (!g.hora_inicio || !g.hora_fim) erros.push("Informe o horário de início e de término.");
  else if (g.hora_fim <= g.hora_inicio) erros.push("O horário de término precisa ser depois do início.");
  if (!Number.isInteger(g.duracao_reuniao_min) || g.duracao_reuniao_min < 10 || g.duracao_reuniao_min > 480) {
    erros.push("A duração da reunião deve ficar entre 10 e 480 minutos.");
  }
  if (!Number.isInteger(g.max_reunioes_dia) || g.max_reunioes_dia < 1 || g.max_reunioes_dia > LIMITE_MAX_REUNIOES) {
    erros.push(`O limite diário deve ficar entre 1 e ${LIMITE_MAX_REUNIOES} reuniões.`);
  }
  return erros;
}

/** Salva (cria ou atualiza) a grade do advogado logado. Lança Error com mensagem pronta. */
export async function salvarMinhaDisponibilidade(advogadoId: string, g: GradeDisponibilidade): Promise<void> {
  const { error } = await supabase
    .from("disponibilidade_advogados")
    .upsert(
      {
        advogado_id: advogadoId,
        dias_semana: [...g.dias_semana].sort((a, b) => a - b),
        hora_inicio: g.hora_inicio,
        hora_fim: g.hora_fim,
        duracao_reuniao_min: g.duracao_reuniao_min,
        max_reunioes_dia: g.max_reunioes_dia,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "advogado_id" },
    )
    .select("advogado_id")
    .single();

  if (error) {
    console.error("Erro ao salvar disponibilidade:", error.code, error.message);
    if (tabelaAusente(error)) {
      throw new Error("A tabela disponibilidade_advogados ainda não existe. Rode a seção 7 do schema.sql.");
    }
    if (error.code === "42501") throw new Error("Você só pode alterar a sua própria disponibilidade.");
    if (error.code === "23514") throw new Error("Algum valor está fora do permitido. Revise os campos.");
    throw new Error("Não foi possível salvar. Verifique sua conexão e tente novamente.");
  }
}

// ---------- utilitários de horário ----------

/** "HH:MM" → minutos desde 00:00. */
export function paraMinutos(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** Quantas reuniões da duração padrão cabem na janela diária. */
export function capacidadeDiaria(g: GradeDisponibilidade): number {
  const janela = paraMinutos(g.hora_fim) - paraMinutos(g.hora_inicio);
  return janela > 0 && g.duracao_reuniao_min > 0 ? Math.floor(janela / g.duracao_reuniao_min) : 0;
}

export function nomeDia(dia: number): string {
  return DIAS_SEMANA.find((d) => d.valor === dia)?.longo ?? "";
}

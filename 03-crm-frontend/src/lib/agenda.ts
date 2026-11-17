import { supabase } from "@/lib/supabase/client";
import { buscarEstagiariosSupervisionados, type Advogado, type MembroEquipe } from "@/lib/advogados";
import { normalizar } from "@/lib/fichas";

/** Linha da tabela `agenda_advogados` (seção 6 do schema.sql), como vem do Supabase. */
export interface AgendaAdvogado {
  id: string;
  /** Responsável pelo compromisso (FK → advogados.id). Base do RLS. */
  advogado_id: string;
  titulo_evento: string;
  /** Uma das 6 áreas canônicas (CHECK no banco); exibida com AREAS_JURIDICAS. */
  area_juridica: string;
  /** 'alta' | 'media' | 'baixa' (CHECK no banco). */
  prioridade: string;
  /** ISO 8601 (TIMESTAMPTZ). */
  data_hora_inicio: string;
  /** ISO 8601 (TIMESTAMPTZ). Nulo quando o compromisso não tem horário de término. */
  data_hora_fim: string | null;
  /** 'agendado' | 'confirmado' | 'realizado' | 'cancelado' (CHECK no banco). */
  status: string;
}

/** Compromisso pronto para a tela, com o estagiário quando for da equipe supervisionada. */
export interface EventoAgenda extends AgendaAdvogado {
  estagiario: MembroEquipe | null;
}

const COLUNAS =
  "id, advogado_id, titulo_evento, area_juridica, prioridade, data_hora_inicio, data_hora_fim, status";

export class ErroAgenda extends Error {
  constructor(
    message: string,
    /** true quando a tabela agenda_advogados não existe (ou não está exposta na API). */
    readonly tabelaAusente: boolean,
  ) {
    super(message);
    this.name = "ErroAgenda";
  }
}

/**
 * Agenda visível para o usuário, em ordem cronológica (data_hora_inicio crescente):
 * - titular: compromissos dele + dos estagiários que supervisiona;
 * - estagiário: só os dele.
 * O RLS (pode_acessar_ficha) aplica a mesma regra no banco.
 */
export async function buscarAgenda(perfil: Advogado): Promise<EventoAgenda[]> {
  const estagiarios = await buscarEstagiariosSupervisionados(perfil);
  const estagiarioPorId = new Map(estagiarios.map((e) => [e.id, e]));

  const { data, error } = await supabase
    .from("agenda_advogados")
    .select(COLUNAS)
    .in("advogado_id", [perfil.id, ...estagiarios.map((e) => e.id)])
    .order("data_hora_inicio", { ascending: true })
    .overrideTypes<AgendaAdvogado[], { merge: false }>();

  if (error) {
    // PGRST205: tabela fora do cache da API; 42P01: relação inexistente no Postgres
    throw new ErroAgenda(error.message, error.code === "PGRST205" || error.code === "42P01");
  }

  return (data ?? []).map((e) => ({ ...e, estagiario: estagiarioPorId.get(e.advogado_id) ?? null }));
}

/** Rótulos dos status mais comuns; valores desconhecidos são exibidos de forma legível. */
const STATUS_EVENTO_LABEL: Record<string, string> = {
  agendado: "Agendado",
  confirmado: "Confirmado",
  realizado: "Realizado",
  cancelado: "Cancelado",
};

export function rotuloStatusEvento(status: string): string {
  const chave = normalizar(status);
  if (STATUS_EVENTO_LABEL[chave]) return STATUS_EVENTO_LABEL[chave];
  const texto = status.replace(/_/g, " ").trim();
  return texto ? texto.charAt(0).toUpperCase() + texto.slice(1) : "Sem status";
}

export function eventoCancelado(status: string): boolean {
  return normalizar(status) === "cancelado";
}

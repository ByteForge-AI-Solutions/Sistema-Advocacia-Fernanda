import type { PostgrestError } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase/client";
import {
  buscarEstagiariosSupervisionados,
  type Advogado,
  type AreaJuridica,
  type MembroEquipe,
} from "@/lib/advogados";
import { normalizar, type Prioridade } from "@/lib/fichas";

export const STATUS_EVENTO = ["agendado", "confirmado", "realizado", "cancelado"] as const;
export type StatusEvento = (typeof STATUS_EVENTO)[number];

export const STATUS_EVENTO_LABEL: Record<StatusEvento, string> = {
  agendado: "Agendado",
  confirmado: "Confirmado",
  realizado: "Realizado",
  cancelado: "Cancelado",
};

export function isStatusEvento(valor: unknown): valor is StatusEvento {
  return typeof valor === "string" && (STATUS_EVENTO as readonly string[]).includes(valor);
}

/** Linha da tabela `agenda_advogados` (seções 6 e 7 do schema.sql), como vem do Supabase. */
export interface AgendaAdvogado {
  id: string;
  /** Responsável pelo compromisso (FK → advogados.id). Base do RLS. */
  advogado_id: string;
  /** Ficha do cliente vinculada (opcional, FK → fichas_clientes.id). */
  ficha_id: string | null;
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

/** Compromisso pronto para a tela. */
export interface EventoAgenda extends AgendaAdvogado {
  /** Preenchido quando o responsável é um estagiário supervisionado pelo usuário. */
  estagiario: MembroEquipe | null;
  /** Cliente da ficha vinculada; null se não houver vínculo ou se o usuário não puder ver a ficha (RLS). */
  ficha: { id: string; nome_cliente: string } | null;
}

/** Dados enviados ao criar/editar uma reunião. */
export interface DadosReuniao {
  advogado_id: string;
  ficha_id: string | null;
  titulo_evento: string;
  area_juridica: AreaJuridica;
  prioridade: Prioridade;
  data_hora_inicio: string;
  data_hora_fim: string;
  status: StatusEvento;
}

// O embed usa a FK ficha_id → fichas_clientes e respeita o RLS das fichas.
const COLUNAS =
  "id, advogado_id, ficha_id, titulo_evento, area_juridica, prioridade, data_hora_inicio, data_hora_fim, status, ficha:fichas_clientes(id, nome_cliente)";

type AgendaRow = AgendaAdvogado & { ficha: { id: string; nome_cliente: string } | null };

export type MotivoErroAgenda = "tabela_ausente" | "banco_desatualizado" | "outro";

export class ErroAgenda extends Error {
  constructor(
    message: string,
    readonly motivo: MotivoErroAgenda,
  ) {
    super(message);
    this.name = "ErroAgenda";
  }
}

function motivoDoErro(error: PostgrestError): MotivoErroAgenda {
  // PGRST205 / 42P01: tabela inexistente. PGRST200 / PGRST204 / 42703: coluna ou relação
  // (ficha_id) ainda não criada, ou seja, a seção 7 do schema.sql não foi aplicada.
  if (error.code === "PGRST205" || error.code === "42P01") return "tabela_ausente";
  if (["PGRST200", "PGRST204", "42703"].includes(error.code)) return "banco_desatualizado";
  return "outro";
}

/** Equipe visível ao usuário (ele mesmo + estagiários supervisionados), na ordem de exibição. */
export interface ContextoAgenda {
  eventos: EventoAgenda[];
  responsaveis: MembroEquipe[];
}

/**
 * Agenda visível para o usuário, em ordem cronológica (data_hora_inicio crescente):
 * - titular: compromissos dele + dos estagiários que supervisiona;
 * - estagiário: só os dele.
 * O RLS (pode_acessar_ficha) aplica a mesma regra no banco.
 */
export async function buscarAgenda(perfil: Advogado): Promise<ContextoAgenda> {
  const estagiarios = await buscarEstagiariosSupervisionados(perfil);
  const estagiarioPorId = new Map(estagiarios.map((e) => [e.id, e]));
  const responsaveis = [{ id: perfil.id, nome: perfil.nome }, ...estagiarios];

  const { data, error } = await supabase
    .from("agenda_advogados")
    .select(COLUNAS)
    .in(
      "advogado_id",
      responsaveis.map((r) => r.id),
    )
    .order("data_hora_inicio", { ascending: true })
    .overrideTypes<AgendaRow[], { merge: false }>();

  if (error) throw new ErroAgenda(error.message, motivoDoErro(error));

  return {
    responsaveis,
    eventos: (data ?? []).map((e) => ({
      ...e,
      ficha: e.ficha ?? null,
      estagiario: estagiarioPorId.get(e.advogado_id) ?? null,
    })),
  };
}

/** Traduz erros do banco ao salvar uma reunião para mensagens claras. */
function mensagemErroSalvar(error: PostgrestError): string {
  const texto = `${error.message} ${error.details ?? ""}`;
  switch (error.code) {
    case "42501":
      return texto.includes("Ficha vinculada")
        ? "A ficha escolhida não está disponível para você. Selecione outra ficha."
        : "Você não tem permissão para salvar reuniões para este responsável.";
    case "23514":
      if (texto.includes("agenda_fim_depois_do_inicio")) return "O término precisa ser depois do início.";
      if (texto.includes("agenda_titulo_nao_vazio")) return "Informe o título da reunião.";
      return "Algum campo está com valor inválido. Revise o formulário.";
    case "23503":
      return "Responsável ou ficha não encontrados. Atualize a página e tente novamente.";
    case "PGRST116":
      return "Reunião não encontrada ou você não tem permissão para editá-la.";
  }
  if (motivoDoErro(error) !== "outro") {
    return "O banco ainda não tem a estrutura da agenda atualizada. Rode as seções 5, 6 e 7 do schema.sql.";
  }
  return "Não foi possível salvar a reunião. Verifique sua conexão e tente novamente.";
}

/** Cria (sem id) ou atualiza (com id) uma reunião. Lança Error com mensagem pronta para o usuário. */
export async function salvarReuniao(dados: DadosReuniao, id?: string): Promise<void> {
  const consulta = id
    ? supabase.from("agenda_advogados").update(dados).eq("id", id)
    : supabase.from("agenda_advogados").insert(dados);

  // .select().single(): sem isso, um UPDATE barrado pelo RLS "passa" afetando 0 linhas.
  const { error } = await consulta.select("id").single();
  if (error) {
    console.error("Erro ao salvar reunião:", error.code, error.message);
    throw new Error(mensagemErroSalvar(error));
  }
}

/** Rótulo do status; valores fora da lista são exibidos de forma legível. */
export function rotuloStatusEvento(status: string): string {
  const chave = normalizar(status);
  if (isStatusEvento(chave)) return STATUS_EVENTO_LABEL[chave];
  const texto = status.replace(/_/g, " ").trim();
  return texto ? texto.charAt(0).toUpperCase() + texto.slice(1) : "Sem status";
}

export function eventoCancelado(status: string): boolean {
  return normalizar(status) === "cancelado";
}

/** Término efetivo (início quando não há fim). */
export function terminoDoEvento(e: Pick<AgendaAdvogado, "data_hora_inicio" | "data_hora_fim">): Date {
  return new Date(e.data_hora_fim ?? e.data_hora_inicio);
}

import type { PostgrestError } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase/client";

/**
 * Inbox omnichannel (bot + humano) sobre as tabelas dfu_* do bot v2.1 e da migração v3.
 * Leitura direta (RLS: pode_acessar_ficha / titulares da área para "não atribuídos").
 * Toda escrita passa por RPCs SECURITY DEFINER que revalidam o acesso.
 */

export type StatusConversa =
  | "em_andamento"
  | "aguardando_horario"
  | "agendado"
  | "humano"
  | "encerrado"
  | "descadastrado";

export const STATUS_CONVERSA_LABEL: Record<StatusConversa, string> = {
  em_andamento: "Bot atendendo",
  aguardando_horario: "Bot · aguardando horário",
  agendado: "Reunião agendada",
  humano: "Atendimento humano",
  encerrado: "Encerrado",
  descadastrado: "Opt-out (não contatar)",
};

export const STATUS_CONVERSA_ESTILO: Record<StatusConversa, string> = {
  em_andamento: "bg-violet-50 text-violet-700 ring-violet-600/20",
  aguardando_horario: "bg-violet-50 text-violet-700 ring-violet-600/20",
  agendado: "bg-sky-50 text-sky-700 ring-sky-600/20",
  humano: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  encerrado: "bg-slate-100 text-slate-600 ring-slate-500/20",
  descadastrado: "bg-red-50 text-red-700 ring-red-600/20",
};

export function rotuloStatusConversa(status: string): string {
  return STATUS_CONVERSA_LABEL[status as StatusConversa] ?? status.replaceAll("_", " ");
}

export function estiloStatusConversa(status: string): string {
  return STATUS_CONVERSA_ESTILO[status as StatusConversa] ?? STATUS_CONVERSA_ESTILO.encerrado;
}

export const conversaComBot = (status: string) => status === "em_andamento" || status === "aguardando_horario";
export const conversaEncerrada = (status: string) => status === "encerrado" || status === "descadastrado";

export interface Atendimento {
  telefone: string;
  nome_cliente: string | null;
  area: string | null;
  status: string;
  etapa: string;
  prioridade: string;
  motivo_prioridade: string | null;
  resumo_fatos: string;
  dados_coletados: Record<string, unknown> | null;
  advogado_id: string | null;
  ficha_id: string | null;
  etiquetas: string[] | null;
  bloqueado: boolean;
  ultima_msg_cliente_em: string | null;
  ultima_msg_bot_em: string | null;
  atualizado_em: string;
  criado_em: string;
}

export interface Mensagem {
  id: number;
  provider_id: string | null;
  direcao: "IN" | "OUT";
  tipo: string;
  conteudo: string;
  criado_em: string;
}

export interface NotaInterna {
  id: string;
  autor_id: string;
  texto: string;
  sistema: boolean;
  criado_em: string;
}

/** Respostas humanas na fila de saída (autor_advogado_id preenchido). */
export interface SaidaHumana {
  id: string;
  texto: string;
  status: "PENDENTE" | "AMBIGUO" | "ENVIADO" | "BLOQUEADO";
  provider_id: string | null;
  autor_advogado_id: string;
  criado_em: string;
}

export interface Conversa {
  mensagens: Mensagem[];
  notas: NotaInterna[];
  saidas: SaidaHumana[];
  /** true quando notas/saídas não puderam ser lidas (migração v3 pendente). */
  recursosV3Indisponiveis: boolean;
}

const COLUNAS_ATENDIMENTO =
  "telefone,nome_cliente,area,status,etapa,prioridade,motivo_prioridade,resumo_fatos,dados_coletados,advogado_id,ficha_id,etiquetas,bloqueado,ultima_msg_cliente_em,ultima_msg_bot_em,atualizado_em,criado_em";
// Sem a coluna etiquetas (antes da migração v3).
const COLUNAS_ATENDIMENTO_V2 = COLUNAS_ATENDIMENTO.replace(",etiquetas", "");

export class ErroInbox extends Error {
  constructor(
    message: string,
    readonly migracaoPendente = false,
  ) {
    super(message);
    this.name = "ErroInbox";
  }
}

const faltaEstrutura = (e: PostgrestError) => ["PGRST205", "42P01", "42703", "PGRST202", "PGRST204"].includes(e.code);

export async function listarAtendimentos(): Promise<{ itens: Atendimento[]; v3: boolean }> {
  const consulta = (colunas: string) =>
    supabase
      .from("dfu_atendimentos")
      .select(colunas)
      .order("ultima_msg_cliente_em", { ascending: false, nullsFirst: false })
      .limit(300)
      .overrideTypes<Atendimento[], { merge: false }>();

  let { data, error } = await consulta(COLUNAS_ATENDIMENTO);
  let v3 = true;
  if (error && error.code === "42703") {
    // Bot instalado, migração v3 ainda não: funciona em modo leitura.
    ({ data, error } = await consulta(COLUNAS_ATENDIMENTO_V2));
    v3 = false;
  }
  if (error) {
    console.error("Erro ao listar atendimentos:", error.code, error.message);
    throw new ErroInbox(
      faltaEstrutura(error)
        ? "As tabelas do bot (dfu_*) não foram encontradas. Aplique 20261118_bot_unificado.sql no Supabase."
        : "Não foi possível consultar os atendimentos. Verifique sua conexão.",
      faltaEstrutura(error),
    );
  }
  return { itens: (data ?? []).map((a) => ({ ...a, etiquetas: a.etiquetas ?? [] })), v3 };
}

export async function carregarConversa(telefone: string): Promise<Conversa> {
  const [msgs, notas, saidas] = await Promise.all([
    supabase
      .from("dfu_mensagens")
      .select("id,provider_id,direcao,tipo,conteudo,criado_em")
      .eq("telefone", telefone)
      .order("id", { ascending: false })
      .limit(300)
      .overrideTypes<Mensagem[], { merge: false }>(),
    supabase
      .from("dfu_notas_internas")
      .select("id,autor_id,texto,sistema,criado_em")
      .eq("telefone", telefone)
      .order("criado_em", { ascending: true })
      .limit(300)
      .overrideTypes<NotaInterna[], { merge: false }>(),
    supabase
      .from("dfu_outbox")
      .select("id,texto,status,provider_id,autor_advogado_id,criado_em")
      .eq("telefone", telefone)
      .not("autor_advogado_id", "is", null)
      .order("criado_em", { ascending: true })
      .limit(300)
      .overrideTypes<SaidaHumana[], { merge: false }>(),
  ]);

  if (msgs.error) {
    console.error("Erro ao carregar mensagens:", msgs.error.code, msgs.error.message);
    throw new ErroInbox("Não foi possível carregar o histórico desta conversa.");
  }
  return {
    mensagens: [...(msgs.data ?? [])].reverse(),
    notas: notas.error ? [] : (notas.data ?? []),
    saidas: saidas.error ? [] : (saidas.data ?? []),
    recursosV3Indisponiveis: Boolean(notas.error || saidas.error),
  };
}

// ---------- ações ----------

const MENSAGENS_HINT: Record<string, string> = {
  crm_sem_acesso: "Você não tem permissão sobre este atendimento.",
  crm_optout: "O cliente pediu para não receber mensagens (opt-out). Não é possível reabrir nem responder.",
  crm_assuma_primeiro: "Assuma o atendimento antes de responder: o bot ainda está ativo nesta conversa.",
  crm_texto_invalido: "Mensagem vazia ou longa demais (máximo de 4.000 caracteres).",
  crm_janela_24h:
    "A janela de 24 h do WhatsApp terminou: o cliente precisa enviar uma nova mensagem para você poder responder por texto.",
  crm_destino_invalido: "Destino inválido: escolha um titular ativo ou um estagiário que você supervisiona.",
  crm_estado_invalido: "Esta ação não é válida no estado atual do atendimento.",
};

function mensagemErro(error: PostgrestError, padrao: string): string {
  if (error.hint && MENSAGENS_HINT[error.hint]) return MENSAGENS_HINT[error.hint];
  if (error.code === "PGRST202" || error.code === "42883") {
    return "Esta ação precisa da migração 20261118_v3_crm_modulos.sql no Supabase.";
  }
  if (error.code === "42501") return MENSAGENS_HINT.crm_sem_acesso;
  return padrao;
}

async function rpc(nome: string, args: Record<string, unknown>, padrao: string): Promise<unknown> {
  const { data, error } = await supabase.rpc(nome, args);
  if (error) {
    console.error(`Erro em ${nome}:`, error.code, error.message);
    throw new Error(mensagemErro(error, padrao));
  }
  return data;
}

export async function responder(telefone: string, texto: string): Promise<void> {
  await rpc("crm_atendimento_responder", { p_telefone: telefone, p_texto: texto }, "Não foi possível enviar a resposta.");
}

export async function transferir(telefone: string, destinoId: string): Promise<void> {
  await rpc("crm_atendimento_transferir", { p_telefone: telefone, p_destino: destinoId }, "Não foi possível transferir.");
}

export async function devolverAoBot(telefone: string): Promise<void> {
  await rpc("crm_atendimento_devolver_bot", { p_telefone: telefone }, "Não foi possível devolver ao bot.");
}

export async function encerrar(telefone: string): Promise<void> {
  await rpc("crm_atendimento_encerrar", { p_telefone: telefone }, "Não foi possível encerrar o atendimento.");
}

/** Reabre conversa encerrada/agendada ou assume conversa sem responsável. */
export async function assumirAmpliado(telefone: string): Promise<void> {
  await rpc("crm_atendimento_assumir", { p_telefone: telefone }, "Não foi possível assumir o atendimento.");
}

export async function salvarEtiquetas(telefone: string, etiquetas: string[]): Promise<string[]> {
  const data = await rpc(
    "crm_atendimento_etiquetas",
    { p_telefone: telefone, p_etiquetas: etiquetas },
    "Não foi possível salvar as etiquetas.",
  );
  return Array.isArray(data) ? (data as string[]) : etiquetas;
}

export async function criarNota(telefone: string, autorId: string, texto: string): Promise<void> {
  const limpo = texto.trim();
  if (!limpo || limpo.length > 4000) throw new Error(MENSAGENS_HINT.crm_texto_invalido);
  const { error } = await supabase
    .from("dfu_notas_internas")
    .insert({ telefone, autor_id: autorId, texto: limpo });
  if (error) {
    console.error("Erro ao criar nota:", error.code, error.message);
    throw new Error(
      faltaEstrutura(error)
        ? "Notas internas precisam da migração 20261118_v3_crm_modulos.sql no Supabase."
        : mensagemErro(error, "Não foi possível salvar a nota."),
    );
  }
}

// ---------- utilidades ----------

/** WhatsApp só aceita texto livre até 24 h após a última mensagem do cliente. */
export function janela24hAberta(a: Pick<Atendimento, "ultima_msg_cliente_em">, agora = Date.now()): boolean {
  if (!a.ultima_msg_cliente_em) return false;
  return agora - new Date(a.ultima_msg_cliente_em).getTime() < 24 * 60 * 60 * 1000;
}

/** 5511987654321 → (11) 98765-4321 */
export function formatarTelefoneBr(telefone: string): string {
  const d = telefone.replace(/\D/g, "");
  const m = d.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : telefone;
}

export interface MembroDestino {
  id: string;
  nome: string;
  cargo: string;
  supervisor_id: string | null;
}

/** Nomes de toda a equipe (autoria de notas/respostas) e opções de transferência. */
export async function carregarEquipe(): Promise<MembroDestino[]> {
  const { data, error } = await supabase
    .from("advogados")
    .select("id,nome,cargo,supervisor_id")
    .eq("ativo", true)
    .order("nome")
    .overrideTypes<MembroDestino[], { merge: false }>();
  if (error) {
    console.error("Erro ao carregar equipe:", error.code, error.message);
    return [];
  }
  return data ?? [];
}

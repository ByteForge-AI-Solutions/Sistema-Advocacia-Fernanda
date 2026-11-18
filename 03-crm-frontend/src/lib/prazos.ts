import type { PostgrestError } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase/client";
import { buscarEquipeVisivel, type Advogado, type MembroEquipe } from "@/lib/advogados";
import { chaveDia } from "@/lib/datas";

/** Tabela processos_prazos (migração 20261118_v3_crm_modulos.sql). */
export type TipoContagem = "uteis" | "corridos";
export type StatusPrazo = "pendente" | "cumprido" | "urgente";

export const STATUS_PRAZO_LABEL: Record<StatusPrazo, string> = {
  pendente: "Pendente",
  urgente: "Urgente",
  cumprido: "Cumprido",
};

export interface PrazoProcessual {
  id: string;
  ficha_id: string | null;
  advogado_id: string;
  numero_cnj: string;
  tribunal_vara: string | null;
  fase_processual: string | null;
  descricao_prazo: string;
  /** "YYYY-MM-DD" (date, sem fuso). */
  data_fatal: string;
  tipo_contagem: TipoContagem;
  status: StatusPrazo;
  observacoes: string | null;
  cumprido_em: string | null;
  ficha: { id: string; nome_cliente: string } | null;
}

export interface PrazoNaTela extends PrazoProcessual {
  estagiario: MembroEquipe | null;
  /** Responsável quando não é o usuário logado (estagiário ou, para sócios, outro titular). */
  responsavel: MembroEquipe | null;
}

export type DadosPrazo = Omit<PrazoProcessual, "id" | "cumprido_em" | "ficha">;

const COLUNAS =
  "id,ficha_id,advogado_id,numero_cnj,tribunal_vara,fase_processual,descricao_prazo,data_fatal,tipo_contagem,status,observacoes,cumprido_em,ficha:fichas_clientes(id,nome_cliente)";

export class ErroPrazos extends Error {
  constructor(message: string, readonly tabelaAusente = false) {
    super(message);
    this.name = "ErroPrazos";
  }
}

const tabelaAusente = (e: PostgrestError) => e.code === "PGRST205" || e.code === "42P01";

export async function buscarPrazos(perfil: Advogado): Promise<{ prazos: PrazoNaTela[]; responsaveis: MembroEquipe[] }> {
  // Sócio: todo o escritório; titular: ele + estagiários; demais: só ele (espelha o RLS).
  const responsaveis = await buscarEquipeVisivel(perfil);
  const porId = new Map(responsaveis.map((r) => [r.id, r]));
  const { data, error } = await supabase
    .from("processos_prazos")
    .select(COLUNAS)
    .in("advogado_id", responsaveis.map((r) => r.id))
    .order("data_fatal", { ascending: true })
    .overrideTypes<PrazoProcessual[], { merge: false }>();
  if (error) {
    console.error("Erro ao buscar prazos:", error.code, error.message);
    throw new ErroPrazos(
      tabelaAusente(error)
        ? "A tabela processos_prazos ainda não existe. Aplique a migração 20261118_v3_crm_modulos.sql no Supabase."
        : "Não foi possível carregar os prazos.",
      tabelaAusente(error),
    );
  }
  return {
    responsaveis,
    prazos: (data ?? []).map((p) => {
      const membro = p.advogado_id === perfil.id ? null : (porId.get(p.advogado_id) ?? null);
      return {
        ...p,
        ficha: p.ficha ?? null,
        responsavel: membro,
        estagiario: membro?.cargo === "estagiario" ? membro : null,
      };
    }),
  };
}

/** Prazos de um intervalo de datas (para a agenda mensal). Silencioso se a tabela não existir. */
export async function buscarPrazosPeriodo(ids: string[], de: string, ate: string): Promise<PrazoProcessual[]> {
  if (ids.length === 0) return [];
  const { data, error } = await supabase
    .from("processos_prazos")
    .select(COLUNAS)
    .in("advogado_id", ids)
    .gte("data_fatal", de)
    .lte("data_fatal", ate)
    .neq("status", "cumprido")
    .order("data_fatal", { ascending: true })
    .overrideTypes<PrazoProcessual[], { merge: false }>();
  if (error) {
    if (!tabelaAusente(error)) console.error("Erro ao buscar prazos do mês:", error.code, error.message);
    return [];
  }
  return data ?? [];
}

function mensagemErroSalvar(error: PostgrestError): string {
  const texto = `${error.message} ${error.details ?? ""}`;
  if (tabelaAusente(error)) return "A tabela processos_prazos ainda não existe. Aplique a migração v3 no Supabase.";
  if (error.code === "42501") {
    return texto.includes("Ficha vinculada")
      ? "A ficha escolhida não está disponível para você."
      : "Você não tem permissão para salvar prazos para este responsável.";
  }
  if (error.code === "23514") {
    if (texto.includes("numero_cnj")) return "Número CNJ inválido. Use o formato 0000000-00.0000.0.00.0000.";
    return "Algum campo está com valor inválido. Revise o formulário.";
  }
  if (error.code === "PGRST116") return "Prazo não encontrado ou sem permissão.";
  return "Não foi possível salvar o prazo. Verifique sua conexão e tente novamente.";
}

export async function salvarPrazo(dados: DadosPrazo, id?: string): Promise<void> {
  const consulta = id
    ? supabase.from("processos_prazos").update(dados).eq("id", id)
    : supabase.from("processos_prazos").insert(dados);
  const { error } = await consulta.select("id").single();
  if (error) {
    console.error("Erro ao salvar prazo:", error.code, error.message);
    throw new Error(mensagemErroSalvar(error));
  }
}

export async function alterarStatusPrazo(id: string, status: StatusPrazo): Promise<void> {
  const { error } = await supabase.from("processos_prazos").update({ status }).eq("id", id).select("id").single();
  if (error) throw new Error(mensagemErroSalvar(error));
}

export async function excluirPrazo(id: string): Promise<void> {
  const { data, error } = await supabase.from("processos_prazos").delete().eq("id", id).select("id");
  if (error) throw new Error(mensagemErroSalvar(error));
  if (!data || data.length === 0) {
    throw new Error("Não foi possível excluir: estagiários não excluem prazos (marque como cumprido).");
  }
}

// ---------- número CNJ (Resolução CNJ nº 65/2008) ----------

/** Aplica a máscara NNNNNNN-DD.AAAA.J.TR.OOOO enquanto o usuário digita. */
export function mascararCnj(valor: string): string {
  const d = valor.replace(/\D/g, "").slice(0, 20);
  const partes = [d.slice(0, 7), d.slice(7, 9), d.slice(9, 13), d.slice(13, 14), d.slice(14, 16), d.slice(16, 20)];
  let s = partes[0];
  if (partes[1]) s += `-${partes[1]}`;
  if (partes[2]) s += `.${partes[2]}`;
  if (partes[3]) s += `.${partes[3]}`;
  if (partes[4]) s += `.${partes[4]}`;
  if (partes[5]) s += `.${partes[5]}`;
  return s;
}

export const CNJ_REGEX = /^\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}$/;

/** Confere os dígitos verificadores (módulo 97, ISO 7064). */
export function cnjValido(numero: string): boolean {
  if (!CNJ_REGEX.test(numero)) return false;
  const d = numero.replace(/\D/g, "");
  const [n, dv, ano, j, tr, origem] = [d.slice(0, 7), d.slice(7, 9), d.slice(9, 13), d.slice(13, 14), d.slice(14, 16), d.slice(16)];
  const resto = BigInt(`${n}${ano}${j}${tr}${origem}00`) % BigInt(97);
  return String(BigInt(98) - resto).padStart(2, "0") === dv;
}

// ---------- calendário forense ----------

/** "YYYY-MM-DD" → Date ao meio-dia local (evita deslocamento de fuso). */
export const dataLocal = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00`);

/** Recesso forense (CPC, art. 220): 20/12 a 20/01, prazos suspensos. */
export function emRecesso(d: Date): boolean {
  const m = d.getMonth();
  const dia = d.getDate();
  return (m === 11 && dia >= 20) || (m === 0 && dia <= 20);
}

export function diaUtil(d: Date, feriados: Set<string>): boolean {
  const dow = d.getDay();
  return dow !== 0 && dow !== 6 && !feriados.has(chaveDia(d)) && !emRecesso(d);
}

function somarDia(d: Date, n = 1): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/**
 * Estimativa da data fatal a partir da intimação/publicação (CPC, arts. 219, 220 e 224):
 * a contagem começa no 1º dia útil seguinte; em dias úteis, só contam dias úteis; em dias
 * corridos, contam todos exceto o recesso; termo final em dia não útil vai ao próximo dia útil.
 * Não considera feriados locais não cadastrados nem suspensões do tribunal: sempre confira.
 */
export function calcularDataFatal(intimacao: string, dias: number, tipo: TipoContagem, feriados: Set<string>): string | null {
  if (!intimacao || !Number.isInteger(dias) || dias < 1 || dias > 3650) return null;
  let d = somarDia(dataLocal(intimacao));
  while (!diaUtil(d, feriados)) d = somarDia(d);
  let contados = 1;
  while (contados < dias) {
    d = somarDia(d);
    if (tipo === "uteis" ? diaUtil(d, feriados) : !emRecesso(d)) contados++;
  }
  while (!diaUtil(d, feriados)) d = somarDia(d);
  return chaveDia(d);
}

export async function buscarFeriados(): Promise<Set<string>> {
  const { data, error } = await supabase.from("dfu_feriados").select("dia").overrideTypes<{ dia: string }[], { merge: false }>();
  if (error) return new Set();
  return new Set((data ?? []).map((f) => f.dia.slice(0, 10)));
}

// ---------- urgência ----------

export type Urgencia = "vencido" | "hoje" | "urgente" | "proximo" | "futuro" | "cumprido";

export function diasRestantes(dataFatal: string, hoje = new Date()): number {
  const alvo = dataLocal(dataFatal);
  const base = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate(), 12);
  return Math.round((alvo.getTime() - base.getTime()) / 86_400_000);
}

export function urgenciaDoPrazo(p: Pick<PrazoProcessual, "data_fatal" | "status">, hoje = new Date()): Urgencia {
  if (p.status === "cumprido") return "cumprido";
  const n = diasRestantes(p.data_fatal, hoje);
  if (n < 0) return "vencido";
  if (n === 0) return "hoje";
  if (n <= 2 || p.status === "urgente") return "urgente";
  if (n <= 7) return "proximo";
  return "futuro";
}

export const URGENCIA_INFO: Record<Urgencia, { label: string; badge: string; faixa: string }> = {
  vencido: { label: "Vencido", badge: "bg-red-700 text-white ring-red-700", faixa: "bg-red-700" },
  hoje: { label: "Vence hoje", badge: "bg-red-600 text-white ring-red-600", faixa: "bg-red-600" },
  urgente: { label: "Urgente", badge: "bg-red-50 text-red-700 ring-red-600/20", faixa: "bg-red-500" },
  proximo: { label: "Próximos 7 dias", badge: "bg-amber-50 text-amber-800 ring-amber-600/25", faixa: "bg-amber-400" },
  futuro: { label: "No prazo", badge: "bg-slate-50 text-slate-700 ring-slate-500/20", faixa: "bg-slate-300" },
  cumprido: { label: "Cumprido", badge: "bg-emerald-50 text-emerald-700 ring-emerald-600/20", faixa: "bg-emerald-500" },
};

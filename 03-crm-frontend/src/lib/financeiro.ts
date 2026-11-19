import type { PostgrestError } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase/client";
import { chaveDia } from "@/lib/datas";

/**
 * Honorários (migração 20261119_v7_financeiro_documentos.sql): contratos por ficha, parcelas
 * e entradas (PIX etc.). Valores são calculados em centavos inteiros para não perder centavo
 * na divisão. Pagamento confirmado move o funil no banco (trigger crm_fin_avancar_funil).
 */

export const TIPOS_CONTRATO = ["diagnostico", "honorarios", "exito", "outro"] as const;
export type TipoContrato = (typeof TIPOS_CONTRATO)[number];
export const TIPO_CONTRATO_LABEL: Record<TipoContrato, string> = {
  diagnostico: "Diagnóstico",
  honorarios: "Honorários contratuais",
  exito: "Honorários de êxito",
  outro: "Outro",
};
/** Efeito no funil quando o primeiro pagamento é confirmado. */
export const TIPO_CONTRATO_FUNIL: Partial<Record<TipoContrato, string>> = {
  diagnostico: "Pagamento confirmado move o lead para \"Diagnóstico pago\".",
  honorarios: "Pagamento confirmado move o lead para \"Cliente ativo\".",
  exito: "Pagamento confirmado move o lead para \"Cliente ativo\".",
};

export type FormaPagamento = "a_vista" | "parcelado";
export const MEIOS = ["pix", "boleto", "transferencia", "dinheiro", "cartao", "outro"] as const;
export type MeioPagamento = (typeof MEIOS)[number];
export const MEIO_LABEL: Record<MeioPagamento, string> = {
  pix: "PIX",
  boleto: "Boleto",
  transferencia: "Transferência",
  dinheiro: "Dinheiro",
  cartao: "Cartão",
  outro: "Outro",
};

export interface Parcela {
  id: string;
  contrato_id: string;
  numero: number;
  valor: number;
  /** "YYYY-MM-DD" */
  vencimento: string;
  pago_em: string | null;
  valor_pago: number | null;
  meio: MeioPagamento | null;
  comprovante_id: string | null;
  observacao: string | null;
}

export interface ContratoFinanceiro {
  id: string;
  ficha_id: string;
  advogado_id: string;
  tipo: TipoContrato;
  descricao: string;
  valor_total: number | null;
  forma_pagamento: FormaPagamento;
  percentual_exito: number | null;
  cancelado: boolean;
  observacoes: string | null;
  created_at: string;
  parcelas: Parcela[];
}

// ---------- dinheiro ----------

const fmtMoeda = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
export const formatarMoeda = (v: number | null | undefined) => fmtMoeda.format(v ?? 0);

/** "3.000,50" / "3000.50" / "R$ 3.000" → 3000.5; inválido → null. */
export function lerMoeda(texto: string): number | null {
  let t = texto.replace(/[R$\s]/g, "");
  if (!t) return null;
  if (t.includes(",")) t = t.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, "");
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

/** 3000.5 → "3.000,50" (para preencher campos de texto e documentos). */
export const moedaSemSimbolo = (v: number) =>
  new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);

// ---------- datas ----------

/** Soma meses mantendo o dia (31/01 + 1 → último dia de fevereiro). "YYYY-MM-DD". */
export function somarMesesData(iso: string, meses: number): string {
  const [a, m, d] = iso.slice(0, 10).split("-").map(Number);
  const alvo = new Date(a, m - 1 + meses, 1, 12);
  const ultimo = new Date(alvo.getFullYear(), alvo.getMonth() + 1, 0).getDate();
  alvo.setDate(Math.min(d, ultimo));
  return chaveDia(alvo);
}

/**
 * Divide o total em `qtd` parcelas mensais, em centavos: as primeiras recebem o centavo
 * que sobrar, e a soma sempre bate com o total (o banco também confere).
 */
export function dividirParcelas(total: number, qtd: number, primeiroVencimento: string): { numero: number; valor: number; vencimento: string }[] {
  const centavos = Math.round(total * 100);
  if (!(centavos > 0) || !Number.isInteger(qtd) || qtd < 1 || qtd > 240 || !primeiroVencimento) return [];
  const base = Math.floor(centavos / qtd);
  const resto = centavos - base * qtd;
  return Array.from({ length: qtd }, (_, i) => ({
    numero: i + 1,
    valor: (base + (i < resto ? 1 : 0)) / 100,
    vencimento: somarMesesData(primeiroVencimento, i),
  }));
}

// ---------- status ----------

export type StatusParcela = "paga" | "pendente" | "atrasada";
export const STATUS_PARCELA_INFO: Record<StatusParcela, { label: string; badge: string }> = {
  paga: { label: "Pago", badge: "bg-emerald-50 text-emerald-700 ring-emerald-600/20" },
  pendente: { label: "Pendente", badge: "bg-slate-100 text-slate-700 ring-slate-500/20" },
  atrasada: { label: "Atrasado", badge: "bg-red-50 text-red-700 ring-red-600/20" },
};

export function statusParcela(p: Pick<Parcela, "pago_em" | "vencimento">, hoje = new Date()): StatusParcela {
  if (p.pago_em) return "paga";
  return p.vencimento.slice(0, 10) < chaveDia(hoje) ? "atrasada" : "pendente";
}

export type StatusContrato = "quitado" | "em_dia" | "atrasado" | "cancelado" | "sem_parcelas";
export const STATUS_CONTRATO_INFO: Record<StatusContrato, { label: string; badge: string }> = {
  quitado: { label: "Pago", badge: "bg-emerald-50 text-emerald-700 ring-emerald-600/20" },
  em_dia: { label: "Pendente", badge: "bg-slate-100 text-slate-700 ring-slate-500/20" },
  atrasado: { label: "Atrasado", badge: "bg-red-50 text-red-700 ring-red-600/20" },
  cancelado: { label: "Cancelado", badge: "bg-slate-100 text-slate-500 ring-slate-400/20 line-through" },
  sem_parcelas: { label: "Só êxito", badge: "bg-violet-50 text-violet-700 ring-violet-600/20" },
};

export interface ResumoContrato {
  status: StatusContrato;
  recebido: number;
  emAberto: number;
  atrasado: number;
  pagas: number;
  total: number;
}

export function resumoContrato(c: Pick<ContratoFinanceiro, "cancelado" | "parcelas">, hoje = new Date()): ResumoContrato {
  let recebido = 0;
  let emAberto = 0;
  let atrasado = 0;
  let pagas = 0;
  for (const p of c.parcelas) {
    const s = statusParcela(p, hoje);
    if (s === "paga") {
      recebido += p.valor_pago ?? p.valor;
      pagas++;
    } else {
      emAberto += p.valor;
      if (s === "atrasada") atrasado += p.valor;
    }
  }
  const r = (n: number) => Math.round(n * 100) / 100;
  const status: StatusContrato = c.cancelado
    ? "cancelado"
    : c.parcelas.length === 0
      ? "sem_parcelas"
      : pagas === c.parcelas.length
        ? "quitado"
        : atrasado > 0
          ? "atrasado"
          : "em_dia";
  return { status, recebido: r(recebido), emAberto: r(emAberto), atrasado: r(atrasado), pagas, total: c.parcelas.length };
}

/** Texto da forma de pagamento para o contrato de honorários. */
export function textoFormaPagamento(c: Pick<ContratoFinanceiro, "forma_pagamento" | "parcelas">): string {
  const ps = [...c.parcelas].sort((a, b) => a.numero - b.numero);
  const data = (iso: string) => new Intl.DateTimeFormat("pt-BR").format(new Date(`${iso.slice(0, 10)}T12:00:00`));
  if (ps.length === 0) return "";
  if (c.forma_pagamento === "a_vista" || ps.length === 1) return `à vista, com vencimento em ${data(ps[0].vencimento)}`;
  const iguais = ps.every((p) => Math.abs(p.valor - ps[0].valor) < 0.02);
  return iguais
    ? `em ${ps.length} parcelas mensais de R$ ${moedaSemSimbolo(ps[0].valor)}, vencendo a primeira em ${data(ps[0].vencimento)}`
    : `em ${ps.length} parcelas mensais, vencendo a primeira em ${data(ps[0].vencimento)}, conforme cronograma acordado`;
}

// ---------- dados ----------

const ausente = (e: PostgrestError) => ["PGRST205", "42P01", "42703", "PGRST200"].includes(e.code);
const COLUNAS_PARCELA = "id,contrato_id,numero,valor,vencimento,pago_em,valor_pago,meio,comprovante_id,observacao";
const COLUNAS_CONTRATO = `id,ficha_id,advogado_id,tipo,descricao,valor_total,forma_pagamento,percentual_exito,cancelado,observacoes,created_at,parcelas:fin_parcelas(${COLUNAS_PARCELA})`;

/** numeric chega como string em alguns casos: normaliza para número. */
function normalizarContrato(c: ContratoFinanceiro): ContratoFinanceiro {
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    ...c,
    valor_total: n(c.valor_total),
    percentual_exito: n(c.percentual_exito),
    parcelas: (c.parcelas ?? [])
      .map((p) => ({ ...p, valor: Number(p.valor), valor_pago: n(p.valor_pago) }))
      .sort((a, b) => a.numero - b.numero),
  };
}

export async function buscarFinanceiroFicha(fichaId: string): Promise<{ contratos: ContratoFinanceiro[]; disponivel: boolean }> {
  const { data, error } = await supabase
    .from("fin_contratos")
    .select(COLUNAS_CONTRATO)
    .eq("ficha_id", fichaId)
    .order("created_at", { ascending: false })
    .overrideTypes<ContratoFinanceiro[], { merge: false }>();
  if (error) {
    if (ausente(error)) return { contratos: [], disponivel: false };
    console.error("Erro ao carregar honorários:", error.code, error.message);
    throw new Error("Não foi possível carregar os honorários.");
  }
  return { contratos: (data ?? []).map(normalizarContrato), disponivel: true };
}

export interface ParcelaComContrato extends Parcela {
  contrato: {
    id: string;
    tipo: TipoContrato;
    descricao: string;
    advogado_id: string;
    cancelado: boolean;
    ficha_id: string;
    ficha: { id: string; nome_cliente: string } | null;
  };
}

/** Parcelas de todos os contratos visíveis (RLS: sócio vê o escritório; titular, ele e a equipe). */
export async function buscarRecebiveis(): Promise<{ parcelas: ParcelaComContrato[]; disponivel: boolean }> {
  const { data, error } = await supabase
    .from("fin_parcelas")
    .select(`${COLUNAS_PARCELA},contrato:fin_contratos!inner(id,tipo,descricao,advogado_id,cancelado,ficha_id,ficha:fichas_clientes(id,nome_cliente))`)
    .eq("contrato.cancelado", false)
    .order("vencimento", { ascending: true })
    .limit(2000)
    .overrideTypes<ParcelaComContrato[], { merge: false }>();
  if (error) {
    if (ausente(error)) return { parcelas: [], disponivel: false };
    console.error("Erro ao carregar recebíveis:", error.code, error.message);
    throw new Error("Não foi possível carregar o financeiro.");
  }
  return {
    disponivel: true,
    parcelas: (data ?? []).map((p) => ({ ...p, valor: Number(p.valor), valor_pago: p.valor_pago === null ? null : Number(p.valor_pago) })),
  };
}

export interface NovoContrato {
  fichaId: string;
  advogadoId: string;
  tipo: TipoContrato;
  descricao: string;
  valorTotal: number | null;
  forma: FormaPagamento;
  percentualExito: number | null;
  observacoes: string | null;
  parcelas: { numero: number; valor: number; vencimento: string }[];
}

function erroFinanceiro(error: PostgrestError, padrao: string): Error {
  console.error("Erro no financeiro:", error.code, error.message);
  if (error.code === "PGRST202" || error.code === "42883" || ausente(error)) {
    return new Error("O financeiro exige a migração 20261119_v7_financeiro_documentos.sql no Supabase.");
  }
  if (error.hint === "crm_parcelas_soma") return new Error(error.message);
  if (error.hint === "crm_comprovante_invalido") return new Error("O comprovante precisa ser um documento desta ficha.");
  if (error.code === "42501" || error.code === "PGRST116") return new Error("Sem permissão para esta operação.");
  if (error.code === "23514") return new Error("Algum valor está inválido. Revise o formulário.");
  if (error.code === "23503") return new Error("Este registro está em uso e não pode ser excluído.");
  return new Error(padrao);
}

export async function criarContrato(d: NovoContrato): Promise<void> {
  const { error } = await supabase.rpc("crm_fin_criar_contrato", {
    p_ficha: d.fichaId,
    p_advogado: d.advogadoId,
    p_tipo: d.tipo,
    p_descricao: d.descricao,
    p_valor_total: d.valorTotal,
    p_forma: d.forma,
    p_percentual: d.percentualExito,
    p_observacoes: d.observacoes,
    p_parcelas: d.parcelas,
  });
  if (error) throw erroFinanceiro(error, "Não foi possível criar o contrato.");
}

export interface DadosPagamento {
  pago_em: string;
  valor_pago: number;
  meio: MeioPagamento;
  comprovante_id: string | null;
  observacao: string | null;
}

export async function registrarPagamento(parcelaId: string, d: DadosPagamento): Promise<void> {
  const { error } = await supabase.from("fin_parcelas").update(d).eq("id", parcelaId).select("id").single();
  if (error) throw erroFinanceiro(error, "Não foi possível registrar o pagamento.");
}

export async function desfazerPagamento(parcelaId: string): Promise<void> {
  const { error } = await supabase
    .from("fin_parcelas")
    .update({ pago_em: null, valor_pago: null, meio: null, comprovante_id: null })
    .eq("id", parcelaId)
    .select("id")
    .single();
  if (error) throw erroFinanceiro(error, "Não foi possível desfazer o pagamento.");
}

export async function cancelarContrato(id: string, cancelado: boolean): Promise<void> {
  const { error } = await supabase.from("fin_contratos").update({ cancelado }).eq("id", id).select("id").single();
  if (error) throw erroFinanceiro(error, "Não foi possível alterar o contrato.");
}

export async function excluirContrato(id: string): Promise<void> {
  const { data, error } = await supabase.from("fin_contratos").delete().eq("id", id).select("id");
  if (error) throw erroFinanceiro(error, "Não foi possível excluir o contrato.");
  if (!data || data.length === 0) throw new Error("Só titulares e sócios excluem contratos. Prefira cancelar.");
}

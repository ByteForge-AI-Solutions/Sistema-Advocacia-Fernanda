import type { PostgrestError } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase/client";
import type { EtapaFunil, MotivoPerda } from "@/lib/funil";

/**
 * Gestão de leads (migração 20261118_v5_leads_posvenda.sql), segundo o documento
 * "CRM de leads de anúncio": próxima ação obrigatória, prioridade por cor e regras de OAB/LGPD.
 */

// ---------- qualificação ----------

/** Dívida guardada em faixa (minimização LGPD), nunca em valor exato. */
export const FAIXAS_DIVIDA = ["ate_50k", "50k_100k", "100k_500k", "acima_500k"] as const;
export type FaixaDivida = (typeof FAIXAS_DIVIDA)[number];
export const FAIXA_LABEL: Record<FaixaDivida, string> = {
  ate_50k: "Até R$ 50 mil",
  "50k_100k": "De R$ 50 mil a R$ 100 mil",
  "100k_500k": "De R$ 100 mil a R$ 500 mil",
  acima_500k: "Acima de R$ 500 mil",
};

export const DORES = ["certidao", "bens", "execucao", "parcelamento", "outra"] as const;
export type DorPrincipal = (typeof DORES)[number];
export const DOR_LABEL: Record<DorPrincipal, string> = {
  certidao: "Precisa de certidão (licitação, financiamento, venda)",
  bens: "Risco aos bens",
  execucao: "Execução fiscal em andamento",
  parcelamento: "Parcelamento quebrado",
  outra: "Outra / urgência baixa",
};
/** Dores que tornam o lead quente (seção 4 do documento). */
const DORES_URGENTES: readonly DorPrincipal[] = ["certidao", "bens", "execucao"];

export const ONDE_DIVIDA = ["receita", "pgfn", "estado", "municipio", "justica"] as const;
export type OndeDivida = (typeof ONDE_DIVIDA)[number];
export const ONDE_LABEL: Record<OndeDivida, string> = {
  receita: "Receita Federal",
  pgfn: "PGFN (dívida ativa)",
  estado: "Estado",
  municipio: "Município",
  justica: "Justiça",
};

export interface QualificacaoLead {
  faixa_divida: FaixaDivida | null;
  bloqueio_penhora: boolean;
  dor_principal: DorPrincipal | null;
  onde_divida: OndeDivida[];
}

// ---------- prioridade automática por cor ----------

export const TEMPERATURAS = ["urgente", "quente", "morno", "frio"] as const;
export type Temperatura = (typeof TEMPERATURAS)[number];

export const TEMPERATURA_INFO: Record<
  Temperatura,
  { label: string; ponto: string; badge: string; regra: string; acao: string }
> = {
  urgente: {
    label: "Urgente",
    ponto: "bg-red-600",
    badge: "bg-red-600 text-white ring-red-600",
    regra: "Bloqueio de conta, penhora ou citação recebida",
    acao: "Responder na hora, inclusive no fim de semana; ligação no mesmo dia.",
  },
  quente: {
    label: "Quente",
    ponto: "bg-orange-500",
    badge: "bg-orange-50 text-orange-800 ring-orange-500/40",
    regra: "Acima de R$ 100 mil e dor de certidão, bens ou execução",
    acao: "Responder em até 15 minutos em horário comercial.",
  },
  morno: {
    label: "Morno",
    ponto: "bg-yellow-400",
    badge: "bg-yellow-50 text-yellow-800 ring-yellow-500/40",
    regra: "Acima de R$ 100 mil e urgência baixa (ou até R$ 100 mil com dor urgente)",
    acao: "Responder no mesmo dia; usar o custo de ficar parado.",
  },
  frio: {
    label: "Frio",
    ponto: "bg-slate-400",
    badge: "bg-slate-100 text-slate-700 ring-slate-400/40",
    regra: "Até R$ 100 mil e urgência baixa",
    acao: "Próximo dia útil, de manhã; filtrar na primeira pergunta.",
  },
};

export function isTemperatura(v: unknown): v is Temperatura {
  return typeof v === "string" && (TEMPERATURAS as readonly string[]).includes(v);
}

/**
 * Espelho de public.crm_temperatura_lead (migração v5); o banco é a fonte da verdade
 * e esta versão serve para a prévia ao vivo no formulário. Mantenha as duas iguais.
 */
export function calcularTemperatura(q: QualificacaoLead): Temperatura | null {
  if (q.bloqueio_penhora) return "urgente";
  if (!q.faixa_divida) return null;
  const acima = q.faixa_divida === "100k_500k" || q.faixa_divida === "acima_500k";
  const dorUrgente = q.dor_principal !== null && DORES_URGENTES.includes(q.dor_principal);
  let t: Temperatura = acima && dorUrgente ? "quente" : acima || dorUrgente ? "morno" : "frio";
  // Ajuste: dívida só na Receita e sem urgência desce uma cor.
  if (t === "morno" && !dorUrgente && q.onde_divida.length === 1 && q.onde_divida[0] === "receita") t = "frio";
  return t;
}

// ---------- próxima ação ----------

export type SituacaoAcao = "sem" | "vencida" | "hoje" | "futura";

export function situacaoProximaAcao(
  f: { proxima_acao_em: string | null; ativo: boolean },
  agora = new Date(),
): SituacaoAcao | null {
  if (!f.ativo) return null;
  if (!f.proxima_acao_em) return "sem";
  const d = new Date(f.proxima_acao_em);
  if (d.getTime() < agora.getTime()) return "vencida";
  return d.toDateString() === agora.toDateString() ? "hoje" : "futura";
}

// ---------- LGPD: CPF/CNPJ fora de textos livres ----------

function cpfValido(d: string): boolean {
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const dv = (base: string, pesoIni: number) => {
    const soma = [...base].reduce((s, c, i) => s + Number(c) * (pesoIni - i), 0);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(d.slice(0, 9), 10) === Number(d[9]) && dv(d.slice(0, 10), 11) === Number(d[10]);
}

function cnpjValido(d: string): boolean {
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  const dv = (base: string) => {
    const pesos = base.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const r = [...base].reduce((s, c, i) => s + Number(c) * pesos[i], 0) % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return dv(d.slice(0, 12)) === Number(d[12]) && dv(d.slice(0, 13)) === Number(d[13]);
}

/**
 * true se o texto contém um CPF ou CNPJ válido (com ou sem pontuação).
 * Usado para barrar documentos em campos que aparecem em listas, agenda e etiquetas.
 */
export function contemDocumentoPessoal(texto: string): boolean {
  if (/\d{3}\.\d{3}\.\d{3}-\d{2}/.test(texto) || /\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/.test(texto)) return true;
  const trechos = texto.match(/[\d./-]{11,18}/g) ?? [];
  return trechos.some((t) => {
    const d = t.replace(/\D/g, "");
    return cpfValido(d) || cnpjValido(d);
  });
}

export const AVISO_DOCUMENTO =
  "Não registre CPF ou CNPJ neste campo: ele aparece em listas e na agenda (LGPD). Use a ficha do cliente.";

/** "123.456.789-09" → "***.456.789-**"; CNPJ → "**.***.678/0001-**". */
export function mascararDocumento(valor: string | null): string {
  const d = (valor ?? "").replace(/\D/g, "");
  if (d.length === 11) return `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`;
  if (d.length === 14) return `**.***.${d.slice(5, 8)}/${d.slice(8, 12)}-**`;
  return d ? "***" : "";
}

// ---------- simulação (OAB: sempre exemplo, nunca resultado) ----------

export const AVISO_SIMULACAO =
  "Exemplo ilustrativo, calculado só no seu navegador e não salvo. Não é promessa de resultado: " +
  "desconto sempre \"até\" e \"depende da análise\". Use na conversa ou ligação; não envie valores ou percentuais por escrito.";

export interface Simulacao {
  valorComDesconto: number;
  parcela: number;
}

/** Exemplo de parcelamento: valor × (1 − desconto máximo) ÷ parcelas. */
export function simularExemplo(valor: number, descontoAte: number, parcelas: number): Simulacao | null {
  if (!(valor > 0) || !(descontoAte >= 0 && descontoAte < 100) || !Number.isInteger(parcelas) || parcelas < 1 || parcelas > 145) {
    return null;
  }
  const valorComDesconto = valor * (1 - descontoAte / 100);
  return { valorComDesconto, parcela: valorComDesconto / parcelas };
}

// ---------- gravação ----------

export interface DadosLead extends QualificacaoLead {
  /** Sem a v6. Com a v6, o status acompanha a etapa (trigger crm_fichas_lead). */
  status_atendimento?: string;
  /** Campos do funil (migração v6). */
  etapa_funil?: EtapaFunil;
  motivo_perda?: MotivoPerda | null;
  motivo_perda_detalhe?: string | null;
  nao_contatar?: boolean;
  proxima_acao: string | null;
  /** ISO 8601. */
  proxima_acao_em: string | null;
}

function mensagemErro(error: PostgrestError): string {
  if (error.hint === "crm_proxima_acao_obrigatoria") return "Lead ativo precisa de próxima ação e data (regra de ouro).";
  if (error.hint === "crm_dado_pessoal") return AVISO_DOCUMENTO;
  if (`${error.message} ${error.details ?? ""}`.includes("fichas_perdido_exige_motivo")) return "Informe o motivo de perda para mover o lead para Perdido.";
  if (["42703", "PGRST204"].includes(error.code)) {
    return "Os campos de lead exigem a migração 20261118_v5_leads_posvenda.sql no Supabase.";
  }
  if (error.code === "PGRST116" || error.code === "42501") return "Ficha não encontrada ou sem permissão para editar.";
  if (error.code === "23514") return "Algum campo está com valor inválido. Revise o formulário.";
  return "Não foi possível salvar a ficha. Verifique sua conexão e tente novamente.";
}

/** Atualiza a ficha. O RLS (pode_acessar_ficha) e o trigger crm_fichas_lead validam no banco. */
export async function salvarLead(fichaId: string, dados: DadosLead): Promise<void> {
  const { error } = await supabase.from("fichas_clientes").update(dados).eq("id", fichaId).select("id").single();
  if (error) {
    console.error("Erro ao salvar lead:", error.code, error.message);
    throw new Error(mensagemErro(error));
  }
}

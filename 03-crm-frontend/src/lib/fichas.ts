import { supabase } from "@/lib/supabase/client";
import { buscarEstagiariosSupervisionados, type Advogado } from "@/lib/advogados";

export const PRIORIDADES = ["alta", "media", "baixa"] as const;
export type Prioridade = (typeof PRIORIDADES)[number];

export const PRIORIDADE_LABEL: Record<Prioridade, string> = {
  alta: "Alta",
  media: "Média",
  baixa: "Baixa",
};

export const STATUS_ATENDIMENTO = ["novo", "em_analise", "agendado", "finalizado"] as const;
export type StatusAtendimento = (typeof STATUS_ATENDIMENTO)[number];

export const STATUS_LABEL: Record<StatusAtendimento, string> = {
  novo: "Novo",
  em_analise: "Em análise",
  agendado: "Agendado",
  finalizado: "Finalizado",
};

export interface Ficha {
  id: string;
  nome_cliente: string;
  telefone: string;
  area_identificada: string;
  /** Normalizada; null quando o valor do banco não é reconhecido. */
  prioridade: Prioridade | null;
  motivo_prioridade: string | null;
  resumo_fatos: string;
  qtd_documentos: number;
  qtd_processos: number;
  advogado_id: string;
  /** Normalizado; null quando o valor do banco não é um dos 4 status conhecidos. */
  status: StatusAtendimento | null;
  status_original: string;
  created_at: string;
  /** Preenchido quando a ficha está com um estagiário supervisionado pelo usuário logado. */
  estagiario: { id: string; nome: string } | null;
}

interface FichaRow {
  id: string;
  nome_cliente: string;
  telefone: string;
  area_identificada: string;
  prioridade: string | null;
  motivo_prioridade: string | null;
  resumo_fatos: string;
  documentos_urls: string[] | null;
  processos_encontrados: unknown;
  advogado_id: string;
  status_atendimento: string | null;
  created_at: string;
}

/** "Média", "MEDIA", " media " → "media". O bot pode gravar com acento ou maiúscula. */
export function normalizar(valor: string | null | undefined): string {
  return (valor ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

export function paraPrioridade(valor: string | null): Prioridade | null {
  const v = normalizar(valor);
  return (PRIORIDADES as readonly string[]).includes(v) ? (v as Prioridade) : null;
}

function paraStatus(valor: string | null): StatusAtendimento | null {
  const v = normalizar(valor || "novo");
  return (STATUS_ATENDIMENTO as readonly string[]).includes(v) ? (v as StatusAtendimento) : null;
}

const PESO_PRIORIDADE: Record<Prioridade, number> = { alta: 0, media: 1, baixa: 2 };

/** Fila: alta → média → baixa (desconhecida por último); empate pela chegada, mais antiga primeiro. */
export function ordenarFila(fichas: Ficha[]): Ficha[] {
  return [...fichas].sort((a, b) => {
    const pa = a.prioridade ? PESO_PRIORIDADE[a.prioridade] : 3;
    const pb = b.prioridade ? PESO_PRIORIDADE[b.prioridade] : 3;
    if (pa !== pb) return pa - pb;
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });
}

/**
 * Busca a fila visível para o usuário logado:
 * - titular: fichas dele + fichas dos estagiários que ele supervisiona;
 * - estagiário: só as fichas atribuídas a ele.
 * O RLS no banco aplica a mesma regra; este filtro só evita depender dele para montar a tela.
 */
export async function buscarFichas(perfil: Advogado): Promise<Ficha[]> {
  const estagiarios = await buscarEstagiariosSupervisionados(perfil);
  const idsResponsaveis = [perfil.id, ...estagiarios.map((e) => e.id)];
  const estagiarioPorId = new Map(estagiarios.map((e) => [e.id, e]));

  // CPF fica fora da listagem (minimização de dados, LGPD).
  const { data, error } = await supabase
    .from("fichas_clientes")
    .select(
      "id, nome_cliente, telefone, area_identificada, prioridade, motivo_prioridade, resumo_fatos, documentos_urls, processos_encontrados, advogado_id, status_atendimento, created_at",
    )
    .in("advogado_id", idsResponsaveis)
    .overrideTypes<FichaRow[], { merge: false }>();

  if (error) throw new Error(error.message);

  const fichas: Ficha[] = (data ?? []).map((row) => ({
    id: row.id,
    nome_cliente: row.nome_cliente,
    telefone: row.telefone,
    area_identificada: row.area_identificada,
    prioridade: paraPrioridade(row.prioridade),
    motivo_prioridade: row.motivo_prioridade,
    resumo_fatos: row.resumo_fatos,
    qtd_documentos: row.documentos_urls?.length ?? 0,
    qtd_processos: Array.isArray(row.processos_encontrados) ? row.processos_encontrados.length : 0,
    advogado_id: row.advogado_id,
    status: paraStatus(row.status_atendimento),
    status_original: row.status_atendimento ?? "novo",
    created_at: row.created_at,
    estagiario: estagiarioPorId.get(row.advogado_id) ?? null,
  }));

  return ordenarFila(fichas);
}

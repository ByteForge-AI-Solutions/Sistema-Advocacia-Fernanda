import { supabase } from "@/lib/supabase/client";
import { buscarEquipeVisivel, ehSocio, ehTitular, type Advogado, type MembroEquipe } from "@/lib/advogados";
import {
  DORES,
  FAIXAS_DIVIDA,
  ONDE_DIVIDA,
  isTemperatura,
  type DorPrincipal,
  type FaixaDivida,
  type OndeDivida,
  type Temperatura,
} from "@/lib/leads";
import { FUNIL_INDISPONIVEL, isEtapa, isMotivoPerda, type FunilFicha } from "@/lib/funil";

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
  /** null = sem responsável (visível a titulares da área e a sócios, que podem assumir). */
  advogado_id: string | null;
  /** Normalizado; null quando o valor do banco não é um dos 4 status conhecidos. */
  status: StatusAtendimento | null;
  status_original: string;
  created_at: string;
  /** Preenchido quando a ficha está com um estagiário (supervisionado pelo usuário ou, para sócios, de qualquer titular). */
  estagiario: { id: string; nome: string } | null;
  /** Responsável quando não é o usuário logado (estagiário ou, para sócios, outro titular). */
  responsavel: MembroEquipe | null;
  /** Campos de lead (migração v5). Ficam vazios/false se a migração ainda não foi aplicada. */
  lead: LeadFicha;
  /** Etapa do funil e cadência (migração v6). disponivel = false sem a migração. */
  funil: FunilFicha;
}

export interface LeadFicha {
  /** false = banco sem a migração v5 (campos indisponíveis). */
  disponivel: boolean;
  proxima_acao: string | null;
  proxima_acao_em: string | null;
  faixa_divida: FaixaDivida | null;
  bloqueio_penhora: boolean;
  dor_principal: DorPrincipal | null;
  onde_divida: OndeDivida[];
  /** Calculada pelo banco (crm_temperatura_lead). */
  temperatura: Temperatura | null;
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
  advogado_id: string | null;
  status_atendimento: string | null;
  created_at: string;
  proxima_acao?: string | null;
  proxima_acao_em?: string | null;
  faixa_divida?: string | null;
  bloqueio_penhora?: boolean | null;
  dor_principal?: string | null;
  onde_divida?: string[] | null;
  temperatura?: string | null;
  etapa_funil?: string | null;
  etapa_desde?: string | null;
  motivo_perda?: string | null;
  motivo_perda_detalhe?: string | null;
  cadencia_desde?: string | null;
  nao_contatar?: boolean | null;
}

const COLUNAS_BASE =
  "id, nome_cliente, telefone, area_identificada, prioridade, motivo_prioridade, resumo_fatos, documentos_urls, processos_encontrados, advogado_id, status_atendimento, created_at";
const COLUNAS_LEAD = "proxima_acao, proxima_acao_em, faixa_divida, bloqueio_penhora, dor_principal, onde_divida, temperatura";
const COLUNAS_FUNIL = "etapa_funil, etapa_desde, motivo_perda, motivo_perda_detalhe, cadencia_desde, nao_contatar";

function paraFunil(row: FichaRow, disponivel: boolean): FunilFicha {
  if (!disponivel) return FUNIL_INDISPONIVEL;
  return {
    disponivel: true,
    etapa: isEtapa(row.etapa_funil) ? row.etapa_funil : "novo_lead",
    etapa_desde: row.etapa_desde ?? null,
    motivo_perda: isMotivoPerda(row.motivo_perda) ? row.motivo_perda : null,
    motivo_perda_detalhe: row.motivo_perda_detalhe ?? null,
    cadencia_desde: row.cadencia_desde ?? null,
    nao_contatar: row.nao_contatar === true,
  };
}

const daLista = <T extends string>(lista: readonly T[], v: unknown): T | null =>
  typeof v === "string" && (lista as readonly string[]).includes(v) ? (v as T) : null;

function paraLead(row: FichaRow, disponivel: boolean): LeadFicha {
  return {
    disponivel,
    proxima_acao: row.proxima_acao ?? null,
    proxima_acao_em: row.proxima_acao_em ?? null,
    faixa_divida: daLista(FAIXAS_DIVIDA, row.faixa_divida),
    bloqueio_penhora: row.bloqueio_penhora === true,
    dor_principal: daLista(DORES, row.dor_principal),
    onde_divida: (row.onde_divida ?? []).flatMap((o) => (daLista(ONDE_DIVIDA, o) ? [o as OndeDivida] : [])),
    temperatura: isTemperatura(row.temperatura) ? row.temperatura : null,
  };
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
/** Urgente acima de tudo; quente/morno/frio se alinham a alta/média/baixa do bot. */
const PESO_TEMPERATURA: Record<Temperatura, number> = { urgente: 0, quente: 1, morno: 2, frio: 3 };

/**
 * Nível de atendimento (menor = antes). Com a temperatura do lead (migração v5) ela manda;
 * sem ela, vale a prioridade do bot (alta → 1, média → 2, baixa → 3). Desconhecida: 4.
 */
export function nivelAtendimento(f: Pick<Ficha, "prioridade" | "lead">): number {
  if (f.lead.temperatura) return PESO_TEMPERATURA[f.lead.temperatura];
  return f.prioridade ? PESO_PRIORIDADE[f.prioridade] + 1 : 4;
}

/**
 * Fila: nível de atendimento (urgente → quente/alta → morno/média → frio/baixa → desconhecida);
 * empate pela prioridade do bot e depois pela chegada, mais antiga primeiro.
 */
export function ordenarFila(fichas: Ficha[]): Ficha[] {
  return [...fichas].sort((a, b) => {
    const na = nivelAtendimento(a);
    const nb = nivelAtendimento(b);
    if (na !== nb) return na - nb;
    const pa = a.prioridade ? PESO_PRIORIDADE[a.prioridade] : 3;
    const pb = b.prioridade ? PESO_PRIORIDADE[b.prioridade] : 3;
    if (pa !== pb) return pa - pb;
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });
}

/**
 * Busca a fila visível para o usuário logado:
 * - sócio: todas as fichas do escritório (o RLS exclui as de contas 'desenvolvedor');
 * - titular: fichas dele + dos estagiários que supervisiona + sem responsável da área dele;
 * - estagiário/desenvolvedor: só as fichas atribuídas a ele.
 * O RLS no banco aplica a mesma regra; este filtro só evita depender dele para montar a tela.
 */
export async function buscarFichas(perfil: Advogado): Promise<Ficha[]> {
  const equipe = await buscarEquipeVisivel(perfil);
  const membroPorId = new Map(equipe.map((m) => [m.id, m]));
  const idsResponsaveis = equipe.map((m) => m.id);

  // CPF fica fora da listagem (minimização de dados, LGPD).
  const consultar = (colunas: string) => {
    let consulta = supabase.from("fichas_clientes").select(colunas);
    if (!ehSocio(perfil)) {
      consulta = ehTitular(perfil.cargo)
        ? consulta.or(`advogado_id.in.(${idsResponsaveis.join(",")}),advogado_id.is.null`)
        : consulta.in("advogado_id", idsResponsaveis);
    }
    return consulta.overrideTypes<FichaRow[], { merge: false }>();
  };

  // Do mais completo ao mais simples: sem a v6 (funil) ou a v5 (lead), a coluna não existe
  // (42703) e a fila continua funcionando com o que houver.
  let leadDisponivel = true;
  let funilDisponivel = true;
  let { data, error } = await consultar(`${COLUNAS_BASE}, ${COLUNAS_LEAD}, ${COLUNAS_FUNIL}`);
  if (error?.code === "42703") {
    funilDisponivel = false;
    ({ data, error } = await consultar(`${COLUNAS_BASE}, ${COLUNAS_LEAD}`));
  }
  if (error?.code === "42703") {
    leadDisponivel = false;
    ({ data, error } = await consultar(COLUNAS_BASE));
  }

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
    ...vinculo(row.advogado_id, perfil.id, membroPorId),
    lead: paraLead(row, leadDisponivel),
    funil: paraFunil(row, funilDisponivel && leadDisponivel),
  }));

  return ordenarFila(fichas);
}

/** Responsável (quando não é o usuário) e, se for estagiário, a etiqueta de supervisão. */
function vinculo(
  advogadoId: string | null,
  meuId: string,
  membroPorId: Map<string, MembroEquipe>,
): Pick<Ficha, "estagiario" | "responsavel"> {
  if (!advogadoId || advogadoId === meuId) return { estagiario: null, responsavel: null };
  const membro = membroPorId.get(advogadoId) ?? { id: advogadoId, nome: "Outro responsável" };
  return {
    responsavel: membro,
    estagiario: membro.cargo === "estagiario" ? { id: membro.id, nome: membro.nome } : null,
  };
}

/** Titular/sócio assume uma ficha sem responsável (RPC crm_ficha_assumir, migração v4). */
export async function assumirFicha(fichaId: string): Promise<void> {
  const { error } = await supabase.rpc("crm_ficha_assumir", { p_ficha: fichaId });
  if (!error) return;
  console.error("Erro ao assumir ficha:", error.code, error.message);
  if (error.code === "PGRST202" || error.code === "42883") {
    throw new Error("Assumir fichas exige a migração 20261118_v4_cargo_socio.sql no Supabase.");
  }
  if (error.hint === "crm_estado_invalido") throw new Error("Esta ficha já tem responsável. Atualize a fila.");
  throw new Error("Não foi possível assumir a ficha. Confira se ela é da sua área.");
}

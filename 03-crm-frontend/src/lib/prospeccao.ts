import { FunctionsFetchError, FunctionsHttpError, FunctionsRelayError } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase/client";
import type { Cargo } from "@/lib/advogados";

/**
 * Prospecção de execuções fiscais (migração 20261123_v11_prospeccao_execucoes.sql).
 *
 * - Leitura: view prosp_oportunidades (security_invoker; RLS libera só sócio e advogado).
 *   As regras de negócio (Fazenda Nacional, só CNPJ, valor > R$ 100 mil) estão no banco.
 * - Busca e processamento: Edge Function "prospeccao-execucoes" (DataJud, DJEN e base de CNPJ
 *   rodam no servidor; nenhuma chave nem URL externa passa pelo navegador).
 * - Exportação: CSV gerado no navegador, com registro em prosp_auditoria (LGPD).
 */

export const TRIBUNAIS_PROSPECCAO = ["TRF1", "TRF3", "TRF4"] as const;
export type TribunalProspeccao = (typeof TRIBUNAIS_PROSPECCAO)[number];
export const VALOR_MINIMO_PROSPECCAO = 100_000;
/** Teto de linhas por exportação (a exportação fica registrada na auditoria). */
export const MAX_EXPORTACAO = 5_000;
const POR_PAGINA = 200;

/** Quem usa a tela (o RLS e a Edge conferem de novo no servidor). */
export function podeProspectar(cargo: Cargo): boolean {
  return cargo === "socio" || cargo === "advogado";
}

export type OrigemOportunidade = "processo" | "pgfn";
export const ORIGEM_LABEL: Record<OrigemOportunidade, string> = {
  processo: "Processo (DataJud + DJEN)",
  pgfn: "Dívida ativa (PGFN)",
};
export const VALOR_FONTE_LABEL: Record<string, string> = {
  datajud: "valor da causa (DataJud)",
  djen: "valor da causa (publicação no DJEN)",
  pgfn: "dívida ativa consolidada (PGFN)",
};

export interface Oportunidade {
  origem: OrigemOportunidade;
  chave: string;
  cnpj: string;
  nome: string | null;
  data_distribuicao: string | null;
  polo_ativo: string | null;
  numero_processo: string | null;
  tribunal: TribunalProspeccao | null;
  valor_causa: number;
  valor_fonte: string | null;
  classe: string | null;
  telefone: string | null;
  email: string | null;
  situacao_cadastral: string | null;
  uf: string | null;
  /** CNPJ já conferido na base da Receita (natureza conhecida). Ausente se a v11 for antiga. */
  cadastro_verificado?: boolean;
}

export interface FiltrosProspeccao {
  tribunais: TribunalProspeccao[];
  origem: "todas" | OrigemOportunidade;
  /** "AAAA-MM-DD" ou "" (sem filtro). Com período, só entram processos (a PGFN não tem data). */
  de: string;
  ate: string;
  valorMinimo: number;
  busca: string;
}

export const FILTROS_PADRAO: FiltrosProspeccao = {
  tribunais: [...TRIBUNAIS_PROSPECCAO],
  origem: "todas",
  de: "",
  ate: "",
  valorMinimo: VALOR_MINIMO_PROSPECCAO,
  busca: "",
};

const COLUNAS_BASE =
  "origem, chave, cnpj, nome, data_distribuicao, polo_ativo, numero_processo, tribunal, valor_causa, valor_fonte, classe, telefone, email, situacao_cadastral, uf";
/** Coluna da versão atual da view; sem ela (v11 antiga aplicada), a consulta é refeita sem. */
const COLUNAS = `${COLUNAS_BASE}, cadastro_verificado`;

/** Busca de nome sem curingas do usuário (% e _ viram literais). */
function termoNome(texto: string): string {
  return texto.trim().slice(0, 100).replace(/[\\%_]/g, (c) => `\\${c}`);
}

function consulta(f: FiltrosProspeccao, colunas = COLUNAS) {
  let q = supabase.from("prosp_oportunidades").select(colunas);
  const tribunais = f.tribunais.filter((t) => (TRIBUNAIS_PROSPECCAO as readonly string[]).includes(t));
  q = q.in("tribunal", tribunais.length ? tribunais : [...TRIBUNAIS_PROSPECCAO]);
  if (f.origem !== "todas") q = q.eq("origem", f.origem);
  if (/^\d{4}-\d{2}-\d{2}$/.test(f.de)) q = q.gte("data_distribuicao", f.de);
  if (/^\d{4}-\d{2}-\d{2}$/.test(f.ate)) q = q.lte("data_distribuicao", f.ate);
  q = q.gt("valor_causa", Math.max(Number.isFinite(f.valorMinimo) ? f.valorMinimo : 0, VALOR_MINIMO_PROSPECCAO));
  const termo = f.busca.trim();
  const digitos = termo.replace(/\D/g, "");
  if (termo && /^[\d.\-/\s]+$/.test(termo) && digitos.length === 14) q = q.eq("cnpj", digitos);
  else if (termo && /^[\d.\-/\s]+$/.test(termo) && digitos.length === 20) q = q.eq("numero_processo", digitos);
  else if (termo) q = q.ilike("nome", `%${termoNome(termo)}%`);
  return q.order("valor_causa", { ascending: false }).order("chave", { ascending: true });
}

export async function buscarOportunidades(
  f: FiltrosProspeccao,
  pagina = 0,
): Promise<{ linhas: Oportunidade[]; temMais: boolean; disponivel: boolean }> {
  const inicio = pagina * POR_PAGINA;
  let { data, error } = await consulta(f).range(inicio, inicio + POR_PAGINA);
  // 42703: a view é da primeira versão da v11 (sem cadastro_verificado). Reaplique a v11.
  if (error?.code === "42703") ({ data, error } = await consulta(f, COLUNAS_BASE).range(inicio, inicio + POR_PAGINA));
  if (error) {
    // 42P01: a migração v11 ainda não foi aplicada.
    if (error.code === "42P01" || error.code === "PGRST205") return { linhas: [], temMais: false, disponivel: false };
    throw new Error("Não foi possível carregar a prospecção.");
  }
  const linhas = (data ?? []) as unknown as Oportunidade[];
  return { linhas: linhas.slice(0, POR_PAGINA).map(normalizar), temMais: linhas.length > POR_PAGINA, disponivel: true };
}

function normalizar(o: Oportunidade): Oportunidade {
  return { ...o, valor_causa: Number(o.valor_causa) };
}

/** Quantos processos estão em cada etapa da fila (painel "Fila de processamento"). */
export type SituacaoFila = "pendente" | "qualificado" | "sem_publicacao" | "sem_cnpj" | "fora_do_filtro" | "erro";
export const SITUACAO_LABEL: Record<SituacaoFila, string> = {
  pendente: "Aguardando DJEN",
  qualificado: "Qualificados (Fazenda + CNPJ)",
  sem_publicacao: "Sem publicação no DJEN (nova tentativa agendada)",
  sem_cnpj: "Fazenda, mas CNPJ não publicado",
  fora_do_filtro: "Fora do filtro (outro exequente ou MEI)",
  erro: "Resposta fora do padrão (nova tentativa em 1 h)",
};

export async function resumoFila(): Promise<Record<SituacaoFila, number> | null> {
  const situacoes = Object.keys(SITUACAO_LABEL) as SituacaoFila[];
  const contagens = await Promise.all(
    situacoes.map((s) => supabase.from("prosp_processos").select("id", { count: "exact", head: true }).eq("situacao", s)),
  );
  if (contagens.some((c) => c.error)) return null;
  return Object.fromEntries(situacoes.map((s, i) => [s, contagens[i].count ?? 0])) as Record<SituacaoFila, number>;
}

// ---------------------------------------------------------------- Edge Function

export type CodigoAviso =
  | "datajud_chave_recusada"
  | "datajud_sem_chave"
  | "datajud_sobrecarga"
  | "djen_indisponivel"
  | "cnpj_indisponivel"
  | "tempo_esgotado";

export interface AvisoExecucao {
  codigo: CodigoAviso;
  gravidade: "erro" | "alerta";
  /** Texto do servidor, já em linguagem de usuário (pode conter `comando`). */
  mensagem: string;
}

export type FimBuscaTribunal = "fim" | "limite" | "tempo" | "sobrecarga" | "chave_recusada" | "sem_chave";

export interface ResultadoExecucao {
  novos: number;
  porTribunal: Partial<Record<TribunalProspeccao, { recebidos: number; novos: number; fim: FimBuscaTribunal }>>;
  consultados: number;
  qualificados: number;
  semPublicacao: number;
  semCnpj: number;
  foraDoFiltro: number;
  erros: number;
  /** Processos devolvidos à fila porque a fonte estava fora do ar (sem gastar tentativa). */
  reagendados: number;
  cnpjsEnriquecidos: number;
  fontesIndisponiveis: string[];
  tempoEsgotado: boolean;
  avisos: AvisoExecucao[];
  pendentes: number | null;
}

/** Falha da chamada inteira (nada executado, ou execução interrompida). */
export class ErroProspeccao extends Error {
  /** Segundos até poder chamar de novo (limite de 6 por minuto). */
  aguardeSegundos: number | null;
  /** Parte do trabalho que chegou a ser salva antes da falha, se o servidor informou. */
  parcial: Partial<ResultadoExecucao> | null;
  constructor(mensagem: string, aguardeSegundos: number | null = null, parcial: Partial<ResultadoExecucao> | null = null) {
    super(mensagem);
    this.aguardeSegundos = aguardeSegundos;
    this.parcial = parcial;
  }
}

async function chamarEdge(corpo: Record<string, unknown>): Promise<ResultadoExecucao> {
  const { data, error } = await supabase.functions.invoke("prospeccao-execucoes", { body: corpo });
  if (!error) {
    const r = data as ResultadoExecucao;
    return { ...r, avisos: Array.isArray(r.avisos) ? r.avisos : [], porTribunal: r.porTribunal ?? {} };
  }
  if (error instanceof FunctionsHttpError) {
    const resposta = error.context as Response;
    const j = (await resposta.json().catch(() => null)) as (Partial<ResultadoExecucao> & { erro?: unknown; aguardeSegundos?: unknown }) | null;
    const espera = Number(j?.aguardeSegundos ?? resposta.headers.get("retry-after"));
    const aguarde = Number.isFinite(espera) && espera > 0 ? Math.min(espera, 300) : null;
    if (typeof j?.erro === "string") throw new ErroProspeccao(j.erro.slice(0, 400), aguarde, j);
    // Sem corpo JSON: tempo limite do gateway (504/546) ou função não implantada (404).
    if (resposta.status === 404) {
      throw new ErroProspeccao("A Edge Function prospeccao-execucoes não está implantada neste projeto (supabase functions deploy prospeccao-execucoes).");
    }
    if (resposta.status === 504 || resposta.status === 546) {
      throw new ErroProspeccao("A execução passou do tempo limite. O que já foi processado está salvo; clique em \"Processar fila\" para continuar.");
    }
    throw new ErroProspeccao(`O serviço de prospecção respondeu com erro (HTTP ${resposta.status}). Tente de novo em alguns minutos.`, aguarde);
  }
  if (error instanceof FunctionsRelayError || error instanceof FunctionsFetchError) {
    throw new ErroProspeccao(
      "A conexão com o serviço de prospecção caiu antes da resposta. O que já foi processado está salvo; " +
        "atualize a lista e, se preciso, clique em \"Processar fila\". Se persistir, confira se a Edge Function foi implantada e se CRM_ORIGENS inclui este endereço.",
    );
  }
  throw new ErroProspeccao("Não foi possível falar com o serviço de prospecção.");
}

export function buscarNovosProcessos(p: { tribunais: TribunalProspeccao[]; de: string; ate: string; limite: number }) {
  return chamarEdge({ acao: "buscar", tribunais: p.tribunais, de: p.de, ate: p.ate, limite: p.limite });
}

export function processarFila() {
  return chamarEdge({ acao: "processar" });
}

// ---------------------------------------------------------------- CSV

/** Colunas pedidas pelos advogados, nesta ordem e com estes nomes. */
export const COLUNAS_CSV = [
  "CPF/CNPJ",
  "nome",
  "data da distribuição",
  "polo ativo",
  "número do processo",
  "tribunal",
  "valor da causa",
  "classe",
  "telefone",
  "e-mail",
] as const;
/** Separador ";" e decimal com vírgula: abre direto no Excel em português. */
const SEPARADOR = ";";

export function formatarCnpj(d: string): string {
  return /^\d{14}$/.test(d) ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5") : d;
}
export function formatarCnj(d: string | null): string {
  return d && /^\d{20}$/.test(d) ? d.replace(/^(\d{7})(\d{2})(\d{4})(\d)(\d{2})(\d{4})$/, "$1-$2.$3.$4.$5.$6") : (d ?? "");
}
export function formatarData(iso: string | null): string {
  return iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "";
}

/**
 * Anti "CSV injection" (OWASP): célula que começa com = + - @ TAB ou CR vira texto no
 * Excel/Sheets (prefixo '), senão o nome de uma empresa poderia virar fórmula.
 */
export function neutralizarFormula(valor: string): string {
  return /^[=+\-@\t\r]/.test(valor) ? `'${valor}` : valor;
}

function celula(valor: string): string {
  const v = neutralizarFormula(valor.replace(/[\r\n]+/g, " ").trim());
  return /[";\n]/.test(v) || v !== valor ? `"${v.replace(/"/g, '""')}"` : v;
}

export function gerarCsv(linhas: Oportunidade[]): string {
  const valor = (n: number) => n.toFixed(2).replace(".", ",");
  const corpo = linhas.map((o) =>
    [
      formatarCnpj(o.cnpj),
      o.nome ?? "",
      formatarData(o.data_distribuicao),
      o.polo_ativo ?? "",
      formatarCnj(o.numero_processo),
      o.tribunal ?? "",
      valor(o.valor_causa),
      o.classe ?? "",
      o.telefone ?? "",
      o.email ?? "",
    ]
      .map(celula)
      .join(SEPARADOR),
  );
  // BOM UTF-8: o Excel reconhece acentos; CRLF é o fim de linha do RFC 4180.
  return "﻿" + [COLUNAS_CSV.join(SEPARADOR), ...corpo].join("\r\n") + "\r\n";
}

/** Carrega todas as linhas do filtro (até MAX_EXPORTACAO), em páginas. */
export async function carregarParaExportar(f: FiltrosProspeccao): Promise<{ linhas: Oportunidade[]; cortado: boolean }> {
  const linhas: Oportunidade[] = [];
  for (let pagina = 0; linhas.length < MAX_EXPORTACAO; pagina++) {
    const r = await buscarOportunidades(f, pagina);
    linhas.push(...r.linhas);
    if (!r.temMais) return { linhas, cortado: false };
  }
  return { linhas: linhas.slice(0, MAX_EXPORTACAO), cortado: true };
}

/** Registra a exportação (quem, quando, filtros, quantidade). A autoria vem do JWT no banco. */
export async function registrarExportacao(f: FiltrosProspeccao, quantidade: number): Promise<void> {
  const { error } = await supabase.from("prosp_auditoria").insert({
    acao: "exportacao",
    parametros: {
      tribunais: f.tribunais,
      origem: f.origem,
      de: f.de || null,
      ate: f.ate || null,
      valor_minimo: f.valorMinimo,
      com_busca: Boolean(f.busca.trim()),
    },
    qtd_registros: quantidade,
  });
  if (error) throw new Error("Não foi possível registrar a exportação; o arquivo não foi gerado.");
}

export function baixarArquivo(conteudo: string, nome: string): void {
  const url = URL.createObjectURL(new Blob([conteudo], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = nome;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

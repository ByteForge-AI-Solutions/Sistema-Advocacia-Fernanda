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

/**
 * Categorias (migração v5, seção 8 "pós-venda" do documento de leads). Antes da v5 tudo é
 * 'processual'. janelaAlerta = dias de antecedência em que o item passa a "urgente".
 */
export const CATEGORIAS_PRAZO = ["processual", "execucao_fiscal", "embargos", "parcela", "certidao", "outro"] as const;
export type CategoriaPrazo = (typeof CATEGORIAS_PRAZO)[number];

export const CATEGORIA_INFO: Record<
  CategoriaPrazo,
  { label: string; curto: string; exigeCnj: boolean; janelaAlerta: number; dica: string; diasPadrao?: number }
> = {
  processual: { label: "Prazo processual", curto: "Processual", exigeCnj: true, janelaAlerta: 2, dica: "Prazo processual comum." },
  execucao_fiscal: {
    label: "Citação em execução fiscal",
    curto: "Execução fiscal",
    exigeCnj: true,
    janelaAlerta: 2,
    diasPadrao: 5,
    dica: "Citado, o executado tem 5 dias para pagar ou garantir a execução (LEF, art. 8º). Confira a contagem aplicável.",
  },
  embargos: {
    label: "Embargos à execução (garantia do juízo)",
    curto: "Embargos",
    exigeCnj: true,
    janelaAlerta: 5,
    diasPadrao: 30,
    dica: "Garantido o juízo, abre-se o prazo de 30 dias para embargos (LEF, art. 16). Confira o termo inicial e a contagem.",
  },
  parcela: {
    label: "Parcela de acordo / parcelamento",
    curto: "Parcela",
    exigeCnj: false,
    janelaAlerta: 5,
    dica: "Alerta 5 dias antes para enviar a guia. Atraso de 3 parcelas seguidas ou 6 alternadas pode rescindir o acordo (confira a regra da modalidade).",
  },
  certidao: {
    label: "Validade de certidão",
    curto: "Certidão",
    exigeCnj: false,
    janelaAlerta: 15,
    diasPadrao: 180,
    dica: "Alerta 15 dias antes de vencer. A certidão federal (CND/CPEN) vale 180 dias.",
  },
  outro: { label: "Outro controle", curto: "Outro", exigeCnj: false, janelaAlerta: 2, dica: "Controle operacional livre." },
};

export function isCategoriaPrazo(v: unknown): v is CategoriaPrazo {
  return typeof v === "string" && (CATEGORIAS_PRAZO as readonly string[]).includes(v);
}

export interface PrazoProcessual {
  id: string;
  ficha_id: string | null;
  advogado_id: string;
  /** Obrigatório nas categorias processuais; opcional em parcela, certidão e outro (v5). */
  numero_cnj: string | null;
  tribunal_vara: string | null;
  fase_processual: string | null;
  descricao_prazo: string;
  /** "YYYY-MM-DD" (date, sem fuso). */
  data_fatal: string;
  tipo_contagem: TipoContagem;
  status: StatusPrazo;
  observacoes: string | null;
  cumprido_em: string | null;
  categoria: CategoriaPrazo;
  /** Identificação do acordo/parcelamento (só categoria 'parcela'). */
  acordo_ref: string | null;
  parcela_numero: number | null;
  parcela_total: number | null;
  ficha: { id: string; nome_cliente: string } | null;
}

export interface PrazoNaTela extends PrazoProcessual {
  estagiario: MembroEquipe | null;
  /** Responsável quando não é o usuário logado (estagiário ou, para sócios, outro titular). */
  responsavel: MembroEquipe | null;
}

export type DadosPrazo = Omit<PrazoProcessual, "id" | "cumprido_em" | "ficha">;

const COLUNAS_BASE =
  "id,ficha_id,advogado_id,numero_cnj,tribunal_vara,fase_processual,descricao_prazo,data_fatal,tipo_contagem,status,observacoes,cumprido_em,ficha:fichas_clientes(id,nome_cliente)";
const COLUNAS = `${COLUNAS_BASE},categoria,acordo_ref,parcela_numero,parcela_total`;

/** Banco sem a migração v5: coluna inexistente. */
const semV5 = (e: PostgrestError | null) => e?.code === "42703";

/** Completa as linhas lidas sem a v5 (tudo é prazo processual). */
function normalizarPrazo(p: Partial<PrazoProcessual> & PrazoProcessual): PrazoProcessual {
  return {
    ...p,
    ficha: p.ficha ?? null,
    categoria: isCategoriaPrazo(p.categoria) ? p.categoria : "processual",
    acordo_ref: p.acordo_ref ?? null,
    parcela_numero: p.parcela_numero ?? null,
    parcela_total: p.parcela_total ?? null,
  };
}

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
  const consultar = (colunas: string) =>
    supabase
      .from("processos_prazos")
      .select(colunas)
      .in("advogado_id", responsaveis.map((r) => r.id))
      .order("data_fatal", { ascending: true })
      .overrideTypes<PrazoProcessual[], { merge: false }>();
  let { data, error } = await consultar(COLUNAS);
  if (semV5(error)) ({ data, error } = await consultar(COLUNAS_BASE));
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
    prazos: (data ?? []).map((bruto) => {
      const p = normalizarPrazo(bruto);
      const membro = p.advogado_id === perfil.id ? null : (porId.get(p.advogado_id) ?? null);
      return { ...p, responsavel: membro, estagiario: membro?.cargo === "estagiario" ? membro : null };
    }),
  };
}

/** Prazos de um intervalo de datas (para a agenda mensal). Silencioso se a tabela não existir. */
export async function buscarPrazosPeriodo(ids: string[], de: string, ate: string): Promise<PrazoProcessual[]> {
  if (ids.length === 0) return [];
  const consultar = (colunas: string) =>
    supabase
      .from("processos_prazos")
      .select(colunas)
      .in("advogado_id", ids)
      .gte("data_fatal", de)
      .lte("data_fatal", ate)
      .neq("status", "cumprido")
      .order("data_fatal", { ascending: true })
      .overrideTypes<PrazoProcessual[], { merge: false }>();
  let { data, error } = await consultar(COLUNAS);
  if (semV5(error)) ({ data, error } = await consultar(COLUNAS_BASE));
  if (error) {
    if (!tabelaAusente(error)) console.error("Erro ao buscar prazos do mês:", error.code, error.message);
    return [];
  }
  return (data ?? []).map(normalizarPrazo);
}

/** Rótulo curto para listas e calendário: CNJ, "Parcela 3/60 · acordo" ou a categoria. */
export function identificacaoPrazo(
  p: Pick<PrazoProcessual, "categoria" | "numero_cnj" | "acordo_ref" | "parcela_numero" | "parcela_total">,
): string {
  if (p.categoria === "parcela") {
    return `Parcela ${p.parcela_numero ?? "?"}/${p.parcela_total ?? "?"}${p.acordo_ref ? ` · ${p.acordo_ref}` : ""}`;
  }
  return p.numero_cnj ?? CATEGORIA_INFO[p.categoria].curto;
}

function mensagemErroSalvar(error: PostgrestError): string {
  const texto = `${error.message} ${error.details ?? ""}`;
  if (tabelaAusente(error)) return "A tabela processos_prazos ainda não existe. Aplique a migração v3 no Supabase.";
  if (error.code === "PGRST204" || error.code === "42703") {
    return "Categorias, parcelas e certidões exigem a migração 20261118_v5_leads_posvenda.sql no Supabase.";
  }
  if (error.code === "42501") {
    return texto.includes("Ficha vinculada")
      ? "A ficha escolhida não está disponível para você."
      : "Você não tem permissão para salvar prazos para este responsável.";
  }
  if (error.code === "23502" && texto.includes("numero_cnj")) {
    return "Sem a migração v5, o número CNJ é obrigatório em todos os prazos.";
  }
  if (error.code === "23514") {
    if (texto.includes("prazos_cnj_obrigatorio")) return "Esta categoria exige o número do processo (CNJ).";
    if (texto.includes("prazos_parcela_valida")) return "Parcela: informe o acordo e o número da parcela (até o total).";
    if (texto.includes("numero_cnj")) return "Número CNJ inválido. Use o formato 0000000-00.0000.0.00.0000.";
    return "Algum campo está com valor inválido. Revise o formulário.";
  }
  if (error.code === "PGRST116") return "Prazo não encontrado ou sem permissão.";
  return "Não foi possível salvar o prazo. Verifique sua conexão e tente novamente.";
}

/** Colunas da v5; removidas para gravar um prazo processual num banco ainda sem a migração. */
function semColunasV5(dados: DadosPrazo): Omit<DadosPrazo, "categoria" | "acordo_ref" | "parcela_numero" | "parcela_total"> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { categoria, acordo_ref, parcela_numero, parcela_total, ...resto } = dados;
  return resto;
}

export async function salvarPrazo(dados: DadosPrazo, id?: string): Promise<void> {
  const gravar = (linha: Partial<DadosPrazo>) =>
    (id
      ? supabase.from("processos_prazos").update(linha).eq("id", id)
      : supabase.from("processos_prazos").insert(linha)
    )
      .select("id")
      .single();
  let { error } = await gravar(dados);
  if (error?.code === "PGRST204" && dados.categoria === "processual") {
    // Banco sem a v5: o prazo processual comum continua sendo gravado com as colunas antigas.
    ({ error } = await gravar(semColunasV5(dados)));
  }
  if (error) {
    console.error("Erro ao salvar prazo:", error.code, error.message);
    throw new Error(mensagemErroSalvar(error));
  }
}

/** Soma meses mantendo o dia (31/01 + 1 mês → último dia de fevereiro). Entrada/saída "YYYY-MM-DD". */
export function somarMeses(iso: string, meses: number): string {
  const [a, m, d] = iso.slice(0, 10).split("-").map(Number);
  const alvo = new Date(a, m - 1 + meses, 1, 12);
  const ultimo = new Date(alvo.getFullYear(), alvo.getMonth() + 1, 0).getDate();
  alvo.setDate(Math.min(d, ultimo));
  return chaveDia(alvo);
}

/** Soma dias corridos (validade de certidão). */
export function somarDiasCorridos(iso: string, dias: number): string {
  const d = dataLocal(iso);
  d.setDate(d.getDate() + dias);
  return chaveDia(d);
}

/**
 * Cria de uma vez as parcelas mensais de um acordo: da parcela `parcela_numero` até
 * `parcela_total`, a primeira vencendo em `data_fatal` e as demais no mesmo dia dos meses seguintes.
 */
export async function gerarParcelas(dados: DadosPrazo): Promise<number> {
  const inicio = dados.parcela_numero ?? 1;
  const total = dados.parcela_total ?? inicio;
  if (dados.categoria !== "parcela" || total < inicio || total - inicio >= 600) throw new Error("Parcelas inválidas.");
  const linhas: DadosPrazo[] = [];
  for (let n = inicio; n <= total; n++) {
    linhas.push({ ...dados, parcela_numero: n, data_fatal: somarMeses(dados.data_fatal, n - inicio) });
  }
  const { data, error } = await supabase.from("processos_prazos").insert(linhas).select("id");
  if (error) {
    console.error("Erro ao gerar parcelas:", error.code, error.message);
    throw new Error(mensagemErroSalvar(error));
  }
  return data?.length ?? 0;
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

// ---------- acordos: risco de rescisão ----------

export interface ResumoAcordo {
  chave: string;
  acordo_ref: string;
  cliente: string | null;
  advogado_id: string;
  total: number;
  pagas: number;
  emAtraso: number;
  /** Maior sequência de parcelas consecutivas em atraso (pelo número da parcela). */
  maiorSequencia: number;
  proxima: PrazoProcessual | null;
  /** 3 seguidas ou 6 alternadas em atraso: regra geral que pode rescindir (confira a modalidade). */
  risco: boolean;
}

export function resumirAcordos(prazos: PrazoProcessual[], hoje = new Date()): ResumoAcordo[] {
  const grupos = new Map<string, PrazoProcessual[]>();
  for (const p of prazos) {
    if (p.categoria !== "parcela" || !p.acordo_ref) continue;
    const chave = `${p.advogado_id}|${p.ficha_id ?? ""}|${p.acordo_ref.trim().toLowerCase()}`;
    grupos.set(chave, [...(grupos.get(chave) ?? []), p]);
  }
  const atrasada = (p: PrazoProcessual) => p.status !== "cumprido" && diasRestantes(p.data_fatal, hoje) < 0;
  return [...grupos.entries()]
    .map(([chave, lista]): ResumoAcordo => {
      const ordenadas = [...lista].sort((a, b) => (a.parcela_numero ?? 0) - (b.parcela_numero ?? 0));
      let seq = 0;
      let maior = 0;
      for (const p of ordenadas) {
        seq = atrasada(p) ? seq + 1 : 0;
        maior = Math.max(maior, seq);
      }
      const emAtraso = ordenadas.filter(atrasada).length;
      return {
        chave,
        acordo_ref: ordenadas[0].acordo_ref ?? "",
        cliente: ordenadas[0].ficha?.nome_cliente ?? null,
        advogado_id: ordenadas[0].advogado_id,
        total: Math.max(ordenadas.length, ...ordenadas.map((p) => p.parcela_total ?? 0)),
        pagas: ordenadas.filter((p) => p.status === "cumprido").length,
        emAtraso,
        maiorSequencia: maior,
        proxima: ordenadas.find((p) => p.status !== "cumprido" && !atrasada(p)) ?? null,
        risco: maior >= 3 || emAtraso >= 6,
      };
    })
    .sort(
      (a, b) =>
        Number(b.risco) - Number(a.risco) || b.emAtraso - a.emAtraso || a.acordo_ref.localeCompare(b.acordo_ref, "pt-BR"),
    );
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

/** A janela de "urgente" depende da categoria (parcela: 5 dias antes; certidão: 15; processual: 2). */
export function urgenciaDoPrazo(
  p: Pick<PrazoProcessual, "data_fatal" | "status"> & { categoria?: CategoriaPrazo },
  hoje = new Date(),
): Urgencia {
  if (p.status === "cumprido") return "cumprido";
  const n = diasRestantes(p.data_fatal, hoje);
  if (n < 0) return "vencido";
  if (n === 0) return "hoje";
  if (n <= CATEGORIA_INFO[p.categoria ?? "processual"].janelaAlerta || p.status === "urgente") return "urgente";
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

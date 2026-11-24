/**
 * Regras puras da prospecção de execuções fiscais (sem rede, sem Deno): validação de CNJ/CNPJ,
 * leitura do texto do DJEN, detecção da Fazenda Nacional e validação do pedido.
 * Testadas em regras.test.ts (node --test).
 */

export const TRIBUNAIS = ["TRF1", "TRF3", "TRF4"] as const;
export type Tribunal = (typeof TRIBUNAIS)[number];
export const CLASSE_EXECUCAO_FISCAL = 1116;
/** Valor da causa mínimo (regra dos advogados): estritamente maior que R$ 100.000,00. */
export const VALOR_MINIMO = 100_000;
/** Maior janela de ajuizamento aceita por busca (em dias). */
export const JANELA_MAXIMA_DIAS = 31;
export const LIMITE_MAXIMO_POR_TRIBUNAL = 500;

export function soDigitos(v: unknown): string {
  return typeof v === "string" ? v.replace(/\D/g, "") : "";
}

/** CNPJ com 14 dígitos e dígitos verificadores corretos (CPF nunca passa aqui). */
export function cnpjValido(d: string): boolean {
  if (!/^\d{14}$/.test(d) || /^(\d)\1{13}$/.test(d)) return false;
  const dv = (base: string) => {
    const pesos = base.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const soma = pesos.reduce((s, p, i) => s + p * Number(base[i]), 0);
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = dv(d.slice(0, 12));
  const d2 = dv(d.slice(0, 12) + d1);
  return d.endsWith(`${d1}${d2}`);
}

/** Número CNJ (Res. 65/2008): NNNNNNN DD AAAA J TR OOOO, dígito verificador módulo 97. */
export function numeroCnjValido(d: string): boolean {
  if (!/^\d{20}$/.test(d)) return false;
  const semDv = d.slice(0, 7) + d.slice(9) + d.slice(7, 9);
  return BigInt(semDv) % 97n === 1n;
}

/** TRF do número CNJ (J = 4, Justiça Federal; TR = 01, 03 ou 04). */
export function tribunalDoCnj(d: string): Tribunal | null {
  if (!/^\d{20}$/.test(d) || d[13] !== "4") return null;
  const tr = d.slice(14, 16);
  return tr === "01" ? "TRF1" : tr === "03" ? "TRF3" : tr === "04" ? "TRF4" : null;
}

export function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[-–—_/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Polo ativo é a Fazenda Nacional (PGFN)? Aceita as grafias oficiais dos TRFs:
 * "FAZENDA NACIONAL", "UNIÃO - FAZENDA NACIONAL", "UNIAO FEDERAL (FAZENDA NACIONAL)",
 * "PROCURADORIA-GERAL DA FAZENDA NACIONAL", "PGFN". "UNIÃO FEDERAL" sozinha NÃO entra:
 * pode ser cobrança da AGU/PGU (multas do TCU, por exemplo), fora do escopo tributário.
 */
export function ehFazendaNacional(polo: string | null | undefined): boolean {
  if (!polo) return false;
  const n = normalizar(polo);
  return /\bFAZENDA NACIONAL\b/.test(n) || /\bPGFN\b/.test(n);
}

/** "20030410000000" (padrão do DataJud em vários TRFs) ou ISO → "AAAA-MM-DD". */
export function dataDataJud(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(valor.trim());
  if (!m) return null;
  const [, a, mes, dia] = m;
  const d = new Date(`${a}-${mes}-${dia}T12:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.getUTCMonth() + 1 !== Number(mes)) return null;
  return `${a}-${mes}-${dia}`;
}

/** "1.234.567,89" → 1234567.89 */
export function lerValorBR(texto: string): number | null {
  const limpo = texto.replace(/\./g, "").replace(",", ".");
  const n = Number(limpo);
  return Number.isFinite(n) && n >= 0 && n < 1e14 ? Math.round(n * 100) / 100 : null;
}

// ---------------------------------------------------------------- DJEN

export interface DestinatarioDjen {
  nome?: unknown;
  polo?: unknown;
}
export interface ComunicacaoDjen {
  texto?: unknown;
  data_disponibilizacao?: unknown;
  destinatarios?: unknown;
  codigoClasse?: unknown;
}

export interface PartesExtraidas {
  poloAtivo: string | null;
  poloAtivoFazenda: boolean;
  executado: string | null;
  cnpj: string | null;
  valorCausa: number | null;
  /** Executado com CPF no nome: empresário individual/MEI (pessoa física para a LGPD). */
  pessoaFisica: boolean;
}

/** Raiz do CNPJ da União/Ministério da Fazenda (unidades da PGFN): nunca é o executado. */
const RAIZES_UNIAO = ["00394460", "00394411", "26994558"];

const ROTULO_EXEQUENTE = /\b(?:EXEQUENTE|EXEQTE|AUTORA?|REQUERENTE)S?\s*(?:\((?:A|S|AS|ES)\))?\s*:/i;
const ROTULO_EXECUTADO = /\bEXECUTAD[OA]S?\s*(?:\((?:A|S|AS|OS)\))?\s*:/i;
/** Qualquer rótulo de polo passivo: encerra a janela do polo ativo. */
const ROTULO_PASSIVO = /\b(?:EXECUTAD[OA]S?|R[EÉ]U|R[EÉ]US|REQUERID[OA]S?|EMBARGAD[OA]S?|IMPETRAD[OA]S?)\s*(?:\([A-Z]{1,2}\))?\s*:/i;
/** Onde termina o nome de uma parte no cabeçalho da publicação. */
const FIM_DO_NOME =
  /\s+(?:ADVOGAD|Advogad|PROCURADOR|Procurador|REPRESENTANTE|EXECUTAD|EXEQUENTE|TERCEIR|INTERESSAD|DESPACHO|Despacho|DECIS|Decis|SENTEN|Senten|ATO ORDINAT|Ato ordinat|INTIMA|Intima|CERTID|Certid|EDITAL|Edital|VISTOS|Vistos|Fica |FICA |Ficam |Nos termos|NOS TERMOS|PODER JUDICI|CNPJ|CPF|C\.N\.P\.J|Tendo em vista|TENDO EM VISTA)/;
const PADRAO_CNPJ = /(?<![\d./-])(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|\d{14})(?![\d./-])/g;
const PADRAO_VALOR = /VALOR\s+DA\s+CAUSA\s*:?\s*R\$\s*([\d.]+,\d{2})/i;

function trechoApos(texto: string, rotulo: RegExp, tamanho: number): { inicio: number; trecho: string } | null {
  const m = rotulo.exec(texto);
  if (!m) return null;
  const inicio = m.index + m[0].length;
  return { inicio, trecho: texto.slice(inicio, inicio + tamanho) };
}

function nomeDaParte(trecho: string): string | null {
  const fim = FIM_DO_NOME.exec(trecho);
  const nome = (fim ? trecho.slice(0, fim.index) : trecho)
    .replace(/\s+/g, " ")
    .replace(/[\s,;:.\-–(]+$/, "")
    .trim();
  return nome.length >= 3 ? nome.slice(0, 200) : null;
}

function cnpjsValidos(texto: string): { cnpj: string; pos: number }[] {
  const achados: { cnpj: string; pos: number }[] = [];
  for (const m of texto.matchAll(PADRAO_CNPJ)) {
    const d = soDigitos(m[1]);
    if (cnpjValido(d) && !RAIZES_UNIAO.includes(d.slice(0, 8))) achados.push({ cnpj: d, pos: m.index ?? 0 });
  }
  return achados;
}

/** Lê UMA publicação (cabeçalho padrão do PJe/eproc: "EXEQUENTE: ... EXECUTADO: ..."). */
export function lerPublicacao(c: ComunicacaoDjen): PartesExtraidas {
  const texto = typeof c.texto === "string" ? c.texto.slice(0, 20_000) : "";
  const destinatarios = Array.isArray(c.destinatarios) ? (c.destinatarios as DestinatarioDjen[]) : [];

  // Polo ativo: a janela entre "EXEQUENTE:" e "EXECUTADO:" decide se é a Fazenda
  // (o "(" não encerra o nome aqui: "UNIAO FEDERAL (FAZENDA NACIONAL)").
  const exq = trechoApos(texto, ROTULO_EXEQUENTE, 200);
  let janelaAtiva = exq?.trecho ?? "";
  const corteExec = ROTULO_PASSIVO.exec(janelaAtiva);
  if (corteExec) janelaAtiva = janelaAtiva.slice(0, corteExec.index);
  let poloAtivo = janelaAtiva ? nomeDaParte(janelaAtiva.replace(/\s+(?:ADVOGAD|Advogad|PROCURADOR|Procurador)[\s\S]*$/, "")) : null;
  if (!poloAtivo) {
    const ativos = destinatarios.filter((d) => d?.polo === "A" && typeof d.nome === "string").map((d) => String(d.nome));
    poloAtivo = ativos.length ? ativos.join(" / ").slice(0, 200) : null;
  }

  // Executado e CNPJ: o CNPJ válido mais próximo depois de "EXECUTADO:"; sem rótulo, só se
  // houver um único CNPJ válido na publicação (evita pegar CNPJ de terceiros).
  const exe = trechoApos(texto, ROTULO_EXECUTADO, 400);
  let executado = exe ? nomeDaParte(exe.trecho.split(/\s+\(?(?:CNPJ|C\.N\.P\.J)/i)[0]) : null;
  if (!executado) {
    const passivos = destinatarios.filter((d) => d?.polo === "P" && typeof d.nome === "string").map((d) => String(d.nome));
    executado = passivos.length === 1 ? passivos[0].slice(0, 200) : null;
  }
  const inicioAtivo = exq ? exq.inicio : -1;
  const fimAtivo = exq ? exq.inicio + janelaAtiva.length : -1;
  const candidatos = cnpjsValidos(texto).filter((c) => !(c.pos >= inicioAtivo && c.pos < fimAtivo));
  let cnpj: string | null = null;
  if (exe) {
    const depois = candidatos.find((c) => c.pos >= exe.inicio && c.pos <= exe.inicio + 400);
    cnpj = depois?.cnpj ?? null;
  }
  if (!cnpj) {
    const distintos = [...new Set(candidatos.map((c) => c.cnpj))];
    cnpj = distintos.length === 1 ? distintos[0] : null;
  }

  const v = PADRAO_VALOR.exec(texto);
  // MEI/empresário individual: a razão social leva o CPF do titular. Fora do escopo (LGPD):
  // não guarda nome nem CNPJ.
  const pessoaFisica = pareceEmpresarioIndividual(executado);
  return {
    poloAtivo,
    poloAtivoFazenda: ehFazendaNacional(poloAtivo),
    executado: pessoaFisica ? null : executado,
    cnpj: pessoaFisica ? null : cnpj,
    valorCausa: v ? lerValorBR(v[1]) : null,
    pessoaFisica,
  };
}

/**
 * Junta todas as publicações do processo (mais recentes primeiro): o primeiro valor
 * encontrado de cada campo vence. Devolve null se não houver nenhuma publicação.
 */
export function extrairPartesDjen(itens: ComunicacaoDjen[]): PartesExtraidas | null {
  if (!itens.length) return null;
  const ordenados = [...itens].sort((a, b) =>
    String(b.data_disponibilizacao ?? "").localeCompare(String(a.data_disponibilizacao ?? "")),
  );
  const r: PartesExtraidas = { poloAtivo: null, poloAtivoFazenda: false, executado: null, cnpj: null, valorCausa: null, pessoaFisica: false };
  for (const item of ordenados) {
    const p = lerPublicacao(item);
    if (!r.poloAtivo && p.poloAtivo) {
      r.poloAtivo = p.poloAtivo;
      r.poloAtivoFazenda = p.poloAtivoFazenda;
    } else if (!r.poloAtivoFazenda && p.poloAtivoFazenda) {
      r.poloAtivo = p.poloAtivo;
      r.poloAtivoFazenda = true;
    }
    if (!r.cnpj && p.cnpj) {
      r.cnpj = p.cnpj;
      r.executado = p.executado ?? r.executado;
    }
    r.executado ??= p.executado;
    r.valorCausa ??= p.valorCausa;
    r.pessoaFisica ||= p.pessoaFisica;
  }
  // Basta uma publicação indicar empresário individual para o processo sair da lista.
  return r.pessoaFisica ? { ...r, executado: null, cnpj: null } : r;
}

export type Situacao = "qualificado" | "sem_publicacao" | "sem_cnpj" | "fora_do_filtro";

/** Classifica o processo depois da consulta ao DJEN. */
export function classificar(p: PartesExtraidas | null): Situacao {
  if (!p) return "sem_publicacao";
  if (p.pessoaFisica) return "fora_do_filtro";
  if (p.poloAtivo && !p.poloAtivoFazenda) return "fora_do_filtro";
  if (p.poloAtivoFazenda && p.cnpj) return "qualificado";
  if (p.poloAtivoFazenda) return "sem_cnpj";
  return "sem_publicacao";
}

/** Próxima tentativa (dias) para quem ainda não tem publicação/CNPJ: 1, 3, 7, 15, 30. */
export function diasAteNovaTentativa(tentativas: number): number {
  return [1, 3, 7, 15, 30][Math.min(Math.max(tentativas, 0), 4)];
}

/**
 * Nome com CPF (formatado ou 11 dígitos seguidos): padrão da razão social de MEI e
 * empresário individual na Receita ("FULANO DE TAL 12345678901"). Também protege contra
 * gravar CPF em campo de nome.
 */
export function pareceEmpresarioIndividual(nome: string | null | undefined): boolean {
  if (!nome) return false;
  return /\d{3}\.\d{3}\.\d{3}-\d{2}/.test(nome) || /(?<!\d)\d{11}(?!\d)/.test(nome);
}

// ---------------------------------------------------------------- respostas do DataJud

export type RespostaFonte = "ok" | "chave_invalida" | "sobrecarga" | "erro";

/**
 * Classifica a resposta do DataJud. 401/403 = chave rotacionada ou expirada (o CNJ troca a
 * chave pública de tempos em tempos). Sobrecarga do cluster vem como 429/5xx ou com
 * es_rejected_execution_exception / search_phase_execution_exception no corpo (às vezes
 * com HTTP 200): tentar de novo mais tarde, sem perder o que já foi gravado.
 */
export function classificarRespostaDataJud(status: number, corpo: unknown): RespostaFonte {
  if (status === 401 || status === 403) return "chave_invalida";
  const erro = corpo && typeof corpo === "object" ? (corpo as { error?: unknown }).error : undefined;
  const textoErro = erro === undefined ? "" : JSON.stringify(erro).slice(0, 2_000);
  if (status === 429 || status >= 500 || /rejected_execution|search_phase_execution|timeout|circuit_breaking/i.test(textoErro)) {
    return "sobrecarga";
  }
  if (status < 200 || status >= 300 || erro !== undefined || !corpo || typeof corpo !== "object") return "erro";
  return "ok";
}

/** Tempo de espera para uma chamada externa que não pode passar do prazo da execução. */
export function tempoRestante(prazoFinal: number, maximoMs: number, minimoMs = 3_000, agora = Date.now()): number {
  return Math.max(minimoMs, Math.min(maximoMs, prazoFinal - agora));
}

// ---------------------------------------------------------------- contato (base CNPJ)

/** Telefone da base da Receita ("1134567890") → "(11) 3456-7890". Inválido → null. */
export function formatarTelefone(v: unknown): string | null {
  const d = typeof v === "string" || typeof v === "number" ? String(v).replace(/\D/g, "") : "";
  if (!/^[1-9]\d(?:9?\d{8})$/.test(d)) return null;
  const ddd = d.slice(0, 2);
  const n = d.slice(2);
  return n.length === 9 ? `(${ddd}) ${n.slice(0, 5)}-${n.slice(5)}` : `(${ddd}) ${n.slice(0, 4)}-${n.slice(4)}`;
}

export function normalizarEmail(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const e = v.trim().toLowerCase();
  return e.length <= 200 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : null;
}

/** Natureza jurídica 213-5 (empresário individual, inclui MEI): pessoa física para a LGPD. */
export const NATUREZA_EMPRESARIO_INDIVIDUAL = "2135";

// ---------------------------------------------------------------- pedido

export type Pedido =
  | { acao: "buscar"; tribunais: Tribunal[]; de: string; ate: string; limite: number }
  | { acao: "processar" };

const DATA = /^\d{4}-\d{2}-\d{2}$/;

/** Valida o corpo da requisição. Campos inesperados são recusados. */
export function validarPedido(corpo: unknown, hoje: Date = new Date()): Pedido | { erro: string } {
  if (!corpo || typeof corpo !== "object" || Array.isArray(corpo)) return { erro: "Corpo inválido." };
  const o = corpo as Record<string, unknown>;
  if (o.acao === "processar") {
    if (Object.keys(o).some((k) => k !== "acao")) return { erro: "Campos inesperados." };
    return { acao: "processar" };
  }
  if (o.acao !== "buscar") return { erro: "Ação inválida." };
  if (Object.keys(o).some((k) => !["acao", "tribunais", "de", "ate", "limite"].includes(k))) return { erro: "Campos inesperados." };
  const tribunais = o.tribunais;
  if (!Array.isArray(tribunais) || tribunais.length === 0 || tribunais.length > TRIBUNAIS.length
      || !tribunais.every((t) => (TRIBUNAIS as readonly unknown[]).includes(t))) {
    return { erro: "Tribunais inválidos (use TRF1, TRF3 e/ou TRF4)." };
  }
  const de = typeof o.de === "string" && DATA.test(o.de) ? dataDataJud(o.de) : null;
  const ate = typeof o.ate === "string" && DATA.test(o.ate) ? dataDataJud(o.ate) : null;
  if (!de || !ate) return { erro: "Período inválido (AAAA-MM-DD)." };
  if (de > ate) return { erro: "A data inicial é depois da final." };
  const amanha = new Date(hoje.getTime() + 86_400_000).toISOString().slice(0, 10);
  if (ate > amanha) return { erro: "O período não pode estar no futuro." };
  const dias = (Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / 86_400_000;
  if (dias > JANELA_MAXIMA_DIAS) return { erro: `Janela máxima de ${JANELA_MAXIMA_DIAS} dias por busca.` };
  const limite = o.limite === undefined ? 200 : o.limite;
  if (typeof limite !== "number" || !Number.isInteger(limite) || limite < 1 || limite > LIMITE_MAXIMO_POR_TRIBUNAL) {
    return { erro: `Limite inválido (1 a ${LIMITE_MAXIMO_POR_TRIBUNAL}).` };
  }
  return { acao: "buscar", tribunais: [...new Set(tribunais as Tribunal[])], de, ate, limite };
}

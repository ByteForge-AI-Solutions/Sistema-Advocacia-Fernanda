/**
 * Fontes de dados da prospecção (adapters). Nesta entrega, SÓ fontes públicas e gratuitas:
 *   - FonteProcessos  → DataJud/CNJ (API pública, chave gratuita DATAJUD_API_KEY)
 *   - FontePartes     → DJEN (comunicaapi.pje.jus.br, sem chave e sem captcha)
 *   - FonteContatoCnpj→ base aberta de CNPJ da Receita (minhareceita.org, BrasilAPI, CNPJ.ws)
 *
 * Para plugar um provedor pago no futuro (Judit, Escavador, Digesto, Lemit, Direct Data,
 * Assertiva...): implemente a mesma interface num adapter novo, inclua o host em
 * HOSTS_PERMITIDOS e o adapter na lista correspondente (FONTES_*). O orquestrador (index.ts)
 * não muda.
 *
 * Anti-SSRF: toda chamada externa passa por buscarSeguro(): só HTTPS, só hosts da lista,
 * sem credenciais/porta na URL e SEM seguir redirecionamentos. Nenhuma URL vem do usuário:
 * só números CNJ/CNPJ já validados entram no caminho, sempre com encodeURIComponent.
 */
import {
  CLASSE_EXECUCAO_FISCAL,
  classificarRespostaDataJud,
  tempoRestante,
  NATUREZA_EMPRESARIO_INDIVIDUAL,
  dataDataJud,
  extrairPartesDjen,
  formatarTelefone,
  normalizarEmail,
  numeroCnjValido,
  pareceEmpresarioIndividual,
  soDigitos,
  tribunalDoCnj,
} from "./regras.ts";
import type { ComunicacaoDjen, PartesExtraidas, Tribunal } from "./regras.ts";

export const HOSTS_PERMITIDOS = new Set([
  "api-publica.datajud.cnj.jus.br",
  "comunicaapi.pje.jus.br",
  "minhareceita.org",
  "brasilapi.com.br",
  "publica.cnpj.ws",
]);

/** A fonte recusou a credencial (401/403): chave expirada ou rotacionada. Não adianta repetir. */
export class ChaveRecusada extends Error {
  constructor(fonte: string) {
    super(`${fonte}_chave_recusada`);
  }
}

/** Erro passageiro da fonte (limite de uso, indisponibilidade): tentar de novo mais tarde. */
export class FonteIndisponivel extends Error {
  limiteDeUso: boolean;
  constructor(fonte: string, limiteDeUso = false) {
    super(`${fonte}_indisponivel`);
    this.limiteDeUso = limiteDeUso;
  }
}

export function urlPermitida(url: string): URL | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || !HOSTS_PERMITIDOS.has(u.hostname) || u.username || u.password) return null;
  if (u.port && u.port !== "443") return null;
  return u;
}

/** timeoutMs é o teto de cada chamada; use tempoRestante() para não passar do prazo da execução. */
export async function buscarSeguro(url: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<Response> {
  const u = urlPermitida(url);
  if (!u) throw new Error("destino_nao_permitido");
  return await fetch(u, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json", "user-agent": "crm-prospeccao/1.0", ...(init.headers ?? {}) },
  });
}

/** Lê JSON com teto de tamanho (resposta inesperadamente grande não derruba a função). */
async function jsonLimitado(r: Response, maxBytes = 5_000_000): Promise<unknown> {
  const texto = await r.text();
  if (texto.length > maxBytes) throw new Error("resposta_grande_demais");
  return JSON.parse(texto);
}

const esperar = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

// ============================================================ interfaces

export interface ProcessoEncontrado {
  numeroCnj: string;
  tribunal: Tribunal;
  classeNome: string;
  dataDistribuicao: string | null;
  orgaoJulgador: string | null;
  grau: string | null;
  valorCausa: number | null;
}

/** Por que a busca de um tribunal terminou. */
export type FimDaBusca = "fim" | "limite" | "tempo" | "sobrecarga";

export interface FonteProcessos {
  nome: string;
  /**
   * Entrega cada página em aoReceber, que grava na hora: se a fonte cair no meio, o que já
   * veio não se perde. Lança ChaveRecusada (401/403) ou FonteIndisponivel (nada recebido).
   */
  buscar(
    p: { tribunal: Tribunal; de: string; ate: string; limite: number; prazoFinal: number },
    aoReceber: (lote: ProcessoEncontrado[]) => Promise<void>,
  ): Promise<{ recebidos: number; fim: FimDaBusca }>;
}

export interface FontePartes {
  nome: string;
  /** null = nenhuma publicação para o processo (ainda). Lança FonteIndisponivel se a fonte falhar. */
  consultar(numeroCnj: string, prazoFinal?: number): Promise<PartesExtraidas | null>;
}

export interface DadosCnpj {
  razaoSocial: string | null;
  nomeFantasia: string | null;
  situacaoCadastral: string | null;
  naturezaJuridica: string | null;
  uf: string | null;
  municipio: string | null;
  telefones: string[];
  email: string | null;
}

export interface FonteContatoCnpj {
  /** Gravado em prosp_cnpj_cache.fonte (CHECK no banco): fonte nova exige incluir o nome lá. */
  nome: "minhareceita" | "brasilapi" | "cnpjws";
  /** null = CNPJ não existe na base. Lança FonteIndisponivel em falha passageira. */
  consultar(cnpj: string, prazoFinal?: number): Promise<DadosCnpj | null>;
}

// ============================================================ DataJud (CNJ)

/**
 * O DataJud guarda dataAjuizamento em dois formatos conforme o tribunal: ISO e
 * "AAAAMMDDhhmmss". O segundo é indexado como epoch_millis (20261101000000 ms), por isso
 * a janela vai nos dois formatos (OR) e o resultado é refiltrado aqui pela data lida.
 */
export function consultaDataJud(de: string, ate: string, tamanho: number, depoisDe?: unknown[]) {
  const compacto = (d: string) => Number(d.replace(/-/g, ""));
  return {
    size: tamanho,
    track_total_hits: false,
    _source: ["numeroProcesso", "dataAjuizamento", "classe", "grau", "orgaoJulgador.nome", "tribunal", "valorCausa"],
    query: {
      bool: {
        filter: [
          { term: { "classe.codigo": CLASSE_EXECUCAO_FISCAL } },
          {
            bool: {
              minimum_should_match: 1,
              should: [
                { range: { dataAjuizamento: { gte: `${de}T00:00:00`, lte: `${ate}T23:59:59` } } },
                { range: { dataAjuizamento: { gte: compacto(de) * 1_000_000, lte: compacto(ate) * 1_000_000 + 235959, format: "epoch_millis" } } },
              ],
            },
          },
        ],
      },
    },
    sort: [{ "@timestamp": { order: "asc" } }],
    ...(depoisDe ? { search_after: depoisDe } : {}),
  };
}

export interface RespostaDataJud {
  hits?: { hits?: { _source?: Record<string, unknown>; sort?: unknown[] }[] };
}

/** Lê uma página do DataJud: só execuções fiscais do tribunal pedido, dentro da janela. */
export function lerPaginaDataJud(dados: RespostaDataJud, tribunal: Tribunal, de: string, ate: string): ProcessoEncontrado[] {
  const lote: ProcessoEncontrado[] = [];
  for (const h of dados.hits?.hits ?? []) {
    const s = h._source ?? {};
    const numero = soDigitos(s.numeroProcesso);
    if (!numeroCnjValido(numero) || tribunalDoCnj(numero) !== tribunal) continue;
    const data = dataDataJud(s.dataAjuizamento);
    if (!data || data < de || data > ate) continue;
    const classe = (s.classe ?? {}) as { codigo?: unknown; nome?: unknown };
    if (Number(classe.codigo) !== CLASSE_EXECUCAO_FISCAL) continue;
    const orgao = (s.orgaoJulgador ?? {}) as { nome?: unknown };
    const valor = typeof s.valorCausa === "number" && s.valorCausa >= 0 ? Math.round(s.valorCausa * 100) / 100 : null;
    lote.push({
      numeroCnj: numero,
      tribunal,
      classeNome: typeof classe.nome === "string" ? classe.nome.slice(0, 120) : "Execução Fiscal",
      dataDistribuicao: data,
      orgaoJulgador: typeof orgao.nome === "string" ? orgao.nome.slice(0, 200) : null,
      grau: typeof s.grau === "string" ? s.grau.slice(0, 10) : null,
      valorCausa: valor,
    });
  }
  return lote;
}

export function fonteDataJud(apiKey: string): FonteProcessos {
  return {
    nome: "datajud",
    async buscar({ tribunal, de, ate, limite, prazoFinal }, aoReceber) {
      const url = `https://api-publica.datajud.cnj.jus.br/api_publica_${tribunal.toLowerCase()}/_search`;
      const vistos = new Set<string>();
      let depoisDe: unknown[] | undefined;
      while (vistos.size < limite) {
        if (Date.now() > prazoFinal) return { recebidos: vistos.size, fim: "tempo" };
        const corpo = JSON.stringify(consultaDataJud(de, ate, Math.min(100, limite - vistos.size), depoisDe));
        let dados: RespostaDataJud | null = null;
        // O cluster público rejeita consultas quando está sobrecarregado (HTTP 429 com
        // es_rejected_execution_exception): até 3 tentativas com espera crescente.
        for (let tentativa = 0; tentativa < 3 && !dados; tentativa++) {
          if (tentativa) await esperar(2_000 * tentativa);
          if (Date.now() > prazoFinal) break;
          const r = await buscarSeguro(url, {
            method: "POST",
            headers: { Authorization: `APIKey ${apiKey}`, "content-type": "application/json" },
            body: corpo,
          }, tempoRestante(prazoFinal, 60_000, 5_000)).catch(() => null);
          if (!r) continue; // timeout ou rede: tratado como sobrecarga
          const j = await jsonLimitado(r).catch(() => null);
          const situacao = classificarRespostaDataJud(r.status, j);
          if (situacao === "chave_invalida") throw new ChaveRecusada("datajud");
          if (situacao === "ok") dados = j as RespostaDataJud;
        }
        if (!dados) {
          if (vistos.size) return { recebidos: vistos.size, fim: "sobrecarga" }; // o que veio já está gravado
          throw new FonteIndisponivel("datajud", true);
        }
        const novos = lerPaginaDataJud(dados, tribunal, de, ate).filter((p) => !vistos.has(p.numeroCnj));
        novos.forEach((p) => vistos.add(p.numeroCnj));
        if (novos.length) await aoReceber(novos);
        const hits = dados.hits?.hits ?? [];
        const ultimo = hits[hits.length - 1]?.sort;
        if (hits.length === 0 || !Array.isArray(ultimo)) return { recebidos: vistos.size, fim: "fim" };
        depoisDe = ultimo;
      }
      return { recebidos: vistos.size, fim: "limite" };
    },
  };
}

// ============================================================ DJEN

export const fonteDjen: FontePartes = {
  nome: "djen",
  async consultar(numeroCnj, prazoFinal = Date.now() + 20_000) {
    const url = `https://comunicaapi.pje.jus.br/api/v1/comunicacao?numeroProcesso=${encodeURIComponent(numeroCnj)}&itensPorPagina=50&pagina=1`;
    const r = await buscarSeguro(url, {}, tempoRestante(prazoFinal, 20_000)).catch(() => null);
    if (!r) throw new FonteIndisponivel("djen");
    if (r.status === 429) throw new FonteIndisponivel("djen", true);
    if (r.status === 404) return null;
    if (!r.ok) throw new FonteIndisponivel("djen", r.status >= 500);
    const j = (await jsonLimitado(r).catch(() => null)) as { items?: unknown } | null;
    if (!j) throw new FonteIndisponivel("djen");
    const itens = Array.isArray(j.items) ? (j.items as ComunicacaoDjen[]) : [];
    return extrairPartesDjen(itens);
  },
};

// ============================================================ base aberta de CNPJ

const texto = (v: unknown, max = 200) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const natureza = (v: unknown) => {
  const d = soDigitos(String(v ?? ""));
  return /^\d{4}$/.test(d) ? d : null;
};
const uf = (v: unknown) => (typeof v === "string" && /^[A-Za-z]{2}$/.test(v.trim()) ? v.trim().toUpperCase() : null);

/**
 * LGPD: empresário individual/MEI é pessoa física. Não guarda contato nem nome (a razão
 * social dele traz o CPF do titular); fica só a natureza, para a lista excluí-lo.
 */
export function minimizar(d: DadosCnpj): DadosCnpj {
  const individual = d.naturezaJuridica === NATUREZA_EMPRESARIO_INDIVIDUAL
    || pareceEmpresarioIndividual(d.razaoSocial) || pareceEmpresarioIndividual(d.nomeFantasia);
  if (!individual) return d;
  return { ...d, naturezaJuridica: NATUREZA_EMPRESARIO_INDIVIDUAL, razaoSocial: null, nomeFantasia: null, telefones: [], email: null };
}

function telefones(...valores: unknown[]): string[] {
  return [...new Set(valores.map(formatarTelefone).filter((t): t is string => t !== null))].slice(0, 3);
}

async function consultarJson(fonte: string, url: string, prazoFinal: number): Promise<Record<string, unknown> | null> {
  const r = await buscarSeguro(url, {}, tempoRestante(prazoFinal, 15_000)).catch(() => null);
  if (!r) throw new FonteIndisponivel(fonte);
  if (r.status === 404 || r.status === 400) return null;
  if (r.status === 429) throw new FonteIndisponivel(fonte, true);
  if (!r.ok) throw new FonteIndisponivel(fonte);
  const j = await jsonLimitado(r, 1_000_000).catch(() => null);
  if (!j || typeof j !== "object") throw new FonteIndisponivel(fonte);
  return j as Record<string, unknown>;
}

/** minhareceita.org e BrasilAPI usam o mesmo formato (BrasilAPI consome a Minha Receita). */
function lerFormatoMinhaReceita(j: Record<string, unknown>): DadosCnpj {
  return minimizar({
    razaoSocial: texto(j.razao_social),
    nomeFantasia: texto(j.nome_fantasia),
    situacaoCadastral: texto(j.descricao_situacao_cadastral, 40),
    naturezaJuridica: natureza(j.codigo_natureza_juridica),
    uf: uf(j.uf),
    municipio: texto(j.municipio, 120),
    telefones: telefones(j.ddd_telefone_1, j.ddd_telefone_2),
    email: normalizarEmail(j.email),
  });
}

export const fonteMinhaReceita: FonteContatoCnpj = {
  nome: "minhareceita",
  async consultar(cnpj, prazoFinal = Date.now() + 15_000) {
    const j = await consultarJson("minhareceita", `https://minhareceita.org/${encodeURIComponent(cnpj)}`, prazoFinal);
    return j ? lerFormatoMinhaReceita(j) : null;
  },
};

export const fonteBrasilApi: FonteContatoCnpj = {
  nome: "brasilapi",
  async consultar(cnpj, prazoFinal = Date.now() + 15_000) {
    const j = await consultarJson("brasilapi", `https://brasilapi.com.br/api/cnpj/v1/${encodeURIComponent(cnpj)}`, prazoFinal);
    return j ? lerFormatoMinhaReceita(j) : null;
  },
};

/** CNPJ.ws pública: 3 consultas/minuto. Usada só como último recurso. */
export const fonteCnpjWs: FonteContatoCnpj = {
  nome: "cnpjws",
  async consultar(cnpj, prazoFinal = Date.now() + 15_000) {
    const j = await consultarJson("cnpjws", `https://publica.cnpj.ws/cnpj/${encodeURIComponent(cnpj)}`, prazoFinal);
    if (!j) return null;
    const est = (j.estabelecimento ?? {}) as Record<string, unknown>;
    const nat = (j.natureza_juridica ?? {}) as Record<string, unknown>;
    const estado = (est.estado ?? {}) as Record<string, unknown>;
    const cidade = (est.cidade ?? {}) as Record<string, unknown>;
    const junta = (ddd: unknown, num: unknown) => (ddd && num ? `${ddd}${num}` : null);
    return minimizar({
      razaoSocial: texto(j.razao_social),
      nomeFantasia: texto(est.nome_fantasia),
      situacaoCadastral: texto(est.situacao_cadastral, 40),
      naturezaJuridica: natureza(nat.id),
      uf: uf(estado.sigla),
      municipio: texto(cidade.nome, 120),
      telefones: telefones(junta(est.ddd1, est.telefone1), junta(est.ddd2, est.telefone2)),
      email: normalizarEmail(est.email),
    });
  },
};

/** Ordem de consulta do contato (a primeira que responder vence). */
export const FONTES_CONTATO: FonteContatoCnpj[] = [fonteMinhaReceita, fonteBrasilApi, fonteCnpjWs];

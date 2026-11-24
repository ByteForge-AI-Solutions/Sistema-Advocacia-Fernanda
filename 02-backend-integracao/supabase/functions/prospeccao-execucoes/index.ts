/**
 * DIAS & FERNANDES | Prospecção de Execuções Fiscais (CNPJ) | v11
 *
 * Chamada pelo CRM (supabase.functions.invoke) com o JWT do usuário. Implante COM verificação
 * de JWT (padrão): supabase functions deploy prospeccao-execucoes
 *
 * Ações (POST JSON, campos estritos — ver validarPedido em regras.ts):
 *   { acao: "buscar", tribunais: ["TRF1","TRF3","TRF4"], de: "AAAA-MM-DD", ate: "AAAA-MM-DD", limite?: 1..500 }
 *       1. DataJud: execuções fiscais (classe 1116) ajuizadas na janela → prosp_processos. Cada
 *          página é gravada assim que chega (sobrecarga no meio não perde o que já veio);
 *       2. segue para o processamento da fila (abaixo), até o tempo acabar.
 *   { acao: "processar" }
 *       1. DJEN: partes, polo ativo, CNPJ e valor da causa dos processos pendentes;
 *       2. base aberta de CNPJ: telefone e e-mail (cache de 30 dias em prosp_cnpj_cache).
 *
 * Fila sem perda: os processos são RESERVADOS (proxima_tentativa_em = agora + 3 min) antes da
 * consulta, então duas chamadas simultâneas não pegam o mesmo item; os que não chegam a ser
 * consultados são devolvidos à fila no fim. Fonte fora do ar ou no limite de uso NÃO gasta
 * tentativa: o item só é reagendado.
 *
 * Resposta 200 = execução concluída, com "avisos" (chave do DataJud recusada, sobrecarga,
 * tempo esgotado...). Códigos 4xx/5xx = nada foi executado (sessão, cargo, limite, pedido).
 *
 * Autorização no servidor: o cargo vem do banco (RPC crm_cargo_atual com o JWT do usuário);
 * só 'socio' e 'advogado'. Limite de 6 chamadas por minuto por usuário e de tentativas
 * inválidas por IP. Chaves (DATAJUD_API_KEY, service_role) só existem como secrets da Edge.
 * Respostas de erro nunca trazem detalhes internos; nada de dados de partes em log.
 */
import { bloqueado, ipDe, registrarFalha } from "../_shared/limite-falhas.ts";
import { ChaveRecusada, FONTES_CONTATO, FonteIndisponivel, fonteDataJud, fonteDjen } from "./fontes.ts";
import type { DadosCnpj, FimDaBusca, ProcessoEncontrado } from "./fontes.ts";
import { classificar, cnpjValido, diasAteNovaTentativa, pareceEmpresarioIndividual, validarPedido } from "./regras.ts";
import type { Tribunal } from "./regras.ts";

/**
 * Tempo de trabalho por chamada. Cada chamada externa respeita o prazo (tempoRestante), então
 * a resposta sai bem antes do limite de 150 s do gateway das Edge Functions.
 */
const ORCAMENTO_MS = 90_000;
/** Na busca, o DataJud usa o tempo até sobrar isto para a fila (DJEN e contatos). */
const RESERVA_FILA_MS = 20_000;
const LOTE_DJEN = 60;
const LOTE_CNPJ = 60;
const PAUSA_DJEN_MS = 400;
const PAUSA_CNPJ_MS = 350;
const MAX_TENTATIVAS = 6;
const RESERVA_MS = 3 * 60_000;
const REAGENDAR_FONTE_FORA_MS = 15 * 60_000;
/** Falhas seguidas de uma fonte antes de parar de insistir nesta execução. */
const MAX_FALHAS_SEGUIDAS = 3;
const CHAMADAS_POR_MINUTO = 6;

function env(chave: string): string {
  return Deno.env.get(chave)?.trim() || "";
}
const esperar = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const daquiA = (ms: number) => new Date(Date.now() + ms).toISOString();

// ---------------------------------------------------------------- CORS (só as origens do CRM)

function origensPermitidas(): string[] {
  const lista = env("CRM_ORIGENS") || "http://localhost:3000";
  return lista.split(",").map((o) => o.trim().replace(/\/$/, "")).filter(Boolean);
}
function cabecalhosCors(req: Request): Record<string, string> {
  const origem = req.headers.get("origin") ?? "";
  const base: Record<string, string> = {
    Vary: "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Expose-Headers": "retry-after",
    "Access-Control-Max-Age": "600",
  };
  if (origensPermitidas().includes(origem)) base["Access-Control-Allow-Origin"] = origem;
  return base;
}
function responder(req: Request, status: number, corpo: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: {
      ...cabecalhosCors(req),
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extra,
    },
  });
}

// ---------------------------------------------------------------- banco (service_role)

async function db(caminho: string, init: { method?: string; corpo?: unknown; prefer?: string } = {}): Promise<unknown> {
  const url = env("SUPABASE_URL");
  const chave = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url.startsWith("https://") || !chave) throw new Error("backend_config_incomplete");
  const r = await fetch(`${url.replace(/\/$/, "")}/rest/v1/${caminho}`, {
    method: init.method ?? "GET",
    headers: {
      apikey: chave,
      Authorization: `Bearer ${chave}`,
      "content-type": "application/json",
      ...(init.prefer ? { Prefer: init.prefer } : {}),
    },
    body: init.corpo === undefined ? undefined : JSON.stringify(init.corpo),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`db_http_${r.status}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

/** ids vêm do próprio banco (uuid); a lista é conferida antes de entrar na URL. */
function filtroIds(ids: string[]): string {
  if (!ids.every((id) => /^[0-9a-f-]{36}$/i.test(id))) throw new Error("id_invalido");
  return `id=in.(${ids.join(",")})`;
}

// ---------------------------------------------------------------- quem está chamando

interface Usuario {
  id: string;
  cargo: string;
}
async function identificar(jwt: string): Promise<Usuario | null> {
  const url = env("SUPABASE_URL");
  const anon = env("SUPABASE_ANON_KEY");
  if (!url.startsWith("https://") || !anon) throw new Error("backend_config_incomplete");
  const rpc = (fn: string) =>
    fetch(`${url.replace(/\/$/, "")}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { apikey: anon, Authorization: `Bearer ${jwt}`, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(8_000),
    });
  const [rc, ri] = await Promise.all([rpc("crm_cargo_atual"), rpc("advogado_atual_id")]);
  if (!rc.ok || !ri.ok) return null;
  const cargo = await rc.json().catch(() => null);
  const id = await ri.json().catch(() => null);
  if (typeof cargo !== "string" || typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  return { id, cargo };
}

/**
 * Limite por usuário (em memória, por instância): 6 chamadas por minuto. Chamada recusada
 * não entra na conta. Devolve os segundos de espera (0 = liberado).
 */
const chamadas = new Map<string, number[]>();
function esperaDoLimite(usuario: string, agora = Date.now()): number {
  const recentes = (chamadas.get(usuario) ?? []).filter((t) => agora - t < 60_000);
  if (chamadas.size > 1_000) for (const [k, v] of chamadas) if (v.every((t) => agora - t >= 60_000)) chamadas.delete(k);
  if (recentes.length >= CHAMADAS_POR_MINUTO) {
    chamadas.set(usuario, recentes);
    return Math.max(1, Math.ceil((recentes[0] + 60_000 - agora) / 1_000));
  }
  recentes.push(agora);
  chamadas.set(usuario, recentes);
  return 0;
}

// ---------------------------------------------------------------- resumo e avisos

type CodigoAviso =
  | "datajud_chave_recusada"
  | "datajud_sem_chave"
  | "datajud_sobrecarga"
  | "djen_indisponivel"
  | "cnpj_indisponivel"
  | "tempo_esgotado";

interface Aviso {
  codigo: CodigoAviso;
  gravidade: "erro" | "alerta";
  mensagem: string;
}

const MENSAGEM_CHAVE =
  "O DataJud recusou a DATAJUD_API_KEY (HTTP 401/403): o CNJ trocou a chave pública ou ela expirou. " +
  "Copie a chave vigente na Wiki do DataJud (datajud-wiki.cnj.jus.br/api-publica/acesso) e rode " +
  "`supabase secrets set DATAJUD_API_KEY=\"<nova chave>\"`. O secret vale a partir da próxima chamada; se o erro continuar, " +
  "reimplante com `supabase functions deploy prospeccao-execucoes`. A fila (DJEN e contatos) foi processada normalmente.";

interface Resumo {
  novos: number;
  porTribunal: Record<string, { recebidos: number; novos: number; fim: FimDaBusca | "chave_recusada" | "sem_chave" }>;
  consultados: number;
  qualificados: number;
  semPublicacao: number;
  semCnpj: number;
  foraDoFiltro: number;
  erros: number;
  reagendados: number;
  cnpjsEnriquecidos: number;
  fontesIndisponiveis: string[];
  tempoEsgotado: boolean;
  avisos: Aviso[];
}

function avisar(resumo: Resumo, aviso: Aviso): void {
  if (!resumo.avisos.some((a) => a.codigo === aviso.codigo)) resumo.avisos.push(aviso);
}
function fonteFora(resumo: Resumo, fonte: string): void {
  if (!resumo.fontesIndisponiveis.includes(fonte)) resumo.fontesIndisponiveis.push(fonte);
}

// ---------------------------------------------------------------- 1. DataJud

async function gravarNovos(processos: ProcessoEncontrado[]): Promise<number> {
  let novos = 0;
  for (let i = 0; i < processos.length; i += 200) {
    const lote = processos.slice(i, i + 200).map((p) => ({
      numero_cnj: p.numeroCnj,
      tribunal: p.tribunal,
      classe_nome: p.classeNome,
      data_distribuicao: p.dataDistribuicao,
      orgao_julgador: p.orgaoJulgador,
      grau: p.grau,
      valor_causa: p.valorCausa,
      valor_fonte: p.valorCausa === null ? null : "datajud",
    }));
    // Processo já conhecido não é sobrescrito (mantém o que o DJEN já trouxe).
    const r = await db("prosp_processos?on_conflict=numero_cnj&select=id", {
      method: "POST",
      corpo: lote,
      prefer: "resolution=ignore-duplicates,return=representation",
    });
    novos += Array.isArray(r) ? r.length : 0;
  }
  return novos;
}

async function buscarDataJud(
  pedido: { tribunais: Tribunal[]; de: string; ate: string; limite: number },
  prazoFinal: number,
  resumo: Resumo,
): Promise<void> {
  const chave = env("DATAJUD_API_KEY");
  if (!chave) {
    for (const t of pedido.tribunais) resumo.porTribunal[t] = { recebidos: 0, novos: 0, fim: "sem_chave" };
    avisar(resumo, {
      codigo: "datajud_sem_chave",
      gravidade: "erro",
      mensagem: "A Edge Function está sem o secret DATAJUD_API_KEY. Rode `supabase secrets set DATAJUD_API_KEY=\"<chave pública vigente>\"` e tente de novo.",
    });
    return;
  }
  const datajud = fonteDataJud(chave);
  const fimDaBusca = prazoFinal - RESERVA_FILA_MS;
  for (const [i, tribunal] of pedido.tribunais.entries()) {
    const placar = { recebidos: 0, novos: 0, fim: "fim" as Resumo["porTribunal"][string]["fim"] };
    resumo.porTribunal[tribunal] = placar;
    if (Date.now() >= fimDaBusca) {
      placar.fim = "tempo";
      continue;
    }
    try {
      // O tempo que sobra é dividido entre os tribunais que faltam.
      const restantes = pedido.tribunais.length - i;
      const r = await datajud.buscar(
        { tribunal, de: pedido.de, ate: pedido.ate, limite: pedido.limite, prazoFinal: Date.now() + (fimDaBusca - Date.now()) / restantes },
        async (lote) => {
          const n = await gravarNovos(lote);
          placar.novos += n;
          resumo.novos += n;
        },
      );
      placar.recebidos = r.recebidos;
      placar.fim = r.fim;
    } catch (e) {
      if (e instanceof ChaveRecusada) {
        // A chave é a mesma para todos os tribunais: não adianta tentar os outros.
        for (const t of pedido.tribunais.slice(i)) resumo.porTribunal[t] = { ...(resumo.porTribunal[t] ?? { recebidos: 0, novos: 0 }), fim: "chave_recusada" };
        avisar(resumo, { codigo: "datajud_chave_recusada", gravidade: "erro", mensagem: MENSAGEM_CHAVE });
        return;
      }
      if (!(e instanceof FonteIndisponivel)) throw e;
      placar.fim = "sobrecarga";
    }
  }
  const sobrecarregados = Object.entries(resumo.porTribunal).filter(([, p]) => p.fim === "sobrecarga").map(([t]) => t);
  if (sobrecarregados.length) {
    sobrecarregados.forEach((t) => fonteFora(resumo, `datajud_${t}`));
    avisar(resumo, {
      codigo: "datajud_sobrecarga",
      gravidade: "alerta",
      mensagem: `O DataJud está sobrecarregado (${sobrecarregados.join(", ")}). O que já foi recebido está salvo; repita a busca em alguns minutos com o mesmo período: processos já gravados não são duplicados.`,
    });
  }
  const parciais = Object.entries(resumo.porTribunal).filter(([, p]) => p.fim === "tempo").map(([t]) => t);
  if (parciais.length) {
    resumo.tempoEsgotado = true;
    avisar(resumo, {
      codigo: "tempo_esgotado",
      gravidade: "alerta",
      mensagem: `A busca de ${parciais.join(", ")} parou por tempo. Repita com um período menor ou só esses tribunais; o que já veio está salvo.`,
    });
  }
}

// ---------------------------------------------------------------- 2. DJEN (partes e CNPJ)

interface Pendente {
  id: string;
  numero_cnj: string;
  tentativas: number;
  valor_causa: number | null;
}

/** Seleciona e RESERVA os próximos processos (só volta o que esta chamada conseguiu reservar). */
async function reservarPendentes(): Promise<Pendente[]> {
  const agora = encodeURIComponent(new Date().toISOString());
  const candidatos = (await db(
    `prosp_processos?select=id&situacao=in.(pendente,sem_publicacao,sem_cnpj,erro)&proxima_tentativa_em=lte.${agora}` +
      `&tentativas=lt.${MAX_TENTATIVAS}&order=data_distribuicao.desc.nullslast&limit=${LOTE_DJEN}`,
  )) as { id: string }[];
  if (!candidatos?.length) return [];
  // UPDATE ... WHERE id IN (...) AND proxima_tentativa_em <= agora: se outra chamada reservou
  // antes, a linha não volta aqui.
  return (await db(
    `prosp_processos?${filtroIds(candidatos.map((c) => c.id))}&proxima_tentativa_em=lte.${agora}` +
      `&select=id,numero_cnj,tentativas,valor_causa`,
    { method: "PATCH", corpo: { proxima_tentativa_em: daquiA(RESERVA_MS) }, prefer: "return=representation" },
  )) as Pendente[];
}

async function devolverAFila(ids: string[], emMs = 0): Promise<void> {
  if (!ids.length) return;
  await db(`prosp_processos?${filtroIds(ids)}`, {
    method: "PATCH",
    corpo: { proxima_tentativa_em: daquiA(emMs) },
    prefer: "return=minimal",
  }).catch(() => {}); // se falhar, a reserva de 3 min expira sozinha
}

async function processarPartes(prazoFinal: number, resumo: Resumo): Promise<void> {
  const reservados = await reservarPendentes();
  const naoTentados = new Set(reservados.map((p) => p.id));
  let falhasSeguidas = 0;
  try {
    for (const p of reservados) {
      if (Date.now() > prazoFinal) {
        resumo.tempoEsgotado = true;
        avisar(resumo, { codigo: "tempo_esgotado", gravidade: "alerta", mensagem: "O tempo desta execução acabou. Clique em \"Processar fila\" para continuar de onde parou." });
        return;
      }
      naoTentados.delete(p.id);
      try {
        const partes = await fonteDjen.consultar(p.numero_cnj, prazoFinal + 10_000);
        falhasSeguidas = 0;
        const situacao = classificar(partes);
        const atualizacao: Record<string, unknown> = {
          situacao,
          tentativas: p.tentativas + 1,
          consultado_em: new Date().toISOString(),
          proxima_tentativa_em: daquiA(diasAteNovaTentativa(p.tentativas) * 86_400_000),
        };
        if (partes) {
          const cnpj = partes.cnpj && cnpjValido(partes.cnpj) ? partes.cnpj : null;
          atualizacao.polo_ativo = partes.poloAtivo;
          atualizacao.polo_ativo_fazenda = partes.poloAtivoFazenda;
          // LGPD: nome do executado só é guardado quando é pessoa jurídica (CNPJ identificado e
          // sem CPF no nome).
          atualizacao.executado_nome = cnpj && !pareceEmpresarioIndividual(partes.executado) ? partes.executado : null;
          atualizacao.cnpj = cnpj;
          atualizacao.fonte_partes = "djen";
          if (p.valor_causa === null && partes.valorCausa !== null) {
            atualizacao.valor_causa = partes.valorCausa;
            atualizacao.valor_fonte = "djen";
          }
        }
        await db(`prosp_processos?id=eq.${p.id}`, { method: "PATCH", corpo: atualizacao, prefer: "return=minimal" });
        resumo.consultados++;
        if (situacao === "qualificado") resumo.qualificados++;
        else if (situacao === "sem_publicacao") resumo.semPublicacao++;
        else if (situacao === "sem_cnpj") resumo.semCnpj++;
        else resumo.foraDoFiltro++;
      } catch (e) {
        if (e instanceof FonteIndisponivel) {
          // Fonte fora do ar ou no limite: não gasta tentativa nem muda a situação.
          resumo.reagendados++;
          fonteFora(resumo, "djen");
          await devolverAFila([p.id], REAGENDAR_FONTE_FORA_MS);
          falhasSeguidas++;
          if (e.limiteDeUso || falhasSeguidas >= MAX_FALHAS_SEGUIDAS) {
            avisar(resumo, {
              codigo: "djen_indisponivel",
              gravidade: "alerta",
              mensagem: e.limiteDeUso
                ? "O DJEN pediu para reduzir o ritmo (limite de uso). Nada foi perdido: os processos continuam na fila. Tente \"Processar fila\" em alguns minutos."
                : "O DJEN não está respondendo. Nada foi perdido: os processos continuam na fila. Tente \"Processar fila\" mais tarde.",
            });
            return;
          }
        } else {
          // Falha inesperada (resposta fora do padrão ou banco): conta tentativa e espera 1 h.
          resumo.erros++;
          await db(`prosp_processos?id=eq.${p.id}`, {
            method: "PATCH",
            corpo: { situacao: "erro", tentativas: p.tentativas + 1, proxima_tentativa_em: daquiA(3_600_000) },
            prefer: "return=minimal",
          }).catch(() => {});
        }
      }
      await esperar(PAUSA_DJEN_MS);
    }
  } finally {
    // Reservados que não chegaram a ser consultados voltam para a fila já.
    await devolverAFila([...naoTentados]);
  }
}

// ---------------------------------------------------------------- 3. contato (base CNPJ)

type ResultadoContato = { fonte: string; dados: DadosCnpj | null } | { indisponivel: true; limiteDeUso: boolean };

async function consultarContato(cnpj: string, prazoFinal: number): Promise<ResultadoContato> {
  let limiteDeUso = false;
  for (const fonte of FONTES_CONTATO) {
    if (Date.now() > prazoFinal) break;
    try {
      return { fonte: fonte.nome, dados: await fonte.consultar(cnpj, prazoFinal + 10_000) };
    } catch (e) {
      if (!(e instanceof FonteIndisponivel)) throw e;
      limiteDeUso ||= e.limiteDeUso;
    }
  }
  return { indisponivel: true, limiteDeUso };
}

async function enriquecerContatos(prazoFinal: number, resumo: Resumo): Promise<void> {
  // O cache é a "fila": CNPJ sem contato (ou com mais de 30 dias) entra; nada é perdido se parar.
  const fila = (await db("rpc/prosp_cnpjs_para_enriquecer", { method: "POST", corpo: { p_limite: LOTE_CNPJ } })) as { cnpj: string }[];
  for (const { cnpj } of fila ?? []) {
    if (Date.now() > prazoFinal) {
      resumo.tempoEsgotado = true;
      avisar(resumo, { codigo: "tempo_esgotado", gravidade: "alerta", mensagem: "O tempo desta execução acabou. Clique em \"Processar fila\" para continuar de onde parou." });
      return;
    }
    if (!cnpjValido(cnpj)) continue;
    const r = await consultarContato(cnpj, prazoFinal);
    if ("indisponivel" in r) {
      fonteFora(resumo, "cnpj");
      avisar(resumo, {
        codigo: "cnpj_indisponivel",
        gravidade: "alerta",
        mensagem: r.limiteDeUso
          ? "As consultas públicas de CNPJ atingiram o limite de uso. Os contatos já obtidos estão salvos; os demais serão buscados no próximo \"Processar fila\" (aguarde alguns minutos)."
          : "As consultas públicas de CNPJ não responderam agora. Os contatos já obtidos estão salvos; tente \"Processar fila\" mais tarde.",
      });
      return;
    }
    const d = r.dados;
    await db("prosp_cnpj_cache?on_conflict=cnpj", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=minimal",
      corpo: {
        cnpj,
        encontrado: d !== null,
        fonte: r.fonte,
        razao_social: d?.razaoSocial ?? null,
        nome_fantasia: d?.nomeFantasia ?? null,
        situacao_cadastral: d?.situacaoCadastral ?? null,
        natureza_juridica: d?.naturezaJuridica ?? null,
        uf: d?.uf ?? null,
        municipio: d?.municipio ?? null,
        telefones: d?.telefones ?? [],
        email: d?.email ?? null,
        consultado_em: new Date().toISOString(),
      },
    });
    resumo.cnpjsEnriquecidos++;
    await esperar(PAUSA_CNPJ_MS);
  }
}

async function pendentesNaFila(): Promise<number | null> {
  const url = env("SUPABASE_URL");
  const chave = env("SUPABASE_SERVICE_ROLE_KEY");
  const r = await fetch(
    `${url.replace(/\/$/, "")}/rest/v1/prosp_processos?select=id&situacao=in.(pendente,erro)&tentativas=lt.${MAX_TENTATIVAS}`,
    { method: "HEAD", headers: { apikey: chave, Authorization: `Bearer ${chave}`, Prefer: "count=exact" }, signal: AbortSignal.timeout(8_000) },
  ).catch(() => null);
  const total = r?.headers.get("content-range")?.split("/")[1];
  return total && /^\d+$/.test(total) ? Number(total) : null;
}

// ---------------------------------------------------------------- servidor

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cabecalhosCors(req) });
  const ip = ipDe(req);
  if (bloqueado(ip)) return responder(req, 429, { erro: "Muitas tentativas. Aguarde um minuto.", aguardeSegundos: 60 }, { "retry-after": "60" });
  if (req.method !== "POST") return responder(req, 405, { erro: "Método não permitido." });

  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  let usuario: Usuario | null = null;
  try {
    usuario = jwt ? await identificar(jwt) : null;
  } catch {
    return responder(req, 503, { erro: "Serviço indisponível." });
  }
  if (!usuario) {
    registrarFalha(ip);
    return responder(req, 401, { erro: "Sessão inválida. Entre de novo no CRM." });
  }
  if (usuario.cargo !== "socio" && usuario.cargo !== "advogado") {
    registrarFalha(ip);
    return responder(req, 403, { erro: "Disponível apenas para sócios e advogados titulares." });
  }

  const bruto = await req.text();
  if (bruto.length > 4_096) return responder(req, 413, { erro: "Pedido grande demais." });
  let corpo: unknown;
  try {
    corpo = JSON.parse(bruto);
  } catch {
    return responder(req, 400, { erro: "JSON inválido." });
  }
  const pedido = validarPedido(corpo);
  if ("erro" in pedido) return responder(req, 400, { erro: pedido.erro });

  const espera = esperaDoLimite(usuario.id);
  if (espera) {
    return responder(req, 429, { erro: `Limite de ${CHAMADAS_POR_MINUTO} execuções por minuto. Aguarde ${espera} s.`, aguardeSegundos: espera },
      { "retry-after": String(espera) });
  }

  const prazoFinal = Date.now() + ORCAMENTO_MS;
  const resumo: Resumo = {
    novos: 0, porTribunal: {}, consultados: 0, qualificados: 0, semPublicacao: 0, semCnpj: 0, foraDoFiltro: 0, erros: 0,
    reagendados: 0, cnpjsEnriquecidos: 0, fontesIndisponiveis: [], tempoEsgotado: false, avisos: [],
  };

  try {
    if (pedido.acao === "buscar") await buscarDataJud(pedido, prazoFinal, resumo);
    await processarPartes(prazoFinal, resumo);
    if (Date.now() < prazoFinal) await enriquecerContatos(prazoFinal, resumo);
  } catch {
    // Banco ou falha inesperada: o que já foi gravado fica; reservas expiram em 3 min.
    return responder(req, 503, {
      erro: "Não foi possível concluir agora. O que já foi processado está salvo; tente de novo em alguns minutos.",
      ...resumo,
    });
  }

  await db("prosp_auditoria", {
    method: "POST",
    prefer: "return=minimal",
    corpo: {
      advogado_id: usuario.id,
      acao: pedido.acao === "buscar" ? "busca" : "processamento",
      parametros: pedido.acao === "buscar"
        ? { tribunais: pedido.tribunais, de: pedido.de, ate: pedido.ate, limite: pedido.limite, avisos: resumo.avisos.map((a) => a.codigo) }
        : { avisos: resumo.avisos.map((a) => a.codigo) },
      qtd_registros: pedido.acao === "buscar" ? resumo.novos : resumo.consultados,
    },
  }).catch(() => {});

  return responder(req, 200, { ...resumo, pendentes: await pendentesNaFila() });
});

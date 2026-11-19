import type { PostgrestError } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase/client";
import type { Temperatura } from "@/lib/leads";

/**
 * Funil de atendimento, motivos de perda e cadência de follow-up (migração
 * 20261118_v6_funil_followup.sql), segundo o documento "CRM de leads de anúncio", seções 2, 5 e 7.
 * Tudo que é cálculo aqui é puro (testável sem rede); o banco guarda etapa, datas e toques.
 */

// ---------- etapas ----------

export const ETAPAS = [
  "novo_lead",
  "primeiro_contato",
  "em_conversa",
  "horario_confirmado",
  "diagnostico_ofertado",
  "diagnostico_pago",
  "em_analise",
  "proposta",
  "cliente_ativo",
  "encerrado",
  "sem_resposta",
  "perdido",
] as const;
export type EtapaFunil = (typeof ETAPAS)[number];

export interface InfoEtapa {
  /** 1–10 nas ativas; null nas saídas. */
  numero: number | null;
  label: string;
  tipo: "ativa" | "saida";
  entra: string;
  sai: string;
  /** Tempo máximo na etapa, em horas; null = sem limite (data marcada, até o fim do acordo...). */
  tempoMaxHoras: number | null;
  tempoMaxLabel: string;
  cor: string;
}

export const ETAPA_INFO: Record<EtapaFunil, InfoEtapa> = {
  novo_lead: { numero: 1, label: "Novo lead", tipo: "ativa", entra: "O formulário ou a conversa chega", sai: "A primeira mensagem é enviada", tempoMaxHoras: 0.25, tempoMaxLabel: "15 min (horário comercial)", cor: "bg-sky-50 text-sky-800 ring-sky-600/25" },
  primeiro_contato: { numero: 2, label: "Primeiro contato", tipo: "ativa", entra: "Mensagem enviada", sai: "O lead responde", tempoMaxHoras: 72, tempoMaxLabel: "3 dias", cor: "bg-sky-50 text-sky-800 ring-sky-600/25" },
  em_conversa: { numero: 3, label: "Em conversa", tipo: "ativa", entra: "O lead respondeu", sai: "Aparece uma dor e a ligação é marcada", tempoMaxHoras: 48, tempoMaxLabel: "2 dias", cor: "bg-indigo-50 text-indigo-800 ring-indigo-600/25" },
  horario_confirmado: { numero: 4, label: "Horário confirmado", tipo: "ativa", entra: "Horário da ligação confirmado", sai: "A ligação acontece", tempoMaxHoras: null, tempoMaxLabel: "Data marcada", cor: "bg-indigo-50 text-indigo-800 ring-indigo-600/25" },
  diagnostico_ofertado: { numero: 5, label: "Diagnóstico ofertado", tipo: "ativa", entra: "Valor apresentado na conversa", sai: "Pagamento ou recusa", tempoMaxHoras: 72, tempoMaxLabel: "3 dias", cor: "bg-violet-50 text-violet-800 ring-violet-600/25" },
  diagnostico_pago: { numero: 6, label: "Diagnóstico pago", tipo: "ativa", entra: "Pagamento confirmado", sai: "Procuração cadastrada (e-CAC/sistemas)", tempoMaxHoras: 24, tempoMaxLabel: "1 dia", cor: "bg-violet-50 text-violet-800 ring-violet-600/25" },
  em_analise: { numero: 7, label: "Em análise", tipo: "ativa", entra: "Procuração ativa", sai: "Parecer entregue por escrito", tempoMaxHoras: 24, tempoMaxLabel: "24 horas", cor: "bg-amber-50 text-amber-800 ring-amber-600/25" },
  proposta: { numero: 8, label: "Proposta", tipo: "ativa", entra: "Reunião feita e honorários apresentados", sai: "Contrato assinado ou recusa", tempoMaxHoras: 120, tempoMaxLabel: "5 dias", cor: "bg-amber-50 text-amber-800 ring-amber-600/25" },
  cliente_ativo: { numero: 9, label: "Cliente ativo", tipo: "ativa", entra: "Contrato assinado e 1ª parcela paga", sai: "Caso encerrado", tempoMaxHoras: null, tempoMaxLabel: "Até o fim do acordo", cor: "bg-emerald-50 text-emerald-800 ring-emerald-600/25" },
  encerrado: { numero: 10, label: "Encerrado", tipo: "ativa", entra: "Acordo quitado ou processo extinto", sai: "Pedido de indicação feito", tempoMaxHoras: null, tempoMaxLabel: "7 dias para pedir indicação", cor: "bg-slate-100 text-slate-700 ring-slate-500/25" },
  sem_resposta: { numero: null, label: "Sem resposta", tipo: "saida", entra: "Tentativas sem retorno", sai: "Responde e volta para Em conversa", tempoMaxHoras: null, tempoMaxLabel: "Nutrição por 90 dias", cor: "bg-orange-50 text-orange-800 ring-orange-600/25" },
  perdido: { numero: null, label: "Perdido", tipo: "saida", entra: "Recusou, contratou outro ou sem perfil", sai: "Pode ser reativado em 90 dias", tempoMaxHoras: null, tempoMaxLabel: "—", cor: "bg-red-50 text-red-800 ring-red-600/25" },
};

export function isEtapa(v: unknown): v is EtapaFunil {
  return typeof v === "string" && (ETAPAS as readonly string[]).includes(v);
}

/** Etapas em que o lead ainda está "vivo" (regra de ouro: exige próxima ação). */
export function etapaAtiva(e: EtapaFunil): boolean {
  return e !== "encerrado" && e !== "perdido";
}

// ---------- motivos de perda ----------

export const MOTIVOS_PERDA = [
  "preco",
  "ja_tem_advogado",
  "resolveu_sozinho",
  "divida_pequena",
  "sem_urgencia",
  "nao_respondeu",
  "desconfianca",
] as const;
export type MotivoPerda = (typeof MOTIVOS_PERDA)[number];

export const MOTIVO_PERDA_LABEL: Record<MotivoPerda, string> = {
  preco: "Preço",
  ja_tem_advogado: "Já tem advogado",
  resolveu_sozinho: "Resolveu sozinho",
  divida_pequena: "Dívida/causa pequena demais",
  sem_urgencia: "Sem urgência",
  nao_respondeu: "Não respondeu",
  desconfianca: "Desconfiança",
};

export function isMotivoPerda(v: unknown): v is MotivoPerda {
  return typeof v === "string" && (MOTIVOS_PERDA as readonly string[]).includes(v);
}

/** Dados do funil na ficha. disponivel = false quando o banco ainda não tem a v6. */
export interface FunilFicha {
  disponivel: boolean;
  etapa: EtapaFunil;
  etapa_desde: string | null;
  motivo_perda: MotivoPerda | null;
  motivo_perda_detalhe: string | null;
  cadencia_desde: string | null;
  nao_contatar: boolean;
}

export const FUNIL_INDISPONIVEL: FunilFicha = {
  disponivel: false,
  etapa: "novo_lead",
  etapa_desde: null,
  motivo_perda: null,
  motivo_perda_detalhe: null,
  cadencia_desde: null,
  nao_contatar: false,
};

/** Horas além do tempo máximo da etapa (0 = dentro do prazo ou sem limite). */
export function horasAlemDoLimite(f: Pick<FunilFicha, "etapa" | "etapa_desde">, agora = new Date()): number {
  const max = ETAPA_INFO[f.etapa].tempoMaxHoras;
  if (max === null || !f.etapa_desde) return 0;
  const horas = (agora.getTime() - new Date(f.etapa_desde).getTime()) / 3_600_000;
  return Math.max(0, horas - max);
}

// ---------- cadência de follow-up (seção 5 do documento) ----------

export type CanalToque = "whatsapp" | "audio" | "ligacao" | "email" | "outro";
export const CANAL_LABEL: Record<CanalToque, string> = {
  whatsapp: "WhatsApp",
  audio: "Áudio (até 30 s) ou texto",
  ligacao: "Ligação",
  email: "E-mail",
  outro: "Outro",
};

export interface PassoCadencia {
  /** Dias depois do início da cadência (cadencia_desde ou a última resposta do lead). */
  dia: number;
  canal: CanalToque;
  titulo: string;
  /** Mensagem pronta sugerida (src/lib/mensagens-prontas.ts). */
  mensagemId?: string;
  /** Etapa para onde o lead vai quando este toque é registrado. */
  avancaPara?: EtapaFunil;
}

/**
 * Cadências por etapa. primeiro_contato e sem_resposta compartilham o mesmo relógio
 * (o trigger não reinicia cadencia_desde nessa passagem): a nutrição 30/60/90 conta do 1º contato.
 */
export const CADENCIAS: Partial<Record<EtapaFunil, PassoCadencia[]>> = {
  novo_lead: [
    { dia: 0, canal: "whatsapp", titulo: "Primeira mensagem (Situação + \"prefere texto ou áudio?\")", mensagemId: "primeiro_contato_formulario", avancaPara: "primeiro_contato" },
  ],
  primeiro_contato: [
    { dia: 1, canal: "audio", titulo: "Apresentação curta e a mesma pergunta em outras palavras" },
    { dia: 3, canal: "whatsapp", titulo: "Retomada leve: \"conseguiu ver minha mensagem?\"" },
    { dia: 7, canal: "ligacao", titulo: "Ligação: uma tentativa, sem recado longo" },
    { dia: 14, canal: "whatsapp", titulo: "Encerramento educado, deixando a porta aberta", mensagemId: "objecao_sem_interesse", avancaPara: "sem_resposta" },
  ],
  sem_resposta: [
    { dia: 30, canal: "whatsapp", titulo: "Nutrição: uma informação útil, sem oferta" },
    { dia: 60, canal: "whatsapp", titulo: "Nutrição: uma informação útil, sem oferta" },
    { dia: 90, canal: "whatsapp", titulo: "Nutrição final: uma informação útil, sem oferta" },
  ],
  em_conversa: [
    { dia: 1, canal: "whatsapp", titulo: "Retomar a dor com as palavras dele e oferecer dois horários", mensagemId: "spin_convite_ligacao" },
    { dia: 3, canal: "whatsapp", titulo: "Pergunta de Implicação", mensagemId: "spin_implicacao" },
    { dia: 7, canal: "whatsapp", titulo: "Última tentativa" },
  ],
  diagnostico_ofertado: [
    { dia: 0, canal: "whatsapp", titulo: "\"Vou pensar\": o que pesa mais na decisão?", mensagemId: "objecao_vou_pensar" },
    { dia: 2, canal: "whatsapp", titulo: "Simulação parecida, sempre como exemplo (sem valores por escrito)" },
    { dia: 5, canal: "whatsapp", titulo: "Retomada final (se não avançar, registre o motivo de perda)" },
  ],
  proposta: [
    { dia: 1, canal: "whatsapp", titulo: "Alguma dúvida sobre o parecer?" },
    { dia: 3, canal: "ligacao", titulo: "Apresentar a forma parcelada (na conversa, não por escrito)" },
    { dia: 7, canal: "whatsapp", titulo: "Prazo do edital ou risco processual, só se for real" },
  ],
  encerrado: [{ dia: 1, canal: "whatsapp", titulo: "Pedir indicação (até 7 dias após o encerramento)" }],
};

/** Etapas em que a resposta do lead significa avançar no funil (a cadência fica pausada até mudar a etapa). */
const RESPOSTA_AVANCA: readonly EtapaFunil[] = ["novo_lead", "primeiro_contato", "sem_resposta"];

export interface ToqueRegistrado {
  ficha_id: string;
  etapa: string;
  passo: number;
  ciclo: string;
  criado_em: string;
}

export interface ContatoLead {
  /** Última mensagem do cliente (dfu_atendimentos), se houver conversa no bot. */
  ultima_msg_cliente_em: string | null;
  /** Opt-out no WhatsApp (descadastrado/bloqueado). */
  optout: boolean;
  telefone?: string;
}

export type EstadoCadencia =
  | { tipo: "sem_cadencia" }
  | { tipo: "bloqueada"; motivo: "nao_contatar" | "optout" }
  | { tipo: "pausada"; respondeuEm: string; sugestao: EtapaFunil }
  | { tipo: "concluida" }
  | {
      tipo: "pendente";
      passo: PassoCadencia;
      indice: number;
      total: number;
      devidoEm: Date;
      situacao: "vencido" | "hoje" | "futuro";
      /** Lead respondeu depois do início: a sequência recomeçou a partir dessa resposta. */
      reiniciadaPorResposta: boolean;
    };

const DIA_MS = 86_400_000;

function inicioDoDia(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Dia do toque às 9h; domingo passa para segunda (exceto urgente). Dia 0: 15 min (5 se urgente). */
export function dataDoPasso(ancora: Date, dia: number, urgente: boolean): Date {
  if (dia === 0) return new Date(ancora.getTime() + (urgente ? 5 : 15) * 60_000);
  const d = inicioDoDia(ancora);
  d.setDate(d.getDate() + dia);
  d.setHours(9, 0, 0, 0);
  if (!urgente && d.getDay() === 0) d.setDate(d.getDate() + 1);
  return d;
}

/**
 * Próximo toque da cadência. Regras (documento, seção 5):
 *  - "não contatar" ou opt-out no WhatsApp: nenhuma sequência (definitivo);
 *  - o lead respondeu depois do início: em novo/primeiro contato/sem resposta, a cadência
 *    PAUSA até a etapa mudar (sugere "Em conversa"); nas demais, recomeça a contar da resposta;
 *  - no máximo um toque por dia; nada aos domingos (exceto urgente).
 */
export function estadoCadencia(
  f: { funil: FunilFicha; temperatura: Temperatura | null },
  toques: ToqueRegistrado[],
  contato: ContatoLead | undefined,
  agora = new Date(),
): EstadoCadencia {
  const passos = CADENCIAS[f.funil.etapa];
  if (!f.funil.disponivel || !passos || !f.funil.cadencia_desde) return { tipo: "sem_cadencia" };
  if (f.funil.nao_contatar) return { tipo: "bloqueada", motivo: "nao_contatar" };
  if (contato?.optout) return { tipo: "bloqueada", motivo: "optout" };

  const inicio = new Date(f.funil.cadencia_desde);
  const resposta = contato?.ultima_msg_cliente_em ? new Date(contato.ultima_msg_cliente_em) : null;
  const respondeu = resposta !== null && resposta.getTime() > inicio.getTime();
  if (respondeu && RESPOSTA_AVANCA.includes(f.funil.etapa)) {
    return { tipo: "pausada", respondeuEm: resposta.toISOString(), sugestao: "em_conversa" };
  }
  const ancora = respondeu ? resposta : inicio;

  // Mesmo ciclo = mesmo cadencia_desde (comparado como instante: o texto do timestamp pode variar).
  const doCiclo = toques.filter(
    (t) =>
      t.etapa === f.funil.etapa &&
      new Date(t.ciclo).getTime() === inicio.getTime() &&
      new Date(t.criado_em).getTime() >= ancora.getTime(),
  );
  const feitos = new Set(doCiclo.map((t) => t.passo));
  const indice = passos.findIndex((p) => !feitos.has(p.dia));
  if (indice < 0) return { tipo: "concluida" };
  const passo = passos[indice];
  const urgente = f.temperatura === "urgente";

  let devidoEm = dataDoPasso(ancora, passo.dia, urgente);
  // No máximo um toque por dia: se já houve toque hoje (ou depois), o próximo vai para o dia seguinte.
  const ultimo = doCiclo.reduce<Date | null>((m, t) => {
    const d = new Date(t.criado_em);
    return !m || d > m ? d : m;
  }, null);
  if (ultimo && inicioDoDia(devidoEm).getTime() <= inicioDoDia(ultimo).getTime()) {
    devidoEm = dataDoPasso(ultimo, 1, urgente);
  }

  const hoje = inicioDoDia(agora).getTime();
  const situacao =
    devidoEm.getTime() < agora.getTime() && (passo.dia === 0 || inicioDoDia(devidoEm).getTime() < hoje)
      ? "vencido"
      : inicioDoDia(devidoEm).getTime() === hoje
        ? "hoje"
        : "futuro";
  return { tipo: "pendente", passo, indice, total: passos.length, devidoEm, situacao, reiniciadaPorResposta: respondeu };
}

/**
 * Toque seguinte depois de registrar `atual` (para preencher a próxima ação).
 * - mudou de etapa: 1º passo da nova cadência, contado de agora (o trigger reinicia
 *   cadencia_desde), exceto primeiro_contato → sem_resposta, que mantém o relógio do 1º contato;
 * - mesma etapa: o passo seguinte, contado do mesmo início, nunca no mesmo dia do toque.
 * null = a cadência acabou (o usuário define a próxima ação).
 */
export function proximoAposToque(
  f: { funil: FunilFicha; temperatura: Temperatura | null },
  atual: { indice: number; reiniciadaPorResposta: boolean },
  novaEtapa: EtapaFunil | null,
  contato: ContatoLead | undefined,
  agora = new Date(),
): { etapa: EtapaFunil; passo: PassoCadencia; devidoEm: Date } | null {
  const urgente = f.temperatura === "urgente";
  const etapa = novaEtapa ?? f.funil.etapa;
  const passos = CADENCIAS[etapa];
  if (!passos || passos.length === 0) return null;

  let ancora: Date;
  let indice: number;
  if (novaEtapa && novaEtapa !== f.funil.etapa) {
    const mantemRelogio = f.funil.etapa === "primeiro_contato" && novaEtapa === "sem_resposta";
    ancora = mantemRelogio && f.funil.cadencia_desde ? new Date(f.funil.cadencia_desde) : agora;
    indice = 0;
  } else {
    const resposta = contato?.ultima_msg_cliente_em ? new Date(contato.ultima_msg_cliente_em) : null;
    ancora = atual.reiniciadaPorResposta && resposta ? resposta : new Date(f.funil.cadencia_desde ?? agora);
    indice = atual.indice + 1;
  }
  const passo = passos[indice];
  if (!passo) return null;
  let devidoEm = dataDoPasso(ancora, passo.dia, urgente);
  const amanha = dataDoPasso(agora, 1, urgente);
  if (devidoEm.getTime() < amanha.getTime() && inicioDoDia(devidoEm).getTime() <= inicioDoDia(agora).getTime()) devidoEm = amanha;
  return { etapa, passo, devidoEm };
}

/** Perdido ou Sem resposta há 90 dias: pode voltar para a nutrição. */
export function reativavel(f: Pick<FunilFicha, "etapa" | "etapa_desde">, agora = new Date()): boolean {
  if ((f.etapa !== "perdido" && f.etapa !== "sem_resposta") || !f.etapa_desde) return false;
  return agora.getTime() - new Date(f.etapa_desde).getTime() >= 90 * DIA_MS;
}

/** Texto da próxima ação gerado a partir de um passo da cadência. */
export function textoProximaAcao(etapa: EtapaFunil, p: PassoCadencia): string {
  return `Follow-up dia ${p.dia} (${ETAPA_INFO[etapa].label}): ${p.titulo}`.slice(0, 280);
}

/** Link wa.me com o texto pronto (o envio é feito pelo WhatsApp de quem atende). */
export function linkWhatsApp(telefone: string, texto: string): string | null {
  const d = telefone.replace(/\D/g, "");
  if (d.length < 10) return null;
  return `https://wa.me/${d}?text=${encodeURIComponent(texto)}`;
}

// ---------- lista de tarefas do dia (seção 7 do documento) ----------

export type TipoTarefa = "toque" | "respondeu" | "proxima_acao" | "parado" | "reativavel";

export interface Tarefa {
  chave: string;
  fichaId: string;
  tipo: TipoTarefa;
  /** Vencida vai para o topo, em vermelho. */
  vencida: boolean;
  quando: Date | null;
  titulo: string;
  detalhe: string;
  /** Ordem de atendimento (cor do lead); menor = antes. */
  nivel: number;
}

/** Ficha mínima para montar tarefas (evita depender do módulo de fichas). */
export interface FichaParaTarefa {
  id: string;
  nome_cliente: string;
  status_original: string;
  lead: { disponivel: boolean; temperatura: Temperatura | null; proxima_acao: string | null; proxima_acao_em: string | null };
  funil: FunilFicha;
}

const fmtCurto = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

function horasTexto(h: number): string {
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${Math.round(h)} h`;
  return `${Math.round(h / 24)} dias`;
}

/**
 * Tarefas de hoje e atrasadas, uma lista única: toques de follow-up, leads que responderam
 * (cadência pausada), próximas ações vencidas/de hoje (quando não há cadência cuidando),
 * leads parados além do tempo máximo e reativáveis. Ordem: vencidas → cor do lead → horário.
 */
export function montarTarefas(
  fichas: FichaParaTarefa[],
  estados: Map<string, EstadoCadencia>,
  agora = new Date(),
  nivel: (f: FichaParaTarefa) => number = () => 0,
): Tarefa[] {
  const tarefas: Tarefa[] = [];
  const fimDoDia = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate() + 1).getTime();
  for (const f of fichas) {
    if (!f.lead.disponivel) continue;
    const n = nivel(f);
    const est = estados.get(f.id) ?? { tipo: "sem_cadencia" };
    let temToque = false;
    if (est.tipo === "pendente" && est.situacao !== "futuro") {
      temToque = true;
      tarefas.push({
        chave: `toque:${f.id}`,
        fichaId: f.id,
        tipo: "toque",
        vencida: est.situacao === "vencido",
        quando: est.devidoEm,
        titulo: `Follow-up dia ${est.passo.dia}: ${est.passo.titulo}`,
        detalhe: `${ETAPA_INFO[f.funil.etapa].label} · ${CANAL_LABEL[est.passo.canal]} · toque ${est.indice + 1} de ${est.total}`,
        nivel: n,
      });
    } else if (est.tipo === "pausada") {
      temToque = true;
      tarefas.push({
        chave: `resp:${f.id}`,
        fichaId: f.id,
        tipo: "respondeu",
        vencida: false,
        quando: new Date(est.respondeuEm),
        titulo: "Lead respondeu: cadência pausada",
        detalhe: `Respondeu em ${fmtCurto.format(new Date(est.respondeuEm))}. Mova para "${ETAPA_INFO[est.sugestao].label}" e continue a conversa.`,
        nivel: n - 0.5,
      });
    }
    const ativo = f.funil.disponivel ? etapaAtiva(f.funil.etapa) : f.status_original.trim().toLowerCase() !== "finalizado";
    if (!temToque && ativo && f.lead.proxima_acao_em) {
      const q = new Date(f.lead.proxima_acao_em);
      if (q.getTime() < fimDoDia) {
        tarefas.push({
          chave: `acao:${f.id}`,
          fichaId: f.id,
          tipo: "proxima_acao",
          vencida: q.getTime() < agora.getTime(),
          quando: q,
          titulo: f.lead.proxima_acao ?? "Próxima ação",
          detalhe: f.funil.disponivel ? ETAPA_INFO[f.funil.etapa].label : "Próxima ação",
          nivel: n,
        });
      }
    }
    if (f.funil.disponivel) {
      const alem = horasAlemDoLimite(f.funil, agora);
      if (alem > 0) {
        tarefas.push({
          chave: `parado:${f.id}`,
          fichaId: f.id,
          tipo: "parado",
          vencida: false,
          quando: null,
          titulo: `Parado em "${ETAPA_INFO[f.funil.etapa].label}"`,
          detalhe: `${horasTexto(alem)} além do tempo máximo (${ETAPA_INFO[f.funil.etapa].tempoMaxLabel}).`,
          nivel: n + 0.5,
        });
      }
      if (reativavel(f.funil, agora) && !f.funil.nao_contatar) {
        tarefas.push({
          chave: `reat:${f.id}`,
          fichaId: f.id,
          tipo: "reativavel",
          vencida: false,
          quando: null,
          titulo: "Lead reativável",
          detalhe: `${ETAPA_INFO[f.funil.etapa].label} há mais de 90 dias: pode voltar para a nutrição.`,
          nivel: 10,
        });
      }
    }
  }
  return tarefas.sort(
    (a, b) =>
      Number(b.vencida) - Number(a.vencida) ||
      a.nivel - b.nivel ||
      (a.quando?.getTime() ?? Infinity) - (b.quando?.getTime() ?? Infinity),
  );
}

// ---------- dados ----------

/** Toques e últimas mensagens dos leads visíveis (RLS). Silencioso sem a v6 ou sem o bot. */
export async function carregarFollowup(fichaIds: string[]): Promise<{ toques: ToqueRegistrado[]; contatos: Map<string, ContatoLead> }> {
  const contatos = new Map<string, ContatoLead>();
  if (fichaIds.length === 0) return { toques: [], contatos };
  const desde = new Date(Date.now() - 200 * DIA_MS).toISOString();
  const lotes: string[][] = [];
  for (let i = 0; i < fichaIds.length; i += 150) lotes.push(fichaIds.slice(i, i + 150));

  const toques: ToqueRegistrado[] = [];
  for (const ids of lotes) {
    const [t, a] = await Promise.all([
      supabase
        .from("crm_followup_toques")
        .select("ficha_id,etapa,passo,ciclo,criado_em")
        .in("ficha_id", ids)
        .gte("criado_em", desde)
        .overrideTypes<ToqueRegistrado[], { merge: false }>(),
      supabase
        .from("dfu_atendimentos")
        .select("ficha_id,telefone,ultima_msg_cliente_em,bloqueado,status")
        .in("ficha_id", ids)
        .overrideTypes<{ ficha_id: string; telefone: string; ultima_msg_cliente_em: string | null; bloqueado: boolean; status: string }[], { merge: false }>(),
    ]);
    if (t.error && !ausente(t.error)) console.error("Erro ao carregar toques:", t.error.code, t.error.message);
    if (a.error && !ausente(a.error)) console.error("Erro ao carregar conversas:", a.error.code, a.error.message);
    toques.push(...(t.data ?? []));
    for (const at of a.data ?? []) {
      contatos.set(at.ficha_id, {
        ultima_msg_cliente_em: at.ultima_msg_cliente_em,
        optout: at.bloqueado || at.status === "descadastrado",
        telefone: at.telefone,
      });
    }
  }
  return { toques, contatos };
}

const ausente = (e: PostgrestError) => ["PGRST205", "42P01", "42703"].includes(e.code);

export interface DadosToque {
  fichaId: string;
  etapa: EtapaFunil;
  passo: number;
  canal: CanalToque;
  resultado: "feito" | "pulado";
  nota: string | null;
  novaEtapa: EtapaFunil | null;
  proximaAcao: string | null;
  proximaAcaoEm: string | null;
}

/** Registra o toque e agenda a próxima ação na mesma transação (RPC crm_followup_registrar). */
export async function registrarToque(d: DadosToque): Promise<void> {
  const { error } = await supabase.rpc("crm_followup_registrar", {
    p_ficha: d.fichaId,
    p_etapa: d.etapa,
    p_passo: d.passo,
    p_canal: d.canal,
    p_resultado: d.resultado,
    p_nota: d.nota,
    p_nova_etapa: d.novaEtapa,
    p_proxima_acao: d.proximaAcao,
    p_proxima_acao_em: d.proximaAcaoEm,
  });
  if (!error) return;
  console.error("Erro ao registrar toque:", error.code, error.message);
  if (error.code === "PGRST202" || error.code === "42883") throw new Error("O follow-up exige a migração 20261118_v6_funil_followup.sql no Supabase.");
  if (error.hint === "crm_proxima_acao_obrigatoria") throw new Error("Defina a próxima ação e a data (regra de ouro).");
  if (error.hint === "crm_optout") throw new Error("Este lead está marcado como \"não contatar\".");
  if (error.hint === "crm_estado_invalido") throw new Error("A etapa da ficha mudou. Atualize a tela.");
  if (error.hint === "crm_dado_pessoal") throw new Error("Não registre CPF/CNPJ em texto livre.");
  if (error.code === "42501") throw new Error("Sem permissão para registrar toques nesta ficha.");
  throw new Error("Não foi possível registrar o toque.");
}

// ---------- indicadores do funil ----------

export interface IndicadoresFunil {
  escopo: "escritorio" | "proprio";
  por_etapa: Record<string, number>;
  perdas_por_motivo: Record<string, number>;
}

/** null = banco sem a v6 (o painel esconde a seção). */
export async function buscarIndicadoresFunil(inicio: Date, fim: Date): Promise<IndicadoresFunil | null> {
  const { data, error } = await supabase.rpc("crm_indicadores_funil", { p_inicio: inicio.toISOString(), p_fim: fim.toISOString() });
  if (error) {
    if (error.code !== "PGRST202" && error.code !== "42883") console.error("Erro nos indicadores do funil:", error.code, error.message);
    return null;
  }
  return data as IndicadoresFunil;
}

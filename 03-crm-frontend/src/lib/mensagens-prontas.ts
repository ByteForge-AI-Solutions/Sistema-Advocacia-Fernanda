import type { AreaJuridica } from "@/lib/advogados";

/**
 * Mensagens prontas (documento "CRM de leads de anúncio", seção 6), na ordem do SPIN:
 * Situação → Problema → Implicação → Necessidade (convite para a ligação), mais contornos
 * de objeção. Regras de redação:
 *   - uma só pergunta por mensagem, ideias em blocos curtos (parágrafos separados por linha em branco);
 *   - sem preço, valor ou percentual por escrito; sem promessa de resultado (OAB);
 *   - desconto, quando citado, sempre como possibilidade que "depende da análise".
 * Variáveis: {nome} (primeiro nome do cliente), {advogado} (quem envia), {oab} (inscrição de quem envia).
 * O teste automático (check_integration.py + testes de lógica) confere estas regras.
 */

export type CategoriaMensagem = "primeiro_contato" | "spin" | "objecao" | "especifica";

export const CATEGORIA_MENSAGEM_LABEL: Record<CategoriaMensagem, string> = {
  primeiro_contato: "Primeiro contato",
  spin: "Perguntas SPIN",
  objecao: "Objeções",
  especifica: "Situações específicas",
};

export interface MensagemPronta {
  id: string;
  categoria: CategoriaMensagem;
  titulo: string;
  /** Etapa SPIN (para a etiqueta): S, P, I ou N. */
  spin?: "S" | "P" | "I" | "N";
  /** Quando usar. */
  uso: string;
  texto: string;
  /** Vazio = serve para todas as áreas. */
  areas?: AreaJuridica[];
}

export const MENSAGENS_PRONTAS: MensagemPronta[] = [
  {
    id: "primeiro_contato_formulario",
    categoria: "primeiro_contato",
    titulo: "Lead de formulário",
    spin: "S",
    uso: "Primeira mensagem para quem preencheu o formulário do anúncio.",
    texto:
      "Olá, {nome}, tudo bem?\n\nAqui é {advogado}, do escritório Dias e Fernandes. Recebi o seu pedido de atendimento.\n\n" +
      "Para eu entender melhor: pode me contar, em poucas palavras, o que está acontecendo hoje?\n\n" +
      "Ah, e você prefere conversar por aqui em texto ou por áudio?",
  },
  {
    id: "primeiro_contato_tributario",
    categoria: "primeiro_contato",
    titulo: "Lead de formulário · dívida tributária",
    spin: "S",
    uso: "Primeira mensagem para lead de diagnóstico tributário.",
    areas: ["tributario"],
    texto:
      "Olá, {nome}, tudo bem?\n\nAqui é {advogado}, do escritório Dias e Fernandes. Recebi o seu pedido de diagnóstico tributário.\n\n" +
      "Para eu entender melhor: essa dívida já está em dívida ativa na PGFN ou ainda na Receita?\n\n" +
      "Ah, e você prefere conversar por aqui em texto ou por áudio?",
  },
  {
    id: "primeiro_contato_urgente",
    categoria: "primeiro_contato",
    titulo: "Lead urgente (bloqueio ou penhora)",
    spin: "S",
    uso: "Lead com bloqueio de conta, penhora ou citação. Responder na hora.",
    texto:
      "Olá, {nome}, tudo bem?\n\nAqui é {advogado}, do escritório Dias e Fernandes. Vi que você já está com bloqueio de conta ou penhora.\n\n" +
      "Para eu agir rápido: o bloqueio foi na conta da empresa ou na sua? Tem o número do processo?\n\n" +
      "Se for mais fácil, pode me responder por áudio.",
  },
  {
    id: "spin_problema",
    categoria: "spin",
    titulo: "Problema",
    spin: "P",
    uso: "Depois que o lead descreveu a situação: descobrir o que está travando.",
    texto: "Entendi.\n\nE hoje essa situação já está travando alguma coisa, como certidão, financiamento ou licitação?",
  },
  {
    id: "spin_implicacao",
    categoria: "spin",
    titulo: "Implicação",
    spin: "I",
    uso: "Mostrar o custo de ficar parado, sem prometer resultado.",
    areas: ["tributario"],
    texto:
      "Enquanto a dívida fica parada, os juros correm todo mês pela Selic e ela pode chegar a bloqueio de conta.\n\n" +
      "Quanto antes você souber o tamanho real do desconto possível, que depende da análise, mais fácil fica decidir.",
  },
  {
    id: "spin_convite_ligacao",
    categoria: "spin",
    titulo: "Convite para ligação (Necessidade)",
    spin: "N",
    uso: "Quando apareceu uma dor: marcar a ligação curta.",
    texto:
      "Para te dizer com segurança qual caminho faz sentido, preciso ver alguns detalhes.\n\n" +
      "Consegue falar dez minutinhos por telefone hoje ou amanhã? Qual horário fica melhor?",
  },
  {
    id: "especifica_divida_receita",
    categoria: "especifica",
    titulo: "Dívida só na Receita",
    uso: "Lead tributário cuja dívida ainda não foi para a PGFN.",
    areas: ["tributario"],
    texto:
      "O desconto em juros e multas só existe depois que a dívida vai para a PGFN.\n\n" +
      "Hoje o caminho é o parcelamento normal, e no diagnóstico eu vejo se compensa parcelar agora ou esperar.",
  },
  {
    id: "objecao_vou_pensar",
    categoria: "objecao",
    titulo: "\"Vou pensar\"",
    uso: "Lead adiou a decisão.",
    texto:
      "Sem problema.\n\nSó pra eu te ajudar melhor: o que pesa mais na sua decisão hoje, o valor ou entender se vale a pena fazer agora?",
  },
  {
    id: "objecao_desconfianca",
    categoria: "objecao",
    titulo: "Desconfiança",
    uso: "Lead com receio de golpe. Ofereça meios públicos de conferência.",
    texto:
      "Fica tranquilo. O processo é público e pode ser consultado no site do tribunal.\n\n" +
      "Meu registro pode ser conferido no Cadastro Nacional dos Advogados: {advogado}, OAB/{oab}.",
  },
  {
    id: "objecao_ja_tem_advogado",
    categoria: "objecao",
    titulo: "Já tem advogado",
    uso: "Lead já acompanhado por outro profissional.",
    texto: "Ótimo, então vocês estão bem acompanhados.\n\nSe quiserem uma segunda opinião, fico à disposição.",
  },
  {
    id: "objecao_sem_interesse",
    categoria: "objecao",
    titulo: "Sem interesse",
    uso: "Lead encerrou a conversa.",
    texto: "Sem problema, obrigado pelo retorno.\n\nSe precisar mais para frente, fico à disposição.",
  },
];

export function mensagemPorId(id: string | undefined): MensagemPronta | undefined {
  return id ? MENSAGENS_PRONTAS.find((m) => m.id === id) : undefined;
}

/** Mensagens da área primeiro (as específicas da área, depois as gerais); demais áreas ao fim. */
export function mensagensParaArea(area: string | null | undefined): MensagemPronta[] {
  const daArea = (m: MensagemPronta) => !m.areas || m.areas.length === 0 || (area ? m.areas.includes(area as AreaJuridica) : false);
  return [...MENSAGENS_PRONTAS].sort((a, b) => Number(daArea(b)) - Number(daArea(a)));
}

export interface VariaveisMensagem {
  nome?: string | null;
  advogado?: string | null;
  oab?: string | null;
}

/** Troca as variáveis conhecidas; as que faltarem continuam entre chaves para o usuário completar. */
export function preencherMensagem(texto: string, v: VariaveisMensagem): string {
  const primeiro = (s?: string | null) => (s ?? "").trim().split(/\s+/)[0] ?? "";
  const valores: Record<string, string> = {
    nome: primeiro(v.nome),
    advogado: (v.advogado ?? "").trim(),
    oab: (v.oab ?? "").trim(),
  };
  return texto.replace(/\{(nome|advogado|oab)\}/g, (marca, chave: string) => valores[chave] || marca);
}

/** Variáveis ainda não preenchidas ({...}) no texto. */
export function variaveisPendentes(texto: string): string[] {
  return [...new Set(texto.match(/\{[a-z_]+\}/g) ?? [])];
}

// ---------- OAB: conferência do texto antes de enviar ----------

const REGRAS_OAB: { padrao: RegExp; aviso: string }[] = [
  { padrao: /R\$\s?\d|\d[\d.]*,\d{2}\b|\breais\b/i, aviso: "Cita valor em dinheiro: valores só na conversa individual (ligação ou reunião), não por escrito." },
  { padrao: /\d+(,\d+)?\s?%|\bpor cento\b/i, aviso: "Cita percentual: não envie percentuais por escrito." },
  {
    padrao: /\b(garanto|garantimos|garantid[oa]s?|garantia de (êxito|sucesso|resultado|ganho))\b|resultado garantido/i,
    aviso: "Promete resultado: a OAB proíbe promessa de êxito.",
  },
  { padrao: /\b(com certeza|certeza de que|sem risco|100\s?%|causa ganha|vai ganhar|vamos ganhar)\b/i, aviso: "Expressa certeza de resultado: prefira \"depende da análise\"." },
  { padrao: /\bdesconto de\s+\d/i, aviso: "Desconto citado como certo: use sempre \"até\" e \"depende da análise\"." },
  { padrao: /\b(cases? de sucesso|clientes? (que )?(economiz|ganh))/i, aviso: "Prova social com resultado: simulação só como exemplo, nunca como resultado de cliente." },
];

/** Avisos de OAB (não bloqueiam: o envio pede confirmação). Lista vazia = sem alerta. */
export function avisosOab(texto: string): string[] {
  return REGRAS_OAB.filter((r) => r.padrao.test(texto)).map((r) => r.aviso);
}

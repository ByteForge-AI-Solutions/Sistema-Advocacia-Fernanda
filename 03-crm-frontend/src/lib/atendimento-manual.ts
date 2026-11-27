import { supabase } from "@/lib/supabase/client";
import { AREAS_JURIDICAS, isAreaJuridica, type AreaJuridica, type Cargo } from "@/lib/advogados";
import { contemDocumentoPessoal } from "@/lib/leads";

/**
 * "+ Novo atendimento" (migração 20261126_v12_ficha_manual.sql).
 *
 * O CRM NÃO insere em fichas_clientes: chama a RPC crm_ficha_criar_manual, que valida tudo de
 * novo no servidor e decide os campos protegidos (responsável = quem cadastra, prioridade,
 * status, etapa, temperatura, próxima ação). Aqui só os 4 campos do formulário são enviados.
 * As regras abaixo espelham as da RPC para dar o erro antes de ir ao servidor.
 */

export const LIMITES = { nomeMin: 2, nomeMax: 120, resumoMax: 3000 } as const;

/** Cargos com acesso ao botão (todos os cargos válidos; a RPC confere de novo). */
export function podeCadastrarAtendimento(cargo: Cargo): boolean {
  return cargo === "socio" || cargo === "advogado" || cargo === "estagiario" || cargo === "desenvolvedor";
}

export interface NovoAtendimento {
  nome: string;
  telefone: string;
  area: AreaJuridica | "";
  resumo: string;
}

export type ErrosAtendimento = Partial<Record<keyof NovoAtendimento, string>>;

/** Remove caracteres de controle e espaços repetidos (o servidor faz o mesmo). */
export function limparTexto(v: string, multilinha = false): string {
  const semControle = multilinha
    ? v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    : v.replace(/[\u0000-\u001F\u007F]/g, " ");
  return multilinha ? semControle.replace(/[ \t]+\n/g, "\n").trim() : semControle.replace(/\s+/g, " ").trim();
}

/**
 * Telefone opcional: só dígitos, com 55 na frente (mesmo formato do bot). Aceita DDD + número
 * (fixo ou celular) ou já com 55. Devolve "" se vazio e null se inválido.
 */
export function normalizarTelefone(v: string): string | null {
  let d = v.replace(/\D/g, "");
  if (!d) return "";
  if (d.length === 10 || d.length === 11) d = `55${d}`;
  return /^55[1-9][0-9]([2-8][0-9]{7}|9[0-9]{8})$/.test(d) ? d : null;
}

export function validarAtendimento(dados: NovoAtendimento): ErrosAtendimento {
  const erros: ErrosAtendimento = {};
  const nome = limparTexto(dados.nome);
  if (nome.length < LIMITES.nomeMin || nome.length > LIMITES.nomeMax || !/\p{L}/u.test(nome)) {
    erros.nome = `Informe o nome do cliente (${LIMITES.nomeMin} a ${LIMITES.nomeMax} caracteres).`;
  } else if (contemDocumentoPessoal(nome) || /\d{3}\.?\d{3}\.?\d{3}-?\d{2}/.test(nome)) {
    erros.nome = "Não coloque CPF/CNPJ no nome (LGPD). O documento vai no cadastro do cliente.";
  }
  if (normalizarTelefone(dados.telefone) === null) erros.telefone = "Telefone inválido. Use DDD + número, ex.: (66) 99999-0000.";
  if (!isAreaJuridica(dados.area)) erros.area = "Escolha a área jurídica.";
  const resumo = limparTexto(dados.resumo, true);
  if (resumo.length > LIMITES.resumoMax) erros.resumo = `Resumo com no máximo ${LIMITES.resumoMax} caracteres.`;
  else if (contemDocumentoPessoal(resumo)) erros.resumo = "Não registre CPF/CNPJ no resumo: ele aparece na fila (LGPD). Use o cadastro do cliente.";
  return erros;
}

/** Mensagens das recusas da RPC (HINT) em linguagem de usuário. */
const MENSAGEM_HINT: Record<string, string> = {
  crm_sem_acesso: "Seu usuário não tem permissão para cadastrar atendimentos.",
  crm_ficha_nome: "Nome do cliente inválido.",
  crm_ficha_telefone: "Telefone inválido. Use DDD + número.",
  crm_ficha_area: "Área jurídica inválida.",
  crm_ficha_resumo: "Resumo inválido ou longo demais.",
  crm_dado_pessoal: "Não registre CPF/CNPJ no nome ou no resumo (LGPD).",
  crm_ficha_limite: "Limite de 30 cadastros manuais por hora atingido. Tente mais tarde.",
};

/** Cria o atendimento e devolve o id da ficha. */
export async function criarAtendimentoManual(dados: NovoAtendimento): Promise<string> {
  const erros = validarAtendimento(dados);
  const primeiro = Object.values(erros)[0];
  if (primeiro) throw new Error(primeiro);
  const { data, error } = await supabase.rpc("crm_ficha_criar_manual", {
    p_nome: limparTexto(dados.nome),
    p_telefone: normalizarTelefone(dados.telefone) ?? "",
    p_area: dados.area,
    p_resumo: limparTexto(dados.resumo, true),
  });
  if (error) {
    if (error.code === "PGRST202" || error.code === "42883") {
      throw new Error("O cadastro manual exige a migração 20261126_v12_ficha_manual.sql no Supabase.");
    }
    throw new Error((error.hint && MENSAGEM_HINT[error.hint]) || "Não foi possível cadastrar o atendimento. Tente de novo.");
  }
  if (typeof data !== "string") throw new Error("Resposta inesperada do servidor.");
  return data;
}

export const OPCOES_AREA = (Object.keys(AREAS_JURIDICAS) as AreaJuridica[]).map((a) => ({ valor: a, label: AREAS_JURIDICAS[a] }));

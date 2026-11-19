import type { PostgrestError } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase/client";
import { cnpjValido, contemDocumentoPessoal, cpfValido } from "@/lib/leads";

/**
 * Cadastro do cliente (tabela clientes_cadastro, migração 20261119_v7_financeiro_documentos.sql):
 * qualificação usada em contratos e procurações. LGPD: só é lido ao abrir o cadastro ou gerar
 * um documento; listas e indicadores nunca carregam estes dados. O documento fica só com dígitos.
 */

export type TipoPessoa = "pf" | "pj";

export interface ClienteCadastro {
  tipo_pessoa: TipoPessoa;
  /** PF: nome completo; PJ: razão social. */
  nome: string;
  /** Só dígitos: CPF (11) ou CNPJ (14). */
  documento: string | null;
  rg: string | null;
  nacionalidade: string | null;
  estado_civil: string | null;
  profissao: string | null;
  endereco: string | null;
  email: string | null;
  /** PJ: quem assina pela empresa. */
  representante_nome: string | null;
  representante_cpf: string | null;
}

export const CADASTRO_VAZIO: ClienteCadastro = {
  tipo_pessoa: "pf",
  nome: "",
  documento: null,
  rg: null,
  nacionalidade: "brasileiro(a)",
  estado_civil: null,
  profissao: null,
  endereco: null,
  email: null,
  representante_nome: null,
  representante_cpf: null,
};

const COLUNAS =
  "tipo_pessoa,nome,documento,rg,nacionalidade,estado_civil,profissao,endereco,email,representante_nome,representante_cpf";

export const soDigitos = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");

/** 11 dígitos → 000.000.000-00; 14 → 00.000.000/0000-00; outros, como vieram. */
export function formatarDocumento(valor: string | null | undefined): string {
  const d = soDigitos(valor);
  if (d.length === 11) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  if (d.length === 14) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  return valor ?? "";
}

/** Problemas do cadastro (vazio = válido). Confere os dígitos verificadores de CPF e CNPJ. */
export function validarCadastro(c: ClienteCadastro): string[] {
  const erros: string[] = [];
  if (!c.nome.trim()) erros.push(c.tipo_pessoa === "pj" ? "Informe a razão social." : "Informe o nome completo.");
  const doc = soDigitos(c.documento);
  if (doc) {
    if (c.tipo_pessoa === "pf" && !cpfValido(doc)) erros.push("CPF inválido (confira os dígitos).");
    if (c.tipo_pessoa === "pj" && !cnpjValido(doc)) erros.push("CNPJ inválido (confira os dígitos).");
  }
  const rep = soDigitos(c.representante_cpf);
  if (c.tipo_pessoa === "pj" && rep && !cpfValido(rep)) erros.push("CPF do representante inválido.");
  // Documento só no campo próprio: nunca em nome, endereço ou profissão.
  const livres = [c.nome, c.endereco, c.profissao, c.estado_civil, c.nacionalidade, c.representante_nome];
  if (livres.some((t) => t && contemDocumentoPessoal(t))) erros.push("CPF/CNPJ só nos campos próprios, não em nome, endereço ou profissão.");
  if (c.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email.trim())) erros.push("E-mail inválido.");
  return erros;
}

const ausente = (e: PostgrestError) => ["PGRST205", "42P01", "42703"].includes(e.code);

/** disponivel = false quando o banco ainda não tem a migração v7. */
export async function carregarCadastro(fichaId: string): Promise<{ cadastro: ClienteCadastro | null; disponivel: boolean }> {
  const { data, error } = await supabase
    .from("clientes_cadastro")
    .select(COLUNAS)
    .eq("ficha_id", fichaId)
    .maybeSingle<ClienteCadastro>();
  if (error) {
    if (ausente(error)) return { cadastro: null, disponivel: false };
    console.error("Erro ao carregar cadastro:", error.code, error.message);
    throw new Error("Não foi possível carregar o cadastro do cliente.");
  }
  return { cadastro: data, disponivel: true };
}

const limpar = (s: string | null) => (s && s.trim() ? s.trim() : null);

export async function salvarCadastro(fichaId: string, c: ClienteCadastro): Promise<void> {
  const linha = {
    ficha_id: fichaId,
    tipo_pessoa: c.tipo_pessoa,
    nome: c.nome.trim(),
    documento: soDigitos(c.documento) || null,
    rg: limpar(c.rg),
    nacionalidade: limpar(c.nacionalidade),
    estado_civil: limpar(c.estado_civil),
    profissao: limpar(c.profissao),
    endereco: limpar(c.endereco),
    email: limpar(c.email),
    representante_nome: c.tipo_pessoa === "pj" ? limpar(c.representante_nome) : null,
    representante_cpf: c.tipo_pessoa === "pj" ? soDigitos(c.representante_cpf) || null : null,
  };
  const { error } = await supabase.from("clientes_cadastro").upsert(linha, { onConflict: "ficha_id" }).select("ficha_id").single();
  if (error) {
    console.error("Erro ao salvar cadastro:", error.code);
    if (ausente(error)) throw new Error("O cadastro exige a migração 20261119_v7_financeiro_documentos.sql no Supabase.");
    if (error.code === "23514") throw new Error("Algum campo do cadastro está inválido (documento precisa combinar com PF/PJ).");
    if (error.code === "42501" || error.code === "PGRST116") throw new Error("Sem permissão para editar o cadastro desta ficha.");
    throw new Error("Não foi possível salvar o cadastro.");
  }
}

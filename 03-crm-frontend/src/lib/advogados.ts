import { supabase } from "@/lib/supabase/client";

/**
 * - advogado: titular; recebe fichas do bot e supervisiona estagiários. Vê o que é dele,
 *   dos estagiários que supervisiona e o que está sem responsável na área dele.
 * - socio: dono do escritório. Atua como titular (rodízio do bot, agenda, atendimentos) e
 *   vê/edita os registros de todo o escritório, exceto os de contas 'desenvolvedor'.
 * - estagiario: recebe fichas só por delegação do supervisor.
 * - desenvolvedor: conta de teste/manutenção. Vê e edita apenas o que está atribuído
 *   ao próprio id (mesmo escopo de um estagiário, sem supervisor). Não deve entrar no
 *   rodízio do bot nem supervisionar ninguém; dados reais de clientes ficam fora do alcance.
 */
export const CARGOS = ["advogado", "socio", "estagiario", "desenvolvedor"] as const;
export type Cargo = (typeof CARGOS)[number];

/** Titular = atua com carteira própria e pode supervisionar estagiários (advogado ou sócio). */
export function ehTitular(cargo: Cargo): boolean {
  return cargo === "advogado" || cargo === "socio";
}

/** Sócio: supervisão total do escritório (espelha o ramo 'socio' de pode_acessar_ficha). */
export function ehSocio(perfil: Pick<Advogado, "cargo">): boolean {
  return perfil.cargo === "socio";
}

export const AREAS_JURIDICAS = {
  trabalhista: "Trabalhista",
  empresarial: "Empresarial",
  civil: "Civil",
  cartorario_reurb: "Cartorário / REURB",
  previdenciario: "Previdenciário",
  tributario: "Tributário",
} as const;
export type AreaJuridica = keyof typeof AREAS_JURIDICAS;

export const CARGO_LABEL: Record<Cargo, string> = {
  advogado: "Advogado(a) titular",
  socio: "Sócio(a)",
  estagiario: "Estagiário(a)",
  desenvolvedor: "Desenvolvedor(a)",
};

export interface Advogado {
  id: string;
  nome: string;
  email: string;
  cargo: Cargo;
  supervisor_id: string | null;
  areas_atuacao: AreaJuridica[];
  ativo: boolean;
}

/** Linha como vem do banco: cargo e áreas são TEXT sem CHECK, então ainda não são confiáveis. */
interface AdvogadoRow {
  id: string;
  nome: string;
  email: string;
  cargo: string | null;
  supervisor_id: string | null;
  areas_atuacao: string[] | null;
  ativo: boolean | null;
}

export function isCargo(valor: unknown): valor is Cargo {
  return typeof valor === "string" && (CARGOS as readonly string[]).includes(valor);
}

export function isAreaJuridica(valor: unknown): valor is AreaJuridica {
  return typeof valor === "string" && valor in AREAS_JURIDICAS;
}

/**
 * Regras de hierarquia validadas no código (o banco não tem CHECK):
 * - cargo deve ser 'advogado', 'socio', 'estagiario' ou 'desenvolvedor'
 * - titular, sócio e desenvolvedor não têm supervisor; estagiário obrigatoriamente tem
 * Retorna a lista de problemas encontrados (vazia = válido).
 */
export function validarPerfil(dados: {
  id?: string;
  cargo: unknown;
  supervisor_id: string | null;
}): string[] {
  const erros: string[] = [];

  if (!isCargo(dados.cargo)) {
    erros.push(
      `Cargo inválido: "${String(dados.cargo)}". Use ${CARGOS.map((c) => `"${c}"`).join(", ")}.`,
    );
  } else if (dados.cargo === "advogado" && dados.supervisor_id) {
    erros.push("Advogado titular não pode ter supervisor.");
  } else if (dados.cargo === "socio" && dados.supervisor_id) {
    erros.push("Sócio não pode ter supervisor.");
  } else if (dados.cargo === "desenvolvedor" && dados.supervisor_id) {
    erros.push("Desenvolvedor não pode ter supervisor.");
  } else if (dados.cargo === "estagiario" && !dados.supervisor_id) {
    erros.push("Estagiário precisa ter um advogado supervisor.");
  }

  if (dados.id && dados.supervisor_id === dados.id) {
    erros.push("Um advogado não pode supervisionar a si mesmo.");
  }

  return erros;
}

export type ResultadoPerfil =
  | { ok: true; perfil: Advogado }
  | { ok: false; motivo: string };

/** Escapa curingas do LIKE para comparar e-mails de forma exata, sem diferenciar maiúsculas. */
function escaparLike(texto: string): string {
  return texto.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export async function buscarPerfilPorEmail(email: string): Promise<ResultadoPerfil> {
  const { data, error } = await supabase
    .from("advogados")
    .select("id, nome, email, cargo, supervisor_id, areas_atuacao, ativo")
    .ilike("email", escaparLike(email.trim()))
    .maybeSingle<AdvogadoRow>();

  if (error) {
    console.error("Erro ao buscar perfil do advogado:", error.message);
    return { ok: false, motivo: "Não foi possível carregar seu perfil. Tente novamente." };
  }

  if (!data) {
    return {
      ok: false,
      motivo: "Este e-mail não está vinculado a nenhum advogado do escritório.",
    };
  }

  if (data.ativo === false) {
    return { ok: false, motivo: "Seu acesso está desativado. Fale com a administração." };
  }

  const erros = validarPerfil(data);
  if (erros.length > 0 || !isCargo(data.cargo)) {
    console.error("Cadastro de advogado inconsistente:", erros);
    // Mostra o motivo exato: o CRM é interno e isso poupa a administração de investigar no banco.
    return {
      ok: false,
      motivo: `Seu cadastro está inconsistente: ${erros.join(" ")} Fale com a administração.`,
    };
  }

  return {
    ok: true,
    perfil: {
      id: data.id,
      nome: data.nome,
      email: data.email,
      cargo: data.cargo,
      supervisor_id: data.supervisor_id,
      areas_atuacao: (data.areas_atuacao ?? []).filter(isAreaJuridica),
      ativo: true,
    },
  };
}

export interface MembroEquipe {
  id: string;
  nome: string;
  /** Presente nas listas montadas por buscarEquipeVisivel (rótulos e filtros). */
  cargo?: Cargo;
}

/**
 * Estagiários supervisionados pelo usuário (titular ou sócio). Vazio para os demais cargos.
 */
export async function buscarEstagiariosSupervisionados(perfil: Advogado): Promise<MembroEquipe[]> {
  if (!ehTitular(perfil.cargo)) return [];

  const { data, error } = await supabase
    .from("advogados")
    .select("id, nome")
    .eq("supervisor_id", perfil.id)
    .eq("cargo", "estagiario");

  if (error) throw new Error(error.message);
  return (data ?? []).map((e) => ({ ...e, cargo: "estagiario" as const }));
}

/**
 * Pessoas cujos registros o usuário enxerga, espelhando pode_acessar_ficha() do RLS.
 * O próprio usuário vem primeiro.
 * - socio: todos os advogados, sócios e estagiários ativos (contas 'desenvolvedor' ficam fora);
 * - advogado: ele + estagiários que supervisiona;
 * - estagiário/desenvolvedor: só ele.
 */
export async function buscarEquipeVisivel(perfil: Advogado): Promise<MembroEquipe[]> {
  const eu: MembroEquipe = { id: perfil.id, nome: perfil.nome, cargo: perfil.cargo };
  if (!ehSocio(perfil)) return [eu, ...(await buscarEstagiariosSupervisionados(perfil))];

  const { data, error } = await supabase
    .from("advogados")
    .select("id, nome, cargo")
    .eq("ativo", true)
    .in("cargo", ["socio", "advogado", "estagiario"])
    .neq("id", perfil.id)
    .order("nome")
    .overrideTypes<{ id: string; nome: string; cargo: string }[], { merge: false }>();

  if (error) throw new Error(error.message);
  const outros = (data ?? []).flatMap((m) => (isCargo(m.cargo) ? [{ id: m.id, nome: m.nome, cargo: m.cargo }] : []));
  // Titulares antes de estagiários; dentro de cada grupo, ordem alfabética (vinda do banco).
  const peso = (c?: Cargo) => (c === "estagiario" ? 1 : 0);
  return [eu, ...outros.sort((a, b) => peso(a.cargo) - peso(b.cargo))];
}

/** Rótulo curto do vínculo de alguém da equipe, do ponto de vista do usuário. */
export function rotuloMembro(m: MembroEquipe, meuId: string): string {
  if (m.id === meuId) return `${m.nome} (você)`;
  if (m.cargo === "estagiario") return `${m.nome} · estagiário(a)`;
  if (m.cargo === "socio") return `${m.nome} · sócio(a)`;
  return m.nome;
}

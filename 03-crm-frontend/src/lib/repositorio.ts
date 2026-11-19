import type { PostgrestError } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase/client";
import { AVISO_DOCUMENTO, contemDocumentoPessoal } from "@/lib/leads";

/**
 * Repositório de documentos por ficha (migração 20261119_v7_financeiro_documentos.sql).
 * Arquivos no bucket PRIVADO "documentos-clientes", caminho "<ficha_id>/<uuid>.<ext>":
 * o nome original não vai para o caminho (pode conter dados pessoais). O RLS do Storage
 * libera o arquivo só para quem enxerga a ficha; o download usa URL assinada de 2 minutos.
 */

export const BUCKET_DOCUMENTOS = "documentos-clientes";
export const TAMANHO_MAXIMO = 20 * 1024 * 1024;

export const CATEGORIAS_DOCUMENTO = ["procuracao", "contrato", "parecer", "comprovante", "documento_pessoal", "peticao", "outro"] as const;
export type CategoriaDocumento = (typeof CATEGORIAS_DOCUMENTO)[number];
export const CATEGORIA_DOCUMENTO_LABEL: Record<CategoriaDocumento, string> = {
  procuracao: "Procuração assinada",
  contrato: "Contrato assinado",
  parecer: "Parecer entregue",
  comprovante: "Comprovante de pagamento",
  documento_pessoal: "Documento pessoal",
  peticao: "Petição / peça",
  outro: "Outro",
};

/** Tipos aceitos (iguais aos do bucket). */
export const TIPOS_ACEITOS: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};
export const ACCEPT_INPUT = ".pdf,.jpg,.jpeg,.png,.webp,.docx,.xlsx";

export interface DocumentoFicha {
  id: string;
  ficha_id: string;
  categoria: CategoriaDocumento;
  nome: string;
  descricao: string | null;
  caminho: string;
  tamanho_bytes: number;
  tipo_mime: string;
  enviado_por: string;
  criado_em: string;
}

const COLUNAS = "id,ficha_id,categoria,nome,descricao,caminho,tamanho_bytes,tipo_mime,enviado_por,criado_em";
const ausente = (e: PostgrestError) => ["PGRST205", "42P01", "42703"].includes(e.code);

export function formatarTamanho(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
}

/** Problemas do arquivo antes de enviar (vazio = ok). */
export function validarArquivo(arquivo: { type: string; size: number }, nome: string): string[] {
  const erros: string[] = [];
  if (!TIPOS_ACEITOS[arquivo.type]) erros.push("Tipo de arquivo não aceito. Envie PDF, imagem (JPG, PNG, WEBP), DOCX ou XLSX.");
  if (arquivo.size <= 0) erros.push("Arquivo vazio.");
  if (arquivo.size > TAMANHO_MAXIMO) erros.push("O arquivo passa de 20 MB.");
  if (!nome.trim()) erros.push("Dê um nome ao documento.");
  if (contemDocumentoPessoal(nome)) erros.push(`Nome do arquivo: ${AVISO_DOCUMENTO}`);
  return erros;
}

export async function listarDocumentos(fichaId: string): Promise<{ documentos: DocumentoFicha[]; disponivel: boolean }> {
  const { data, error } = await supabase
    .from("fichas_documentos")
    .select(COLUNAS)
    .eq("ficha_id", fichaId)
    .order("criado_em", { ascending: false })
    .overrideTypes<DocumentoFicha[], { merge: false }>();
  if (error) {
    if (ausente(error)) return { documentos: [], disponivel: false };
    console.error("Erro ao listar documentos:", error.code, error.message);
    throw new Error("Não foi possível carregar os documentos.");
  }
  return { documentos: data ?? [], disponivel: true };
}

/** Envia o arquivo e registra os metadados; se o registro falhar, o arquivo é removido. */
export async function enviarDocumento(
  fichaId: string,
  arquivo: File,
  dados: { categoria: CategoriaDocumento; nome: string; descricao: string | null },
): Promise<DocumentoFicha> {
  const problemas = validarArquivo(arquivo, dados.nome);
  if (dados.descricao && contemDocumentoPessoal(dados.descricao)) problemas.push(`Descrição: ${AVISO_DOCUMENTO}`);
  if (problemas.length) throw new Error(problemas.join(" "));

  const caminho = `${fichaId}/${crypto.randomUUID()}.${TIPOS_ACEITOS[arquivo.type]}`;
  const envio = await supabase.storage.from(BUCKET_DOCUMENTOS).upload(caminho, arquivo, { contentType: arquivo.type, upsert: false });
  if (envio.error) {
    console.error("Erro no upload:", envio.error.message);
    throw new Error("Não foi possível enviar o arquivo. Confira se a migração v7 (bucket documentos-clientes) foi aplicada e se você tem acesso à ficha.");
  }

  const { data, error } = await supabase
    .from("fichas_documentos")
    .insert({
      ficha_id: fichaId,
      categoria: dados.categoria,
      nome: dados.nome.trim(),
      descricao: dados.descricao?.trim() || null,
      caminho,
      tamanho_bytes: arquivo.size,
      tipo_mime: arquivo.type,
    })
    .select(COLUNAS)
    .single<DocumentoFicha>();
  if (error || !data) {
    await supabase.storage.from(BUCKET_DOCUMENTOS).remove([caminho]);
    console.error("Erro ao registrar documento:", error?.code, error?.message);
    throw new Error("O arquivo não pôde ser registrado na ficha e foi descartado. Tente novamente.");
  }
  return data;
}

/** URL temporária (2 min) para ver ou baixar; o arquivo nunca fica público. */
export async function urlTemporaria(doc: Pick<DocumentoFicha, "caminho" | "nome" | "tipo_mime">, baixar = false): Promise<string> {
  const ext = TIPOS_ACEITOS[doc.tipo_mime] ?? "";
  const nomeArquivo = doc.nome.toLowerCase().endsWith(`.${ext}`) || !ext ? doc.nome : `${doc.nome}.${ext}`;
  const { data, error } = await supabase.storage
    .from(BUCKET_DOCUMENTOS)
    .createSignedUrl(doc.caminho, 120, baixar ? { download: nomeArquivo } : undefined);
  if (error || !data) throw new Error("Não foi possível abrir o arquivo (sem acesso ou arquivo removido).");
  return data.signedUrl;
}

/** Exclui o registro e o arquivo. Estagiários não excluem (RLS). */
export async function excluirDocumento(doc: Pick<DocumentoFicha, "id" | "caminho">): Promise<void> {
  const { data, error } = await supabase.from("fichas_documentos").delete().eq("id", doc.id).select("id");
  if (error) {
    console.error("Erro ao excluir documento:", error.code, error.message);
    throw new Error("Não foi possível excluir o documento.");
  }
  if (!data || data.length === 0) throw new Error("Só titulares e sócios excluem documentos.");
  const { error: e2 } = await supabase.storage.from(BUCKET_DOCUMENTOS).remove([doc.caminho]);
  if (e2) console.error("Arquivo não removido do Storage:", e2.message);
}

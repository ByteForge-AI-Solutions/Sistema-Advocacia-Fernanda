"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { CircleAlert, Download, Eye, FileText, LoaderCircle, Trash, Upload } from "lucide-react";
import type { Advogado } from "@/lib/advogados";
import {
  ACCEPT_INPUT,
  CATEGORIAS_DOCUMENTO,
  CATEGORIA_DOCUMENTO_LABEL,
  enviarDocumento,
  excluirDocumento,
  formatarTamanho,
  listarDocumentos,
  urlTemporaria,
  validarArquivo,
  type CategoriaDocumento,
  type DocumentoFicha,
} from "@/lib/repositorio";

const campo =
  "mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-navy-500 focus:ring-3 focus:ring-navy-500/15";
const fmt = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

/** Repositório de arquivos da ficha (bucket privado; acesso por URL assinada de 2 minutos). */
export function AbaDocumentos({ fichaId, perfil, onAviso }: { fichaId: string; perfil: Advogado; onAviso: (msg: string) => void }) {
  const [docs, setDocs] = useState<DocumentoFicha[] | null>(null);
  const [disponivel, setDisponivel] = useState(true);
  const [versao, setVersao] = useState(0);
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [nome, setNome] = useState("");
  const [categoria, setCategoria] = useState<CategoriaDocumento>("procuracao");
  const [descricao, setDescricao] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const podeExcluir = perfil.cargo !== "estagiario";

  useEffect(() => {
    let atual = true;
    listarDocumentos(fichaId).then(
      (r) => {
        if (!atual) return;
        setDocs(r.documentos);
        setDisponivel(r.disponivel);
      },
      (e: unknown) => atual && setErro(e instanceof Error ? e.message : "Erro ao carregar."),
    );
    return () => {
      atual = false;
    };
  }, [fichaId, versao]);

  function escolher(f: File | null) {
    setArquivo(f);
    setErro(null);
    // Sugere o nome sem a extensão; o usuário pode (e deve, se tiver CPF) renomear.
    if (f) setNome(f.name.replace(/\.[a-z0-9]+$/i, ""));
  }

  async function enviar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!arquivo) return setErro("Escolha um arquivo.");
    const problemas = validarArquivo(arquivo, nome);
    if (problemas.length) return setErro(problemas.join(" "));
    setEnviando(true);
    setErro(null);
    try {
      await enviarDocumento(fichaId, arquivo, { categoria, nome, descricao: descricao || null });
      setArquivo(null);
      setNome("");
      setDescricao("");
      if (inputRef.current) inputRef.current.value = "";
      onAviso("Documento enviado.");
      setVersao((v) => v + 1);
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Não foi possível enviar.");
    } finally {
      setEnviando(false);
    }
  }

  async function abrir(d: DocumentoFicha, baixar: boolean) {
    // A aba é aberta já no clique (antes do await) para o navegador não bloquear o pop-up.
    const aba = baixar ? null : window.open("about:blank", "_blank");
    try {
      const url = await urlTemporaria(d, baixar);
      if (baixar) {
        window.location.assign(url); // URL com Content-Disposition: attachment (baixa sem sair da página)
      } else if (aba) {
        aba.opener = null;
        aba.location.href = url;
      }
    } catch (err) {
      aba?.close();
      setErro(err instanceof Error ? err.message : "Não foi possível abrir.");
    }
  }

  async function excluir(d: DocumentoFicha) {
    if (!confirm(`Excluir "${d.nome}"? O arquivo será apagado do armazenamento.`)) return;
    try {
      await excluirDocumento(d);
      onAviso("Documento excluído.");
      setVersao((v) => v + 1);
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Não foi possível excluir.");
    }
  }

  if (!disponivel) {
    return <p className="rounded-lg bg-amber-50 p-4 text-sm text-amber-900">O repositório exige a migração 20261119_v7_financeiro_documentos.sql no Supabase.</p>;
  }

  return (
    <div className="space-y-5">
      <form onSubmit={enviar} noValidate className="rounded-xl border border-dashed border-slate-300 bg-slate-50/60 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label htmlFor="doc-arquivo" className="block text-xs font-medium text-slate-600">Arquivo (PDF, imagem, DOCX ou XLSX, até 20 MB)</label>
            <input
              id="doc-arquivo"
              ref={inputRef}
              type="file"
              accept={ACCEPT_INPUT}
              onChange={(e) => escolher(e.target.files?.[0] ?? null)}
              className="mt-1 block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-navy-900 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-navy-800"
            />
          </div>
          <div>
            <label htmlFor="doc-cat" className="block text-xs font-medium text-slate-600">Categoria</label>
            <select id="doc-cat" value={categoria} onChange={(e) => setCategoria(e.target.value as CategoriaDocumento)} className={campo}>
              {CATEGORIAS_DOCUMENTO.map((c) => (
                <option key={c} value={c}>{CATEGORIA_DOCUMENTO_LABEL[c]}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="doc-nome" className="block text-xs font-medium text-slate-600">Nome do documento</label>
            <input id="doc-nome" maxLength={200} value={nome} onChange={(e) => setNome(e.target.value)} className={campo} placeholder="Ex.: Procuração assinada" />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="doc-desc" className="block text-xs font-medium text-slate-600">Descrição (opcional)</label>
            <input id="doc-desc" maxLength={500} value={descricao} onChange={(e) => setDescricao(e.target.value)} className={campo} />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] text-slate-500">Arquivo privado: só a equipe responsável pela ficha abre, por link temporário. Não use CPF/CNPJ no nome.</p>
          <button type="submit" disabled={enviando || !arquivo} className="inline-flex items-center gap-2 rounded-lg bg-navy-900 px-4 py-2 text-sm font-semibold text-white hover:bg-navy-800 disabled:opacity-50">
            {enviando ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <Upload className="size-4" aria-hidden />} Enviar
          </button>
        </div>
      </form>

      {erro && (
        <p role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> {erro}
        </p>
      )}

      {docs === null ? (
        <div className="flex justify-center py-6" role="status"><LoaderCircle className="size-5 animate-spin text-navy-700" aria-hidden /></div>
      ) : docs.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-500">Nenhum documento nesta ficha ainda.</p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
          {docs.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <FileText className="size-5 shrink-0 text-slate-400" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-900">{d.nome}</p>
                <p className="text-xs text-slate-500">
                  {CATEGORIA_DOCUMENTO_LABEL[d.categoria]} · {formatarTamanho(d.tamanho_bytes)} · {fmt.format(new Date(d.criado_em))}
                  {d.descricao ? ` · ${d.descricao}` : ""}
                </p>
              </div>
              <div className="flex gap-1">
                <button type="button" onClick={() => void abrir(d, false)} aria-label={`Abrir ${d.nome}`} className="rounded-md p-2 text-slate-500 hover:bg-slate-100">
                  <Eye className="size-4" />
                </button>
                <button type="button" onClick={() => void abrir(d, true)} aria-label={`Baixar ${d.nome}`} className="rounded-md p-2 text-slate-500 hover:bg-slate-100">
                  <Download className="size-4" />
                </button>
                {podeExcluir && (
                  <button type="button" onClick={() => void excluir(d)} aria-label={`Excluir ${d.nome}`} className="rounded-md p-2 text-red-600 hover:bg-red-50">
                    <Trash className="size-4" />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

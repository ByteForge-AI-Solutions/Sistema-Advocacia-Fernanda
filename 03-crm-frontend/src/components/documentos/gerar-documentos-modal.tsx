"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, CircleAlert, FilePen, Info, LoaderCircle, Printer, X } from "lucide-react";
import { AREAS_JURIDICAS, type AreaJuridica } from "@/lib/advogados";
import {
  CSS_DOCUMENTO,
  MODELOS,
  carregarDadosIniciais,
  gerarDocumentoHtml,
  imprimirDocumento,
  lembrarDadosEscritorio,
  type DadosDocumento,
  type ModeloDocumento,
} from "@/lib/documentos";

const campo =
  "mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-navy-500 focus:ring-3 focus:ring-navy-500/15";

type CampoTexto = Exclude<keyof DadosDocumento, "area" | "poderes_especiais">;

function Campo({
  id,
  rotulo,
  dados,
  onMudar,
  tipo = "text",
  dica,
  className = "",
}: {
  id: CampoTexto;
  rotulo: string;
  dados: DadosDocumento;
  onMudar: (k: CampoTexto, v: string) => void;
  tipo?: string;
  dica?: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <label htmlFor={`doc-${id}`} className="block text-xs font-medium text-slate-600">
        {rotulo}
      </label>
      <input id={`doc-${id}`} type={tipo} value={dados[id]} onChange={(e) => onMudar(id, e.target.value)} placeholder={dica} className={campo} />
    </div>
  );
}

/** Gera Contrato de Honorários / Procuração a partir da ficha, com edição livre e impressão em PDF. */
export function GerarDocumentosModal({ fichaId, onFechar }: { fichaId: string; onFechar: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const [modelo, setModelo] = useState<ModeloDocumento>("contrato_honorarios");
  const [dados, setDados] = useState<DadosDocumento | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [etapa, setEtapa] = useState<"dados" | "revisao">("dados");
  const [htmlGerado, setHtmlGerado] = useState("");

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);

  useEffect(() => {
    let atual = true;
    carregarDadosIniciais(fichaId).then(
      (d) => atual && setDados(d),
      (e: unknown) => atual && setErro(e instanceof Error ? e.message : "Não foi possível carregar a ficha."),
    );
    return () => {
      atual = false;
    };
  }, [fichaId]);

  // O editor é não controlado: o HTML só é injetado ao entrar na revisão.
  useEffect(() => {
    if (etapa === "revisao" && editorRef.current) editorRef.current.innerHTML = htmlGerado;
  }, [etapa, htmlGerado]);

  const mudar = (k: CampoTexto, valor: string) => setDados((d) => (d ? { ...d, [k]: valor } : d));

  function gerar() {
    if (!dados) return;
    lembrarDadosEscritorio(dados);
    setHtmlGerado(gerarDocumentoHtml(modelo, dados));
    setEtapa("revisao");
  }

  function voltar() {
    if (confirm("Voltar aos dados descarta as edições feitas no texto. Continuar?")) setEtapa("dados");
  }

  function imprimir() {
    const titulo = MODELOS.find((m) => m.valor === modelo)?.label ?? "Documento";
    imprimirDocumento(editorRef.current?.innerHTML ?? htmlGerado, `${titulo} - ${dados?.cliente_nome ?? ""}`);
  }

  return (
    <dialog
      ref={ref}
      onClose={onFechar}
      aria-labelledby="docs-titulo"
      className="m-auto h-[min(92vh,900px)] w-[calc(100%-2rem)] max-w-5xl overflow-hidden rounded-2xl bg-white p-0 shadow-2xl ring-1 ring-slate-900/10 backdrop:bg-navy-950/60"
    >
      <div className="flex h-full flex-col">
        <header className="flex items-center justify-between gap-4 border-b border-slate-200 px-6 py-4">
          <h2 id="docs-titulo" className="flex items-center gap-2 text-lg font-semibold text-navy-950">
            <FilePen className="size-5 text-navy-700" aria-hidden /> Gerar documentos
          </h2>
          <button type="button" onClick={onFechar} aria-label="Fechar" className="rounded-md p-1 text-slate-400 hover:bg-slate-100">
            <X className="size-4" />
          </button>
        </header>

        {erro ? (
          <p role="alert" className="m-6 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> {erro}
          </p>
        ) : !dados ? (
          <div className="flex flex-1 items-center justify-center" role="status">
            <LoaderCircle className="size-6 animate-spin text-navy-700" aria-hidden />
          </div>
        ) : etapa === "dados" ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            <div role="radiogroup" aria-label="Modelo" className="grid gap-2 sm:grid-cols-2">
              {MODELOS.map((m) => (
                <button
                  key={m.valor}
                  type="button"
                  role="radio"
                  aria-checked={modelo === m.valor}
                  onClick={() => setModelo(m.valor)}
                  className={`rounded-xl px-4 py-3 text-left text-sm font-semibold transition ${
                    modelo === m.valor ? "bg-navy-900 text-white shadow" : "text-slate-700 ring-1 ring-inset ring-slate-200 hover:bg-slate-50"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>

            <p className="mt-4 flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              Os dados digitados aqui não são salvos no sistema. Campos vazios aparecem destacados no texto para você completar.
              Modelos-base: revise o texto antes de imprimir.
            </p>

            <fieldset className="mt-5">
              <legend className="text-sm font-semibold text-slate-900">Cliente</legend>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <Campo id="cliente_nome" rotulo="Nome completo" dados={dados} onMudar={mudar} className="sm:col-span-2" />
                <Campo id="cliente_nacionalidade" rotulo="Nacionalidade" dados={dados} onMudar={mudar} />
                <Campo id="cliente_estado_civil" rotulo="Estado civil" dados={dados} onMudar={mudar} />
                <Campo id="cliente_profissao" rotulo="Profissão" dados={dados} onMudar={mudar} />
                <Campo id="cliente_rg" rotulo="RG (com órgão emissor)" dados={dados} onMudar={mudar} />
                <Campo id="cliente_cpf" rotulo="CPF" dados={dados} onMudar={mudar} dica="000.000.000-00" />
                <Campo id="cliente_endereco" rotulo="Endereço completo com CEP" dados={dados} onMudar={mudar} className="sm:col-span-2" />
              </div>
            </fieldset>

            <fieldset className="mt-5">
              <legend className="text-sm font-semibold text-slate-900">Advogado(a) e escritório</legend>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <Campo id="advogado_nome" rotulo="Advogado(a)" dados={dados} onMudar={mudar} />
                <Campo id="advogado_oab" rotulo="OAB (UF e número)" dados={dados} onMudar={mudar} dica="GO 12.345" />
                <Campo id="escritorio_endereco" rotulo="Endereço do escritório" dados={dados} onMudar={mudar} className="sm:col-span-2" />
              </div>
            </fieldset>

            <fieldset className="mt-5">
              <legend className="text-sm font-semibold text-slate-900">Objeto {modelo === "contrato_honorarios" ? "e honorários" : "e poderes"}</legend>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="doc-area" className="block text-xs font-medium text-slate-600">Área</label>
                  <select
                    id="doc-area"
                    value={dados.area}
                    onChange={(e) => setDados({ ...dados, area: e.target.value as AreaJuridica | "" })}
                    className={campo}
                  >
                    <option value="">Selecione…</option>
                    {(Object.keys(AREAS_JURIDICAS) as AreaJuridica[]).map((a) => (
                      <option key={a} value={a}>{AREAS_JURIDICAS[a]}</option>
                    ))}
                  </select>
                </div>
                <Campo id="objeto" rotulo={modelo === "procuracao" ? "Finalidade" : "Descrição dos serviços"} dados={dados} onMudar={mudar} />
                {modelo === "contrato_honorarios" ? (
                  <>
                    <Campo id="honorarios_fixos" rotulo="Honorários fixos (R$)" dados={dados} onMudar={mudar} dica="3.000,00" />
                    <Campo id="honorarios_percentual" rotulo="Êxito (% do proveito)" dados={dados} onMudar={mudar} dica="30" />
                    <Campo id="forma_pagamento" rotulo="Forma de pagamento" dados={dados} onMudar={mudar} className="sm:col-span-2" />
                    <Campo id="foro" rotulo="Foro (comarca)" dados={dados} onMudar={mudar} />
                  </>
                ) : (
                  <label className="flex items-start gap-2 text-sm text-slate-700 sm:col-span-2">
                    <input
                      type="checkbox"
                      checked={dados.poderes_especiais}
                      onChange={(e) => setDados({ ...dados, poderes_especiais: e.target.checked })}
                      className="mt-1 size-4 rounded border-slate-300"
                    />
                    Incluir poderes especiais do art. 105 do CPC (receber citação, confessar, transigir, desistir, dar quitação…)
                  </label>
                )}
                <Campo id="cidade" rotulo="Cidade da assinatura" dados={dados} onMudar={mudar} />
                <Campo id="data" rotulo="Data" tipo="date" dados={dados} onMudar={mudar} />
              </div>
            </fieldset>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto bg-slate-100 px-4 py-6">
            <style>{CSS_DOCUMENTO}</style>
            <p className="mx-auto mb-3 max-w-[21cm] text-xs text-slate-500">
              Clique no texto para editar. Trechos destacados indicam campos não preenchidos.
            </p>
            <div
              ref={editorRef}
              contentEditable
              suppressContentEditableWarning
              aria-label="Texto do documento (editável)"
              className="doc-juridico mx-auto min-h-[29.7cm] max-w-[21cm] bg-white px-[2cm] py-[2.5cm] shadow-md outline-none focus:ring-2 focus:ring-navy-500/30"
            />
          </div>
        )}

        {dados && !erro && (
          <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-slate-50 px-6 py-3">
            {etapa === "revisao" ? (
              <button type="button" onClick={voltar} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-200/60">
                <ArrowLeft className="size-4" aria-hidden /> Voltar aos dados
              </button>
            ) : (
              <span />
            )}
            {etapa === "dados" ? (
              <button type="button" onClick={gerar} className="rounded-lg bg-navy-900 px-5 py-2 text-sm font-semibold text-white hover:bg-navy-800">
                Gerar texto
              </button>
            ) : (
              <button type="button" onClick={imprimir} className="inline-flex items-center gap-2 rounded-lg bg-navy-900 px-5 py-2 text-sm font-semibold text-white hover:bg-navy-800">
                <Printer className="size-4" aria-hidden /> Imprimir / salvar PDF
              </button>
            )}
          </footer>
        )}
      </div>
    </dialog>
  );
}

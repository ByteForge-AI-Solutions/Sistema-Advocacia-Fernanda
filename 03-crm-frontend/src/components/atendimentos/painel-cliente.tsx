"use client";

import { useEffect, useState, type FormEvent } from "react";
import { CalendarDays, FilePen, Gavel, LoaderCircle, Tag, X } from "lucide-react";
import { GerarDocumentosModal } from "@/components/documentos/gerar-documentos-modal";
import { AREAS_JURIDICAS, isAreaJuridica } from "@/lib/advogados";
import { formatarTelefoneBr, salvarEtiquetas, type Atendimento } from "@/lib/atendimentos";
import { carregarHistoricoFicha, type HistoricoFicha } from "@/lib/ficha-detalhe";

const fmtData = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
const fmtDataHora = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** "2026-11-20" (date do Postgres) → Date local, sem deslocamento de fuso. */
const dataLocal = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00`);

function rotuloCampo(chave: string) {
  const t = chave.replaceAll("_", " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function valorCampo(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "Sim" : "Não";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function Bloco({ titulo, icone, children }: { titulo: string; icone?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border-b border-slate-100 px-4 py-4">
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
        {icone}
        {titulo}
      </h3>
      {children}
    </section>
  );
}

export function PainelCliente({
  atendimento,
  nomeResponsavel,
  podeEditar,
  onEtiquetasSalvas,
  onFechar,
}: {
  atendimento: Atendimento;
  nomeResponsavel: string | null;
  podeEditar: boolean;
  onEtiquetasSalvas: (etiquetas: string[]) => void;
  onFechar?: () => void;
}) {
  const [historico, setHistorico] = useState<HistoricoFicha | null>(null);
  const [novaEtiqueta, setNovaEtiqueta] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [docsAberto, setDocsAberto] = useState(false);

  const fichaId = atendimento.ficha_id;
  useEffect(() => {
    if (!fichaId) return;
    let atual = true;
    carregarHistoricoFicha(fichaId).then((h) => atual && setHistorico(h));
    return () => {
      atual = false;
    };
  }, [fichaId]);
  const hist = fichaId ? historico : null;

  const etiquetas = atendimento.etiquetas ?? [];

  async function gravar(lista: string[]) {
    setSalvando(true);
    setErro(null);
    try {
      onEtiquetasSalvas(await salvarEtiquetas(atendimento.telefone, lista));
      setNovaEtiqueta("");
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Não foi possível salvar.");
    } finally {
      setSalvando(false);
    }
  }

  function adicionar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const t = novaEtiqueta.trim().toLowerCase().replace(/^#/, "");
    if (!t || etiquetas.includes(t)) return;
    void gravar([...etiquetas, t]);
  }

  const dados = Object.entries(atendimento.dados_coletados ?? {}).filter(([, v]) => v !== null && v !== "");

  return (
    <aside aria-label="Dados do cliente" className="flex min-h-0 flex-col overflow-y-auto border-slate-200 bg-white xl:border-l">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-900">Cliente</h2>
        {onFechar && (
          <button type="button" onClick={onFechar} aria-label="Fechar painel" className="rounded-md p-1 text-slate-400 hover:bg-slate-100 xl:hidden">
            <X className="size-4" />
          </button>
        )}
      </div>

      <Bloco titulo="Identificação">
        <p className="font-medium text-slate-900">{atendimento.nome_cliente || "Não identificado"}</p>
        <p className="text-sm text-slate-600">{formatarTelefoneBr(atendimento.telefone)}</p>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-slate-500">Área</dt>
          <dd className="text-slate-800">{atendimento.area && isAreaJuridica(atendimento.area) ? AREAS_JURIDICAS[atendimento.area] : "A classificar"}</dd>
          <dt className="text-slate-500">Prioridade</dt>
          <dd className="capitalize text-slate-800">{atendimento.prioridade === "media" ? "média" : atendimento.prioridade}</dd>
          <dt className="text-slate-500">Responsável</dt>
          <dd className="text-slate-800">{nomeResponsavel ?? "Sem responsável"}</dd>
          <dt className="text-slate-500">Etapa do bot</dt>
          <dd className="text-slate-800">{rotuloCampo(atendimento.etapa)}</dd>
        </dl>
        {atendimento.motivo_prioridade && (
          <p className="mt-2 rounded-md bg-slate-50 px-2.5 py-1.5 text-xs text-slate-600">{atendimento.motivo_prioridade}</p>
        )}
      </Bloco>

      <Bloco titulo="Etiquetas" icone={<Tag className="size-3.5" aria-hidden />}>
        <div className="flex flex-wrap gap-1.5">
          {etiquetas.length === 0 && <span className="text-sm text-slate-400">Nenhuma etiqueta.</span>}
          {etiquetas.map((t) => (
            <span key={t} className="inline-flex items-center gap-1 rounded-full bg-navy-50 px-2 py-0.5 text-xs font-medium text-navy-800 ring-1 ring-navy-100">
              #{t}
              {podeEditar && (
                <button
                  type="button"
                  disabled={salvando}
                  onClick={() => void gravar(etiquetas.filter((x) => x !== t))}
                  aria-label={`Remover etiqueta ${t}`}
                  className="rounded-full text-navy-400 hover:text-navy-800"
                >
                  <X className="size-3" />
                </button>
              )}
            </span>
          ))}
        </div>
        {podeEditar && (
          <form onSubmit={adicionar} className="mt-2 flex gap-1.5">
            <input
              value={novaEtiqueta}
              onChange={(e) => setNovaEtiqueta(e.target.value)}
              maxLength={30}
              placeholder="nova etiqueta"
              aria-label="Nova etiqueta"
              className="min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1 text-sm outline-none focus:border-navy-500"
            />
            <button type="submit" disabled={salvando || !novaEtiqueta.trim()} className="rounded-md bg-navy-900 px-2.5 text-xs font-semibold text-white disabled:opacity-50">
              {salvando ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : "Adicionar"}
            </button>
          </form>
        )}
        {erro && <p className="mt-1.5 text-xs text-red-700">{erro}</p>}
      </Bloco>

      <Bloco titulo="Resumo da triagem">
        <p className="whitespace-pre-line text-sm leading-relaxed text-slate-700">{atendimento.resumo_fatos || "Aguardando triagem."}</p>
        {dados.length > 0 && (
          <dl className="mt-3 space-y-1 text-xs">
            {dados.map(([k, v]) => (
              <div key={k} className="flex gap-2">
                <dt className="shrink-0 text-slate-500">{rotuloCampo(k)}:</dt>
                <dd className="break-words text-slate-700">{valorCampo(v)}</dd>
              </div>
            ))}
          </dl>
        )}
      </Bloco>

      {fichaId ? (
        <>
          <Bloco titulo="Ficha no CRM">
            {!hist ? (
              <LoaderCircle className="size-4 animate-spin text-slate-400" aria-hidden />
            ) : hist.ficha ? (
              <div className="space-y-2 text-sm">
                <p className="text-slate-600">
                  Criada em {fmtData.format(new Date(hist.ficha.created_at))} · status{" "}
                  <span className="font-medium text-slate-800">{(hist.ficha.status_atendimento ?? "novo").replaceAll("_", " ")}</span>
                </p>
                <button
                  type="button"
                  onClick={() => setDocsAberto(true)}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-navy-900 px-3 py-2 text-sm font-semibold text-white transition hover:bg-navy-800"
                >
                  <FilePen className="size-4" aria-hidden /> Gerar documentos
                </button>
              </div>
            ) : (
              <p className="text-sm text-slate-500">Ficha não disponível para você.</p>
            )}
          </Bloco>

          <Bloco titulo="Reuniões" icone={<CalendarDays className="size-3.5" aria-hidden />}>
            {!hist ? null : hist.reunioes.length === 0 ? (
              <p className="text-sm text-slate-400">Nenhuma reunião.</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {hist.reunioes.map((r) => (
                  <li key={r.id} className="flex justify-between gap-2">
                    <span className={`truncate ${r.status === "cancelado" ? "text-slate-400 line-through" : "text-slate-700"}`}>{r.titulo_evento}</span>
                    <span className="shrink-0 text-xs tabular-nums text-slate-500">{fmtDataHora.format(new Date(r.data_hora_inicio))}</span>
                  </li>
                ))}
              </ul>
            )}
          </Bloco>

          <Bloco titulo="Prazos processuais" icone={<Gavel className="size-3.5" aria-hidden />}>
            {!hist ? null : hist.prazos.length === 0 ? (
              <p className="text-sm text-slate-400">Nenhum prazo cadastrado.</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {hist.prazos.map((p) => (
                  <li key={p.id}>
                    <p className={`truncate ${p.status === "cumprido" ? "text-slate-400 line-through" : "text-slate-700"}`}>{p.descricao_prazo}</p>
                    <p className="text-xs text-slate-500">
                      {p.numero_cnj} · fatal {fmtData.format(dataLocal(p.data_fatal))}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Bloco>
        </>
      ) : (
        <Bloco titulo="Ficha no CRM">
          <p className="text-sm text-slate-500">O bot ainda não gerou ficha para este atendimento.</p>
        </Bloco>
      )}

      {docsAberto && fichaId && <GerarDocumentosModal fichaId={fichaId} onFechar={() => setDocsAberto(false)} />}
    </aside>
  );
}

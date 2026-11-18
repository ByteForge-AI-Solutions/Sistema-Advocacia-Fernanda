"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Calculator, CircleAlert, Gavel, LoaderCircle, X } from "lucide-react";
import type { Advogado, MembroEquipe } from "@/lib/advogados";
import { buscarFichas, type Ficha } from "@/lib/fichas";
import {
  STATUS_PRAZO_LABEL,
  buscarFeriados,
  calcularDataFatal,
  cnjValido,
  dataLocal,
  mascararCnj,
  salvarPrazo,
  type DadosPrazo,
  type PrazoNaTela,
  type StatusPrazo,
  type TipoContagem,
} from "@/lib/prazos";

const campo =
  "mt-1.5 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition focus:border-navy-500 focus:ring-3 focus:ring-navy-500/15";
const rotulo = "block text-sm font-medium text-slate-700";
const fmtData = new Intl.DateTimeFormat("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" });

interface FormPrazo {
  numero_cnj: string;
  ficha_id: string;
  advogado_id: string;
  tribunal_vara: string;
  fase_processual: string;
  descricao_prazo: string;
  data_fatal: string;
  tipo_contagem: TipoContagem;
  status: StatusPrazo;
  observacoes: string;
}

export function PrazoModal({
  perfil,
  responsaveis,
  prazo,
  onFechar,
  onSalvo,
}: {
  perfil: Advogado;
  responsaveis: MembroEquipe[];
  prazo?: PrazoNaTela;
  onFechar: () => void;
  onSalvo: (mensagem: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [form, setForm] = useState<FormPrazo>(() => ({
    numero_cnj: prazo?.numero_cnj ?? "",
    ficha_id: prazo?.ficha_id ?? "",
    advogado_id: prazo?.advogado_id ?? perfil.id,
    tribunal_vara: prazo?.tribunal_vara ?? "",
    fase_processual: prazo?.fase_processual ?? "",
    descricao_prazo: prazo?.descricao_prazo ?? "",
    data_fatal: prazo?.data_fatal ?? "",
    tipo_contagem: prazo?.tipo_contagem ?? "uteis",
    status: prazo?.status ?? "pendente",
    observacoes: prazo?.observacoes ?? "",
  }));
  const [fichas, setFichas] = useState<Ficha[] | null>(null);
  const [feriados, setFeriados] = useState<Set<string>>(new Set());
  const [intimacao, setIntimacao] = useState("");
  const [qtdDias, setQtdDias] = useState("15");
  const [erros, setErros] = useState<string[]>([]);
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);

  useEffect(() => {
    let atual = true;
    buscarFichas(perfil).then(
      (l) => atual && setFichas([...l].sort((a, b) => a.nome_cliente.localeCompare(b.nome_cliente, "pt-BR"))),
      () => atual && setFichas([]),
    );
    buscarFeriados().then((f) => atual && setFeriados(f));
    return () => {
      atual = false;
    };
  }, [perfil]);

  const definir = <K extends keyof FormPrazo>(k: K, v: FormPrazo[K]) => setForm((f) => ({ ...f, [k]: v }));

  const sugestao = useMemo(
    () => calcularDataFatal(intimacao, Number(qtdDias), form.tipo_contagem, feriados),
    [intimacao, qtdDias, form.tipo_contagem, feriados],
  );

  const cnjCompleto = form.numero_cnj.replace(/\D/g, "").length === 20;
  const avisoCnj = cnjCompleto && !cnjValido(form.numero_cnj);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const problemas: string[] = [];
    if (!cnjCompleto) problemas.push("Informe o número do processo no padrão CNJ (20 dígitos).");
    if (!form.descricao_prazo.trim()) problemas.push("Descreva o prazo (ex.: contestação, recurso ordinário).");
    if (!form.data_fatal) problemas.push("Informe a data fatal.");
    if (!responsaveis.some((r) => r.id === form.advogado_id)) problemas.push("Responsável inválido.");
    setErros(problemas);
    if (problemas.length) return;

    const dados: DadosPrazo = {
      numero_cnj: mascararCnj(form.numero_cnj),
      ficha_id: form.ficha_id || null,
      advogado_id: form.advogado_id,
      tribunal_vara: form.tribunal_vara.trim() || null,
      fase_processual: form.fase_processual.trim() || null,
      descricao_prazo: form.descricao_prazo.trim(),
      data_fatal: form.data_fatal,
      tipo_contagem: form.tipo_contagem,
      status: form.status,
      observacoes: form.observacoes.trim() || null,
    };
    setSalvando(true);
    try {
      await salvarPrazo(dados, prazo?.id);
      onSalvo(prazo ? "Prazo atualizado." : "Prazo cadastrado.");
    } catch (err) {
      setErros([err instanceof Error ? err.message : "Não foi possível salvar."]);
      setSalvando(false);
    }
  }

  return (
    <dialog
      ref={ref}
      onClose={onFechar}
      aria-labelledby="prazo-titulo"
      className="m-auto max-h-[92vh] w-[calc(100%-2rem)] max-w-2xl overflow-hidden rounded-2xl bg-white p-0 shadow-2xl ring-1 ring-slate-900/10 backdrop:bg-navy-950/60"
    >
      <form onSubmit={handleSubmit} noValidate className="flex max-h-[92vh] flex-col">
        <header className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <h2 id="prazo-titulo" className="flex items-center gap-2 text-lg font-semibold text-navy-950">
            <Gavel className="size-5 text-navy-700" aria-hidden /> {prazo ? "Editar prazo" : "Novo prazo processual"}
          </h2>
          <button type="button" onClick={onFechar} aria-label="Fechar" className="rounded-md p-1 text-slate-400 hover:bg-slate-100">
            <X className="size-4" />
          </button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="cnj" className={rotulo}>Número do processo (CNJ)</label>
              <input
                id="cnj"
                inputMode="numeric"
                value={form.numero_cnj}
                onChange={(e) => definir("numero_cnj", mascararCnj(e.target.value))}
                placeholder="0000000-00.0000.0.00.0000"
                className={`${campo} font-mono`}
              />
              {avisoCnj && (
                <p className="mt-1 text-xs text-amber-700">Dígito verificador não confere. Confira o número (o salvamento é permitido).</p>
              )}
            </div>
            <div>
              <label htmlFor="tribunal" className={rotulo}>Tribunal / vara</label>
              <input id="tribunal" value={form.tribunal_vara} onChange={(e) => definir("tribunal_vara", e.target.value)} placeholder="Ex.: 2ª Vara do Trabalho de Goiânia" className={campo} />
            </div>
            <div>
              <label htmlFor="ficha" className={rotulo}>Cliente / ficha</label>
              <select id="ficha" value={form.ficha_id} disabled={fichas === null} onChange={(e) => definir("ficha_id", e.target.value)} className={campo}>
                <option value="">{fichas === null ? "Carregando…" : "Sem ficha vinculada"}</option>
                {form.ficha_id && fichas && !fichas.some((f) => f.id === form.ficha_id) && (
                  <option value={form.ficha_id}>{prazo?.ficha?.nome_cliente ?? "Ficha vinculada"}</option>
                )}
                {fichas?.map((f) => (
                  <option key={f.id} value={f.id}>{f.nome_cliente}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="resp" className={rotulo}>Responsável</label>
              <select id="resp" value={form.advogado_id} disabled={responsaveis.length <= 1} onChange={(e) => definir("advogado_id", e.target.value)} className={campo}>
                {responsaveis.map((r) => (
                  <option key={r.id} value={r.id}>{r.id === perfil.id ? `${r.nome} (você)` : `${r.nome} · estagiário(a)`}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="fase" className={rotulo}>Fase processual</label>
              <input id="fase" value={form.fase_processual} onChange={(e) => definir("fase_processual", e.target.value)} placeholder="Ex.: conhecimento, recursal, execução" className={campo} />
            </div>
            <div>
              <label htmlFor="descricao" className={rotulo}>Descrição do prazo</label>
              <input id="descricao" value={form.descricao_prazo} onChange={(e) => definir("descricao_prazo", e.target.value)} placeholder="Ex.: Recurso ordinário" className={campo} />
            </div>
          </div>

          <section className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-800">
              <Calculator className="size-4" aria-hidden /> Calcular data fatal (opcional)
            </h3>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <div>
                <label htmlFor="intimacao" className="block text-xs font-medium text-slate-600">Intimação / publicação</label>
                <input id="intimacao" type="date" value={intimacao} onChange={(e) => setIntimacao(e.target.value)} className={campo} />
              </div>
              <div>
                <label htmlFor="qtd" className="block text-xs font-medium text-slate-600">Prazo (dias)</label>
                <input id="qtd" type="number" min={1} max={3650} value={qtdDias} onChange={(e) => setQtdDias(e.target.value)} className={campo} />
              </div>
              <div>
                <label htmlFor="contagem" className="block text-xs font-medium text-slate-600">Contagem</label>
                <select id="contagem" value={form.tipo_contagem} onChange={(e) => definir("tipo_contagem", e.target.value as TipoContagem)} className={campo}>
                  <option value="uteis">Dias úteis</option>
                  <option value="corridos">Dias corridos</option>
                </select>
              </div>
            </div>
            {sugestao && (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white px-3 py-2 text-sm ring-1 ring-slate-200">
                <span>
                  Data fatal estimada: <strong className="text-navy-900">{fmtData.format(dataLocal(sugestao))}</strong>
                </span>
                <button type="button" onClick={() => definir("data_fatal", sugestao)} className="rounded-md bg-navy-900 px-2.5 py-1 text-xs font-semibold text-white hover:bg-navy-800">
                  Usar esta data
                </button>
              </div>
            )}
            <p className="mt-2 text-[11px] leading-snug text-slate-500">
              Considera fins de semana, recesso de 20/12 a 20/01 e os feriados cadastrados. Não considera feriados locais
              não cadastrados nem suspensões do tribunal: confira sempre no sistema do tribunal.
            </p>
          </section>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="fatal" className={rotulo}>Data fatal</label>
              <input id="fatal" type="date" value={form.data_fatal} onChange={(e) => definir("data_fatal", e.target.value)} className={campo} />
            </div>
            <fieldset>
              <legend className={rotulo}>Status</legend>
              <div className="mt-1.5 grid grid-cols-3 gap-1.5">
                {(Object.keys(STATUS_PRAZO_LABEL) as StatusPrazo[]).map((s) => (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={form.status === s}
                    onClick={() => definir("status", s)}
                    className={`rounded-lg px-2 py-2.5 text-sm font-medium transition ${
                      form.status === s
                        ? s === "urgente"
                          ? "bg-red-600 text-white"
                          : s === "cumprido"
                            ? "bg-emerald-600 text-white"
                            : "bg-navy-900 text-white"
                        : "bg-white text-slate-600 ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
                    }`}
                  >
                    {STATUS_PRAZO_LABEL[s]}
                  </button>
                ))}
              </div>
            </fieldset>
          </div>

          <div>
            <label htmlFor="obs" className={rotulo}>Observações</label>
            <textarea id="obs" rows={2} value={form.observacoes} onChange={(e) => definir("observacoes", e.target.value)} className={campo} />
          </div>

          {erros.length > 0 && (
            <div role="alert" className="flex items-start gap-2.5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <ul className="space-y-0.5">{erros.map((e) => <li key={e}>{e}</li>)}</ul>
            </div>
          )}
        </div>

        <footer className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-6 py-4">
          <button type="button" onClick={onFechar} className="rounded-lg px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-200/60">
            Cancelar
          </button>
          <button type="submit" disabled={salvando} className="inline-flex items-center gap-2 rounded-lg bg-navy-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-navy-800 disabled:opacity-60">
            {salvando && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
            {prazo ? "Salvar alterações" : "Cadastrar prazo"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}

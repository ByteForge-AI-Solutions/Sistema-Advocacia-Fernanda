"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Calculator, CircleAlert, Flame, LoaderCircle, ShieldCheck, X } from "lucide-react";
import { STATUS_ATENDIMENTO, STATUS_LABEL, type Ficha, type StatusAtendimento } from "@/lib/fichas";
import { deInputLocal, paraInputLocal, proximaHoraCheia } from "@/lib/datas";
import {
  AVISO_DOCUMENTO,
  AVISO_SIMULACAO,
  DORES,
  DOR_LABEL,
  FAIXAS_DIVIDA,
  FAIXA_LABEL,
  ONDE_DIVIDA,
  ONDE_LABEL,
  TEMPERATURA_INFO,
  calcularTemperatura,
  contemDocumentoPessoal,
  salvarLead,
  simularExemplo,
  type DorPrincipal,
  type FaixaDivida,
  type OndeDivida,
} from "@/lib/leads";

const campo =
  "mt-1.5 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition focus:border-navy-500 focus:ring-3 focus:ring-navy-500/15";
const rotulo = "block text-sm font-medium text-slate-700";
const fmtMoeda = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });

/** Sugestões rápidas para o texto da próxima ação (cadência do documento, seção 5). */
const SUGESTOES = ["Enviar 1ª mensagem", "Retomar conversa", "Ligação de 10 min", "Enviar proposta", "Cobrar procuração e-CAC"];

interface FormLead {
  status: StatusAtendimento;
  proxima_acao: string;
  proxima_acao_em: string;
  faixa_divida: FaixaDivida | "";
  bloqueio_penhora: boolean;
  dor_principal: DorPrincipal | "";
  onde_divida: OndeDivida[];
}

/**
 * Edição da ficha como lead: status, próxima ação (obrigatória para lead ativo — regra de
 * ouro), qualificação que gera a cor de prioridade e uma simulação de EXEMPLO não salva.
 * CPF/CNPJ não aparecem nem são editados aqui (LGPD).
 */
export function EditarLeadModal({
  ficha,
  onFechar,
  onSalvo,
}: {
  ficha: Ficha;
  onFechar: () => void;
  onSalvo: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [form, setForm] = useState<FormLead>(() => ({
    status: ficha.status ?? "novo",
    proxima_acao: ficha.lead.proxima_acao ?? "",
    proxima_acao_em: ficha.lead.proxima_acao_em ? paraInputLocal(ficha.lead.proxima_acao_em) : "",
    faixa_divida: ficha.lead.faixa_divida ?? "",
    bloqueio_penhora: ficha.lead.bloqueio_penhora,
    dor_principal: ficha.lead.dor_principal ?? "",
    onde_divida: ficha.lead.onde_divida,
  }));
  const [erros, setErros] = useState<string[]>([]);
  const [salvando, setSalvando] = useState(false);
  // Simulação: só estado local, nunca enviada ao banco.
  const [simValor, setSimValor] = useState("");
  const [simDesconto, setSimDesconto] = useState("");
  const [simParcelas, setSimParcelas] = useState("60");

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);

  const definir = <K extends keyof FormLead>(k: K, v: FormLead[K]) => setForm((f) => ({ ...f, [k]: v }));
  const ativo = form.status !== "finalizado";

  const temperatura = useMemo(
    () =>
      calcularTemperatura({
        faixa_divida: form.faixa_divida || null,
        bloqueio_penhora: form.bloqueio_penhora,
        dor_principal: form.dor_principal || null,
        onde_divida: form.onde_divida,
      }),
    [form.faixa_divida, form.bloqueio_penhora, form.dor_principal, form.onde_divida],
  );

  const simulacao = useMemo(
    () => simularExemplo(Number(simValor.replace(/\./g, "").replace(",", ".")), Number(simDesconto.replace(",", ".")), Number(simParcelas)),
    [simValor, simDesconto, simParcelas],
  );

  function alternarOnde(o: OndeDivida) {
    definir("onde_divida", form.onde_divida.includes(o) ? form.onde_divida.filter((x) => x !== o) : [...form.onde_divida, o]);
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const problemas: string[] = [];
    const quando = deInputLocal(form.proxima_acao_em);
    const texto = form.proxima_acao.trim();
    if (ativo && !texto) problemas.push("Descreva a próxima ação: lead ativo sem próximo passo é lead perdido.");
    if (ativo && !quando) problemas.push("Informe a data e a hora da próxima ação.");
    if (texto.length > 280) problemas.push("A próxima ação deve ter até 280 caracteres.");
    if (texto && contemDocumentoPessoal(texto)) problemas.push(AVISO_DOCUMENTO);
    setErros(problemas);
    if (problemas.length) return;

    setSalvando(true);
    try {
      await salvarLead(ficha.id, {
        status_atendimento: form.status,
        proxima_acao: texto || null,
        proxima_acao_em: quando ? quando.toISOString() : null,
        faixa_divida: form.faixa_divida || null,
        bloqueio_penhora: form.bloqueio_penhora,
        dor_principal: form.dor_principal || null,
        onde_divida: form.onde_divida,
      });
      onSalvo();
    } catch (err) {
      setErros([err instanceof Error ? err.message : "Não foi possível salvar."]);
      setSalvando(false);
    }
  }

  const info = temperatura ? TEMPERATURA_INFO[temperatura] : null;

  return (
    <dialog
      ref={ref}
      onClose={onFechar}
      aria-labelledby="lead-titulo"
      className="m-auto max-h-[92vh] w-[calc(100%-2rem)] max-w-2xl overflow-hidden rounded-2xl bg-white p-0 shadow-2xl ring-1 ring-slate-900/10 backdrop:bg-navy-950/60"
    >
      <form onSubmit={handleSubmit} noValidate className="flex max-h-[92vh] flex-col">
        <header className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div className="min-w-0">
            <h2 id="lead-titulo" className="text-lg font-semibold text-navy-950">Editar lead</h2>
            <p className="truncate text-sm text-slate-500">{ficha.nome_cliente}</p>
          </div>
          <button type="button" onClick={onFechar} aria-label="Fechar" className="rounded-md p-1 text-slate-400 hover:bg-slate-100">
            <X className="size-4" />
          </button>
        </header>

        <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
          {/* Status e próxima ação */}
          <section className="space-y-4">
            <div>
              <label htmlFor="lead-status" className={rotulo}>Status do atendimento</label>
              <select id="lead-status" value={form.status} onChange={(e) => definir("status", e.target.value as StatusAtendimento)} className={campo}>
                {STATUS_ATENDIMENTO.map((s) => (
                  <option key={s} value={s}>{STATUS_LABEL[s]}</option>
                ))}
              </select>
            </div>

            <div className="grid gap-4 sm:grid-cols-[1fr_14rem]">
              <div>
                <label htmlFor="lead-acao" className={rotulo}>
                  Próxima ação {ativo && <span className="text-red-600" aria-hidden>*</span>}
                </label>
                <input
                  id="lead-acao"
                  required={ativo}
                  aria-required={ativo}
                  maxLength={280}
                  value={form.proxima_acao}
                  onChange={(e) => definir("proxima_acao", e.target.value)}
                  placeholder="Ex.: Ligação de 10 min para entender a execução"
                  className={campo}
                />
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {SUGESTOES.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => definir("proxima_acao", s)}
                      className="rounded-full px-2 py-0.5 text-[11px] text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-50"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label htmlFor="lead-quando" className={rotulo}>
                  Data da próxima ação {ativo && <span className="text-red-600" aria-hidden>*</span>}
                </label>
                <input
                  id="lead-quando"
                  type="datetime-local"
                  required={ativo}
                  aria-required={ativo}
                  value={form.proxima_acao_em}
                  onChange={(e) => definir("proxima_acao_em", e.target.value)}
                  className={campo}
                />
                {!form.proxima_acao_em && (
                  <button
                    type="button"
                    onClick={() => definir("proxima_acao_em", paraInputLocal(proximaHoraCheia()))}
                    className="mt-1.5 text-xs font-medium text-navy-700 hover:text-navy-900"
                  >
                    Usar a próxima hora cheia
                  </button>
                )}
              </div>
            </div>
            <p className="text-xs text-slate-500">
              {ativo
                ? "Regra de ouro: lead ativo não é salvo sem próxima ação e data."
                : "Atendimento finalizado: a próxima ação é opcional."}
            </p>
          </section>

          {/* Qualificação → cor */}
          <section className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                <Flame className="size-4" aria-hidden /> Qualificação e prioridade
              </h3>
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${
                  info ? info.badge : "bg-white text-slate-500 ring-slate-300"
                }`}
              >
                {info && <span className={`size-2 rounded-full ${info.ponto}`} aria-hidden />}
                {info ? info.label : "Sem classificação"}
              </span>
            </div>
            {info && <p className="mt-1.5 text-xs text-slate-600"><strong>{info.regra}.</strong> {info.acao}</p>}

            <label className="mt-4 flex items-start gap-2.5 text-sm text-slate-800">
              <input
                type="checkbox"
                checked={form.bloqueio_penhora}
                onChange={(e) => definir("bloqueio_penhora", e.target.checked)}
                className="mt-0.5 size-4 rounded border-slate-300 text-navy-700 focus:ring-navy-500"
              />
              <span>
                Bloqueio de conta, penhora ou citação recebida
                <span className="block text-xs text-slate-500">Marca o lead como urgente.</span>
              </span>
            </label>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="lead-faixa" className={rotulo}>Faixa da dívida</label>
                <select id="lead-faixa" value={form.faixa_divida} onChange={(e) => definir("faixa_divida", e.target.value as FaixaDivida | "")} className={campo}>
                  <option value="">Não informada</option>
                  {FAIXAS_DIVIDA.map((f) => (
                    <option key={f} value={f}>{FAIXA_LABEL[f]}</option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] text-slate-500">Só a faixa é guardada, não o valor exato (LGPD).</p>
              </div>
              <div>
                <label htmlFor="lead-dor" className={rotulo}>Dor principal</label>
                <select id="lead-dor" value={form.dor_principal} onChange={(e) => definir("dor_principal", e.target.value as DorPrincipal | "")} className={campo}>
                  <option value="">Não informada</option>
                  {DORES.map((d) => (
                    <option key={d} value={d}>{DOR_LABEL[d]}</option>
                  ))}
                </select>
              </div>
            </div>

            <fieldset className="mt-4">
              <legend className={rotulo}>Onde está a dívida</legend>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {ONDE_DIVIDA.map((o) => {
                  const marcado = form.onde_divida.includes(o);
                  return (
                    <button
                      key={o}
                      type="button"
                      aria-pressed={marcado}
                      onClick={() => alternarOnde(o)}
                      className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                        marcado ? "bg-navy-900 text-white" : "bg-white text-slate-600 ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
                      }`}
                    >
                      {ONDE_LABEL[o]}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1 text-[11px] text-slate-500">Dívida só na Receita e sem urgência desce uma cor.</p>
            </fieldset>
          </section>

          {/* Simulação de exemplo (OAB) */}
          <section className="rounded-xl border border-dashed border-amber-300 bg-amber-50/50 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                <Calculator className="size-4" aria-hidden /> Simulação de exemplo
              </h3>
              <span className="rounded bg-amber-200/70 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-900">
                Exemplo · não salvo
              </span>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <div>
                <label htmlFor="sim-valor" className="block text-xs font-medium text-slate-600">Valor de exemplo (R$)</label>
                <input id="sim-valor" inputMode="decimal" autoComplete="off" value={simValor} onChange={(e) => setSimValor(e.target.value)} placeholder="Ex.: 250.000" className={campo} />
              </div>
              <div>
                <label htmlFor="sim-desc" className="block text-xs font-medium text-slate-600">Desconto de até (%)</label>
                <input id="sim-desc" inputMode="decimal" autoComplete="off" value={simDesconto} onChange={(e) => setSimDesconto(e.target.value)} placeholder="Ex.: 50" className={campo} />
              </div>
              <div>
                <label htmlFor="sim-parc" className="block text-xs font-medium text-slate-600">Parcelas</label>
                <input id="sim-parc" type="number" min={1} max={145} value={simParcelas} onChange={(e) => setSimParcelas(e.target.value)} className={campo} />
              </div>
            </div>
            {simulacao && (
              <p className="mt-3 rounded-lg bg-white px-3 py-2 text-sm text-slate-700 ring-1 ring-amber-200">
                <strong>Exemplo:</strong> com desconto de <em>até</em> {simDesconto}%, o valor poderia ficar em torno de{" "}
                <strong>{fmtMoeda.format(simulacao.valorComDesconto)}</strong>, em {simParcelas} parcelas de cerca de{" "}
                <strong>{fmtMoeda.format(simulacao.parcela)}</strong>. Depende da análise do caso.
              </p>
            )}
            <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-snug text-amber-900">
              <ShieldCheck className="mt-px size-3.5 shrink-0" aria-hidden /> {AVISO_SIMULACAO}
            </p>
          </section>

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
            Salvar lead
          </button>
        </footer>
      </form>
    </dialog>
  );
}

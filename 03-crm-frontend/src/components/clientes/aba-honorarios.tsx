"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Ban, CircleAlert, HandCoins, LoaderCircle, Plus, Trash, Undo2 } from "lucide-react";
import type { Advogado } from "@/lib/advogados";
import { chaveDia } from "@/lib/datas";
import {
  STATUS_CONTRATO_INFO,
  STATUS_PARCELA_INFO,
  TIPOS_CONTRATO,
  TIPO_CONTRATO_FUNIL,
  TIPO_CONTRATO_LABEL,
  buscarFinanceiroFicha,
  cancelarContrato,
  criarContrato,
  desfazerPagamento,
  dividirParcelas,
  excluirContrato,
  formatarMoeda,
  lerMoeda,
  resumoContrato,
  somarMesesData,
  statusParcela,
  MEIO_LABEL,
  type ContratoFinanceiro,
  type FormaPagamento,
  type Parcela,
  type TipoContrato,
} from "@/lib/financeiro";
import { RegistrarPagamentoModal } from "@/components/clientes/registrar-pagamento-modal";

const campo =
  "mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-navy-500 focus:ring-3 focus:ring-navy-500/15";
const rotulo = "block text-xs font-medium text-slate-600";
const fmtData = (iso: string) => new Intl.DateTimeFormat("pt-BR").format(new Date(`${iso.slice(0, 10)}T12:00:00`));

/** Contratos de honorários da ficha, parcelas e entradas. Pagamento confirmado move o funil. */
export function AbaHonorarios({
  ficha,
  perfil,
  onAviso,
  onFunilAlterado,
}: {
  ficha: { id: string; nome_cliente: string; advogado_id: string | null };
  perfil: Advogado;
  onAviso: (msg: string) => void;
  onFunilAlterado?: () => void;
}) {
  const [contratos, setContratos] = useState<ContratoFinanceiro[] | null>(null);
  const [disponivel, setDisponivel] = useState(true);
  const [versao, setVersao] = useState(0);
  const [novo, setNovo] = useState(false);
  const [pagar, setPagar] = useState<{ parcela: Parcela; contrato: ContratoFinanceiro } | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [hoje] = useState(() => new Date());

  useEffect(() => {
    let atual = true;
    buscarFinanceiroFicha(ficha.id).then(
      (r) => {
        if (!atual) return;
        setContratos(r.contratos);
        setDisponivel(r.disponivel);
      },
      (e: unknown) => atual && setErro(e instanceof Error ? e.message : "Erro ao carregar."),
    );
    return () => {
      atual = false;
    };
  }, [ficha.id, versao]);

  const recarregar = () => setVersao((v) => v + 1);

  async function acao(fn: () => Promise<void>, msg: string, funil = false) {
    setErro(null);
    try {
      await fn();
      onAviso(msg);
      recarregar();
      if (funil) onFunilAlterado?.();
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Não foi possível concluir.");
    }
  }

  if (!disponivel) {
    return <p className="rounded-lg bg-amber-50 p-4 text-sm text-amber-900">O financeiro exige a migração 20261119_v7_financeiro_documentos.sql no Supabase.</p>;
  }
  if (contratos === null) {
    return erro ? <p role="alert" className="text-sm text-red-700">{erro}</p> : <div className="flex justify-center py-10" role="status"><LoaderCircle className="size-5 animate-spin text-navy-700" aria-hidden /></div>;
  }

  const podeExcluir = perfil.cargo !== "estagiario";

  return (
    <div className="space-y-4">
      {erro && (
        <p role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> {erro}
        </p>
      )}

      {novo ? (
        <NovoContratoForm
          ficha={ficha}
          perfil={perfil}
          onCancelar={() => setNovo(false)}
          onCriado={() => {
            setNovo(false);
            onAviso("Contrato de honorários criado.");
            recarregar();
          }}
        />
      ) : (
        <button type="button" onClick={() => setNovo(true)} className="inline-flex items-center gap-2 rounded-lg bg-navy-900 px-4 py-2 text-sm font-semibold text-white hover:bg-navy-800">
          <Plus className="size-4" aria-hidden /> Novo contrato de honorários
        </button>
      )}

      {contratos.length === 0 && !novo && <p className="py-4 text-sm text-slate-500">Nenhum contrato registrado nesta ficha.</p>}

      {contratos.map((c) => {
        const r = resumoContrato(c, hoje);
        const info = STATUS_CONTRATO_INFO[r.status];
        return (
          <section key={c.id} className={`rounded-xl border p-4 ${c.cancelado ? "border-slate-200 bg-slate-50 opacity-75" : "border-slate-200 bg-white"}`}>
            <header className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-900">
                  {TIPO_CONTRATO_LABEL[c.tipo]} · {c.descricao}
                </p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {c.valor_total !== null ? formatarMoeda(c.valor_total) : "Sem valor fixo"}
                  {c.percentual_exito !== null ? ` · êxito de ${String(c.percentual_exito).replace(".", ",")}%` : ""}
                  {" · "}
                  {c.forma_pagamento === "a_vista" ? "à vista" : `${c.parcelas.length} parcelas`}
                  {r.total > 0 && ` · recebido ${formatarMoeda(r.recebido)} · em aberto ${formatarMoeda(r.emAberto)}`}
                </p>
              </div>
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${info.badge}`}>{info.label}</span>
            </header>

            {c.parcelas.length > 0 && (
              <ul className="mt-3 divide-y divide-slate-100 rounded-lg ring-1 ring-slate-100">
                {c.parcelas.map((p) => {
                  const s = statusParcela(p, hoje);
                  return (
                    <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                      <span className="w-14 tabular-nums text-slate-500">{p.numero}/{c.parcelas.length}</span>
                      <span className="w-24 tabular-nums text-slate-700">{fmtData(p.vencimento)}</span>
                      <span className="w-28 font-medium tabular-nums text-slate-900">{formatarMoeda(p.valor)}</span>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${STATUS_PARCELA_INFO[s].badge}`}>{STATUS_PARCELA_INFO[s].label}</span>
                      {p.pago_em && (
                        <span className="text-xs text-slate-500">
                          {fmtData(p.pago_em)} · {formatarMoeda(p.valor_pago)} · {p.meio ? MEIO_LABEL[p.meio] : ""}
                          {p.comprovante_id ? " · com comprovante" : ""}
                        </span>
                      )}
                      <span className="ml-auto flex gap-1">
                        {!c.cancelado && !p.pago_em && (
                          <button type="button" onClick={() => setPagar({ parcela: p, contrato: c })} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200 hover:bg-emerald-50">
                            <HandCoins className="size-3.5" aria-hidden /> Registrar pagamento
                          </button>
                        )}
                        {p.pago_em && podeExcluir && (
                          <button
                            type="button"
                            onClick={() => confirm("Desfazer o registro deste pagamento?") && void acao(() => desfazerPagamento(p.id), "Pagamento desfeito.")}
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
                          >
                            <Undo2 className="size-3.5" aria-hidden /> Desfazer
                          </button>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}

            <footer className="mt-3 flex flex-wrap gap-2 text-xs">
              {TIPO_CONTRATO_FUNIL[c.tipo] && !c.cancelado && <span className="text-slate-500">{TIPO_CONTRATO_FUNIL[c.tipo]}</span>}
              <span className="ml-auto flex gap-1">
                {/* Cancelar, desfazer pagamento e excluir: só titular/sócio (o banco também bloqueia, v9). */}
                {podeExcluir && (
                <button
                  type="button"
                  onClick={() =>
                    void acao(() => cancelarContrato(c.id, !c.cancelado), c.cancelado ? "Contrato reativado." : "Contrato cancelado.")
                  }
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-slate-600 hover:bg-slate-100"
                >
                  <Ban className="size-3.5" aria-hidden /> {c.cancelado ? "Reativar" : "Cancelar contrato"}
                </button>
                )}
                {podeExcluir && r.pagas === 0 && (
                  <button
                    type="button"
                    onClick={() => confirm("Excluir este contrato e suas parcelas?") && void acao(() => excluirContrato(c.id), "Contrato excluído.")}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-red-700 hover:bg-red-50"
                  >
                    <Trash className="size-3.5" aria-hidden /> Excluir
                  </button>
                )}
              </span>
            </footer>
          </section>
        );
      })}

      {pagar && (
        <RegistrarPagamentoModal
          parcela={pagar.parcela}
          fichaId={ficha.id}
          cliente={ficha.nome_cliente}
          descricao={pagar.contrato.descricao}
          onFechar={() => setPagar(null)}
          onSalvo={() => {
            setPagar(null);
            onAviso("Pagamento registrado.");
            recarregar();
            onFunilAlterado?.();
          }}
        />
      )}
    </div>
  );
}

function NovoContratoForm({
  ficha,
  perfil,
  onCancelar,
  onCriado,
}: {
  ficha: { id: string; advogado_id: string | null };
  perfil: Advogado;
  onCancelar: () => void;
  onCriado: () => void;
}) {
  const [tipo, setTipo] = useState<TipoContrato>("honorarios");
  const [descricao, setDescricao] = useState("");
  const [valor, setValor] = useState("");
  const [forma, setForma] = useState<FormaPagamento>("a_vista");
  const [qtd, setQtd] = useState("6");
  const [primeiro, setPrimeiro] = useState(() => somarMesesData(chaveDia(new Date()), 0));
  const [percentual, setPercentual] = useState("");
  const [observacoes, setObservacoes] = useState("");
  const [erros, setErros] = useState<string[]>([]);
  const [salvando, setSalvando] = useState(false);

  const total = lerMoeda(valor);
  const parcelas = useMemo(
    () => (total ? dividirParcelas(total, forma === "a_vista" ? 1 : Number(qtd), primeiro) : []),
    [total, forma, qtd, primeiro],
  );

  async function salvar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const p = percentual.trim() ? Number(percentual.replace(",", ".")) : null;
    const problemas: string[] = [];
    if (!descricao.trim()) problemas.push("Descreva o objeto (ex.: Transação tributária PGFN).");
    if (tipo !== "exito" && !total) problemas.push("Informe o valor dos honorários.");
    if (tipo === "exito" && !total && !p) problemas.push("Êxito: informe o percentual e/ou um valor.");
    if (p !== null && !(p > 0 && p <= 100)) problemas.push("Percentual de êxito entre 0 e 100.");
    if (total && parcelas.length === 0) problemas.push("Confira a quantidade de parcelas (1 a 240) e o 1º vencimento.");
    setErros(problemas);
    if (problemas.length) return;
    setSalvando(true);
    try {
      await criarContrato({
        fichaId: ficha.id,
        advogadoId: ficha.advogado_id ?? perfil.id,
        tipo,
        descricao: descricao.trim(),
        valorTotal: total,
        forma,
        percentualExito: p,
        observacoes: observacoes.trim() || null,
        parcelas,
      });
      onCriado();
    } catch (err) {
      setErros([err instanceof Error ? err.message : "Não foi possível criar."]);
      setSalvando(false);
    }
  }

  return (
    <form onSubmit={salvar} noValidate className="rounded-xl border border-navy-200 bg-navy-50/40 p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="fin-tipo" className={rotulo}>Tipo</label>
          <select id="fin-tipo" value={tipo} onChange={(e) => setTipo(e.target.value as TipoContrato)} className={campo}>
            {TIPOS_CONTRATO.map((t) => (
              <option key={t} value={t}>{TIPO_CONTRATO_LABEL[t]}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="fin-desc" className={rotulo}>Objeto / descrição</label>
          <input id="fin-desc" maxLength={300} value={descricao} onChange={(e) => setDescricao(e.target.value)} placeholder="Ex.: Diagnóstico tributário" className={campo} />
        </div>
        <div>
          <label htmlFor="fin-valor" className={rotulo}>Valor total (R$){tipo === "exito" ? " · opcional" : ""}</label>
          <input id="fin-valor" inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)} placeholder="3.000,00" className={campo} />
        </div>
        {tipo === "exito" || tipo === "honorarios" ? (
          <div>
            <label htmlFor="fin-perc" className={rotulo}>Êxito (% do proveito) · opcional</label>
            <input id="fin-perc" inputMode="decimal" value={percentual} onChange={(e) => setPercentual(e.target.value)} placeholder="20" className={campo} />
          </div>
        ) : (
          <div />
        )}
        <div>
          <span className={rotulo}>Forma de pagamento</span>
          <div className="mt-1 grid grid-cols-2 gap-1.5">
            {(["a_vista", "parcelado"] as FormaPagamento[]).map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={forma === f}
                onClick={() => setForma(f)}
                className={`rounded-lg px-2 py-2 text-sm font-medium ${forma === f ? "bg-navy-900 text-white" : "bg-white text-slate-600 ring-1 ring-inset ring-slate-300"}`}
              >
                {f === "a_vista" ? "À vista" : "Parcelado"}
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {forma === "parcelado" && (
            <div>
              <label htmlFor="fin-qtd" className={rotulo}>Parcelas</label>
              <input id="fin-qtd" type="number" min={2} max={240} value={qtd} onChange={(e) => setQtd(e.target.value)} className={campo} />
            </div>
          )}
          <div className={forma === "a_vista" ? "col-span-2" : ""}>
            <label htmlFor="fin-venc" className={rotulo}>{forma === "a_vista" ? "Vencimento" : "1º vencimento"}</label>
            <input id="fin-venc" type="date" value={primeiro} onChange={(e) => setPrimeiro(e.target.value)} className={campo} />
          </div>
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="fin-obs" className={rotulo}>Observações (opcional)</label>
          <input id="fin-obs" maxLength={500} value={observacoes} onChange={(e) => setObservacoes(e.target.value)} className={campo} />
        </div>
      </div>

      {parcelas.length > 1 && (
        <p className="mt-3 text-xs text-slate-600">
          {parcelas.length} parcelas: {formatarMoeda(parcelas[0].valor)}
          {parcelas.at(-1)!.valor !== parcelas[0].valor ? ` (última ${formatarMoeda(parcelas.at(-1)!.valor)})` : ""}, de {fmtData(parcelas[0].vencimento)} a {fmtData(parcelas.at(-1)!.vencimento)}.
        </p>
      )}
      {TIPO_CONTRATO_FUNIL[tipo] && <p className="mt-1 text-xs text-slate-500">{TIPO_CONTRATO_FUNIL[tipo]}</p>}

      {erros.length > 0 && (
        <div role="alert" className="mt-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <ul>{erros.map((e) => <li key={e}>{e}</li>)}</ul>
        </div>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onCancelar} className="rounded-lg px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-200/60">Cancelar</button>
        <button type="submit" disabled={salvando} className="inline-flex items-center gap-2 rounded-lg bg-navy-900 px-4 py-2 text-sm font-semibold text-white hover:bg-navy-800 disabled:opacity-60">
          {salvando && <LoaderCircle className="size-4 animate-spin" aria-hidden />} Criar contrato
        </button>
      </div>
    </form>
  );
}

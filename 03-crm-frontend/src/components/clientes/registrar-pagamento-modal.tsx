"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { CircleAlert, HandCoins, LoaderCircle, X } from "lucide-react";
import { chaveDia } from "@/lib/datas";
import {
  MEIOS,
  MEIO_LABEL,
  formatarMoeda,
  lerMoeda,
  moedaSemSimbolo,
  registrarPagamento,
  type MeioPagamento,
  type Parcela,
} from "@/lib/financeiro";
import { listarDocumentos, type DocumentoFicha } from "@/lib/repositorio";

const campo =
  "mt-1.5 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition focus:border-navy-500 focus:ring-3 focus:ring-navy-500/15";
const rotulo = "block text-sm font-medium text-slate-700";

/** Registra a entrada de uma parcela (PIX, boleto…), com comprovante opcional da própria ficha. */
export function RegistrarPagamentoModal({
  parcela,
  fichaId,
  cliente,
  descricao,
  onFechar,
  onSalvo,
}: {
  parcela: Parcela;
  fichaId: string;
  cliente: string;
  descricao: string;
  onFechar: () => void;
  onSalvo: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [pagoEm, setPagoEm] = useState(() => chaveDia(new Date()));
  const [valor, setValor] = useState(() => moedaSemSimbolo(parcela.valor));
  const [meio, setMeio] = useState<MeioPagamento>("pix");
  const [comprovante, setComprovante] = useState("");
  const [observacao, setObservacao] = useState("");
  const [comprovantes, setComprovantes] = useState<DocumentoFicha[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);

  useEffect(() => {
    let atual = true;
    listarDocumentos(fichaId).then(
      (r) => atual && setComprovantes(r.documentos.filter((d) => d.categoria === "comprovante")),
      () => atual && setComprovantes([]),
    );
    return () => {
      atual = false;
    };
  }, [fichaId]);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = lerMoeda(valor);
    if (!pagoEm) return setErro("Informe a data do pagamento.");
    if (pagoEm > chaveDia(new Date())) return setErro("A data do pagamento não pode ser futura.");
    if (!v) return setErro("Informe o valor recebido.");
    setErro(null);
    setSalvando(true);
    try {
      await registrarPagamento(parcela.id, {
        pago_em: pagoEm,
        valor_pago: v,
        meio,
        comprovante_id: comprovante || null,
        observacao: observacao.trim() || null,
      });
      onSalvo();
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Não foi possível registrar.");
      setSalvando(false);
    }
  }

  return (
    <dialog
      ref={ref}
      onClose={onFechar}
      aria-labelledby="pag-titulo"
      className="m-auto w-[calc(100%-2rem)] max-w-md overflow-hidden rounded-2xl bg-white p-0 shadow-2xl ring-1 ring-slate-900/10 backdrop:bg-navy-950/60"
    >
      <form onSubmit={handleSubmit} noValidate>
        <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-6 py-4">
          <div className="min-w-0">
            <h2 id="pag-titulo" className="flex items-center gap-2 text-lg font-semibold text-navy-950">
              <HandCoins className="size-5 text-navy-700" aria-hidden /> Registrar pagamento
            </h2>
            <p className="truncate text-sm text-slate-500">
              {cliente} · {descricao} · parcela {parcela.numero} ({formatarMoeda(parcela.valor)})
            </p>
          </div>
          <button type="button" onClick={onFechar} aria-label="Fechar" className="rounded-md p-1 text-slate-400 hover:bg-slate-100">
            <X className="size-4" />
          </button>
        </header>
        <div className="space-y-4 px-6 py-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="pag-data" className={rotulo}>Data do pagamento</label>
              <input id="pag-data" type="date" value={pagoEm} max={chaveDia(new Date())} onChange={(e) => setPagoEm(e.target.value)} className={campo} />
            </div>
            <div>
              <label htmlFor="pag-valor" className={rotulo}>Valor recebido (R$)</label>
              <input id="pag-valor" inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)} className={campo} />
            </div>
          </div>
          <div>
            <label htmlFor="pag-meio" className={rotulo}>Meio</label>
            <select id="pag-meio" value={meio} onChange={(e) => setMeio(e.target.value as MeioPagamento)} className={campo}>
              {MEIOS.map((m) => (
                <option key={m} value={m}>{MEIO_LABEL[m]}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="pag-comp" className={rotulo}>Comprovante (opcional)</label>
            <select id="pag-comp" value={comprovante} onChange={(e) => setComprovante(e.target.value)} className={campo}>
              <option value="">{comprovantes.length ? "Sem comprovante" : "Nenhum comprovante enviado na ficha"}</option>
              {comprovantes.map((d) => (
                <option key={d.id} value={d.id}>{d.nome}</option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-slate-500">Envie o comprovante na aba Documentos da ficha (categoria &quot;Comprovante de pagamento&quot;).</p>
          </div>
          <div>
            <label htmlFor="pag-obs" className={rotulo}>Observação (opcional)</label>
            <input id="pag-obs" maxLength={300} value={observacao} onChange={(e) => setObservacao(e.target.value)} className={campo} />
          </div>
          {erro && (
            <p role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> {erro}
            </p>
          )}
        </div>
        <footer className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-6 py-4">
          <button type="button" onClick={onFechar} className="rounded-lg px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-200/60">
            Cancelar
          </button>
          <button type="submit" disabled={salvando} className="inline-flex items-center gap-2 rounded-lg bg-emerald-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-60">
            {salvando && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
            Confirmar pagamento
          </button>
        </footer>
      </form>
    </dialog>
  );
}

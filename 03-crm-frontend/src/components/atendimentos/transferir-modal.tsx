"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRightLeft, LoaderCircle, X } from "lucide-react";
import type { MembroDestino } from "@/lib/atendimentos";

/**
 * Destinos válidos (mesma regra da RPC crm_atendimento_transferir, migração v4):
 * titular ativo (advogado ou sócio) ou estagiário que eu supervisiono; o sócio
 * pode transferir para qualquer estagiário.
 */
export function destinosTransferencia(equipe: MembroDestino[], meuId: string, atualId: string | null, souSocio = false) {
  return equipe.filter(
    (m) =>
      m.id !== atualId &&
      (m.cargo === "advogado" ||
        m.cargo === "socio" ||
        (m.cargo === "estagiario" && (souSocio || m.supervisor_id === meuId))),
  );
}

export function TransferirModal({
  equipe,
  meuId,
  atualId,
  souSocio = false,
  onConfirmar,
  onFechar,
}: {
  equipe: MembroDestino[];
  meuId: string;
  atualId: string | null;
  souSocio?: boolean;
  onConfirmar: (destinoId: string) => Promise<boolean>;
  onFechar: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opcoes = useMemo(() => destinosTransferencia(equipe, meuId, atualId, souSocio), [equipe, meuId, atualId, souSocio]);
  const [destino, setDestino] = useState(opcoes[0]?.id ?? "");
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);

  async function confirmar() {
    if (!destino) return;
    setEnviando(true);
    const ok = await onConfirmar(destino);
    setEnviando(false);
    if (ok) onFechar();
  }

  return (
    <dialog
      ref={ref}
      onClose={onFechar}
      aria-labelledby="transferir-titulo"
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl bg-white p-6 shadow-2xl ring-1 ring-slate-900/10 backdrop:bg-navy-950/60"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 id="transferir-titulo" className="flex items-center gap-2 text-lg font-semibold text-navy-950">
          <ArrowRightLeft className="size-5 text-navy-700" aria-hidden /> Transferir atendimento
        </h2>
        <button type="button" onClick={onFechar} aria-label="Fechar" className="rounded-md p-1 text-slate-400 hover:bg-slate-100">
          <X className="size-4" />
        </button>
      </div>
      <p className="mt-1.5 text-sm text-slate-500">
        A conversa e a ficha vinculada passam para o novo responsável. Fica registrado nas notas internas.
      </p>
      {opcoes.length === 0 ? (
        <p className="mt-4 rounded-lg bg-slate-50 p-3 text-sm text-slate-600">Não há outro titular ativo disponível.</p>
      ) : (
        <>
          <label htmlFor="destino" className="mt-4 block text-sm font-medium text-slate-700">Novo responsável</label>
          <select
            id="destino"
            value={destino}
            onChange={(e) => setDestino(e.target.value)}
            className="mt-1.5 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-navy-500 focus:ring-3 focus:ring-navy-500/15"
          >
            {opcoes.map((m) => (
              <option key={m.id} value={m.id}>
                {m.nome} {m.cargo === "estagiario" ? "· estagiário(a)" : m.cargo === "socio" ? "· sócio(a)" : ""}
              </option>
            ))}
          </select>
        </>
      )}
      <div className="mt-6 flex justify-end gap-2">
        <button type="button" onClick={onFechar} className="rounded-lg px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100">
          Cancelar
        </button>
        <button
          type="button"
          onClick={() => void confirmar()}
          disabled={enviando || !destino}
          className="inline-flex items-center gap-2 rounded-lg bg-navy-900 px-4 py-2 text-sm font-semibold text-white hover:bg-navy-800 disabled:opacity-50"
        >
          {enviando && <LoaderCircle className="size-4 animate-spin" aria-hidden />} Transferir
        </button>
      </div>
    </dialog>
  );
}

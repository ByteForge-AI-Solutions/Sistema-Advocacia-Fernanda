"use client";

import { useEffect } from "react";
import { CircleCheck, X } from "lucide-react";

/** Aviso de sucesso no canto da tela; some sozinho depois de alguns segundos. */
export function Toast({ mensagem, onFechar }: { mensagem: string; onFechar: () => void }) {
  useEffect(() => {
    const t = setTimeout(onFechar, 4500);
    return () => clearTimeout(t);
  }, [mensagem, onFechar]);

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-6 right-6 z-50 flex max-w-sm items-start gap-3 rounded-xl bg-navy-950 px-4 py-3 text-sm text-white shadow-2xl ring-1 ring-white/10"
    >
      <CircleCheck className="mt-0.5 size-5 shrink-0 text-emerald-400" aria-hidden />
      <p className="flex-1">{mensagem}</p>
      <button
        type="button"
        onClick={onFechar}
        aria-label="Fechar aviso"
        className="-mr-1 flex size-6 items-center justify-center rounded text-navy-200 transition hover:text-white"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

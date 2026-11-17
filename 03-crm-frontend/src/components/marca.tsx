import { Scale } from "lucide-react";

export function Marca({ claro = false }: { claro?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <span
        className={`flex size-11 items-center justify-center rounded-xl ring-1 ${
          claro ? "bg-white/10 text-white ring-white/20" : "bg-navy-900 text-white ring-navy-900"
        }`}
      >
        <Scale className="size-5" aria-hidden />
      </span>
      <div className="leading-tight">
        <p className={`text-base font-semibold ${claro ? "text-white" : "text-navy-950"}`}>
          Dias e Fernandes
        </p>
        <p
          className={`text-[11px] font-medium uppercase tracking-[0.22em] ${
            claro ? "text-navy-200" : "text-slate-500"
          }`}
        >
          Advocacia
        </p>
      </div>
    </div>
  );
}

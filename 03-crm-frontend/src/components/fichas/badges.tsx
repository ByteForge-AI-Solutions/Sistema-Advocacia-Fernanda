import { GraduationCap } from "lucide-react";
import { AREAS_JURIDICAS, isAreaJuridica } from "@/lib/advogados";
import {
  PRIORIDADE_LABEL,
  STATUS_LABEL,
  type Prioridade,
  type StatusAtendimento,
} from "@/lib/fichas";

const base =
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset";

export const PRIORIDADE_ESTILO: Record<Prioridade, { badge: string; ponto: string; faixa: string }> = {
  alta: { badge: "bg-red-50 text-red-700 ring-red-600/20", ponto: "bg-red-500", faixa: "bg-red-500" },
  media: { badge: "bg-amber-50 text-amber-800 ring-amber-600/25", ponto: "bg-amber-500", faixa: "bg-amber-400" },
  baixa: { badge: "bg-emerald-50 text-emerald-700 ring-emerald-600/20", ponto: "bg-emerald-500", faixa: "bg-emerald-500" },
};

export function PrioridadeBadge({ prioridade }: { prioridade: Prioridade | null }) {
  if (!prioridade) {
    return <span className={`${base} bg-slate-50 text-slate-600 ring-slate-500/20`}>Sem prioridade</span>;
  }
  const estilo = PRIORIDADE_ESTILO[prioridade];
  return (
    <span className={`${base} ${estilo.badge}`}>
      <span className={`size-1.5 rounded-full ${estilo.ponto}`} aria-hidden />
      Prioridade {PRIORIDADE_LABEL[prioridade].toLowerCase()}
    </span>
  );
}

export const STATUS_ESTILO: Record<StatusAtendimento, string> = {
  novo: "bg-sky-50 text-sky-700 ring-sky-600/20",
  em_analise: "bg-violet-50 text-violet-700 ring-violet-600/20",
  agendado: "bg-navy-50 text-navy-700 ring-navy-600/20",
  finalizado: "bg-slate-100 text-slate-600 ring-slate-500/20",
};

export function StatusBadge({
  status,
  original,
}: {
  status: StatusAtendimento | null;
  original: string;
}) {
  if (!status) {
    return <span className={`${base} bg-slate-50 text-slate-600 ring-slate-500/20`}>{original}</span>;
  }
  return <span className={`${base} ${STATUS_ESTILO[status]}`}>{STATUS_LABEL[status]}</span>;
}

export function AreaBadge({ area }: { area: string }) {
  return (
    <span className={`${base} bg-white text-slate-700 ring-slate-300`}>
      {isAreaJuridica(area) ? AREAS_JURIDICAS[area] : area}
    </span>
  );
}

export function SupervisaoBadge({ nome }: { nome: string }) {
  return (
    <span className={`${base} bg-navy-900 text-white ring-navy-900`}>
      <GraduationCap className="size-3.5" aria-hidden />
      Sob supervisão - {nome}
    </span>
  );
}

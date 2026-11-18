"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { AREAS_JURIDICAS, isAreaJuridica } from "@/lib/advogados";
import {
  conversaComBot,
  conversaEncerrada,
  estiloStatusConversa,
  formatarTelefoneBr,
  rotuloStatusConversa,
  type Atendimento,
} from "@/lib/atendimentos";

export type FiltroConversa = "todas" | "minhas" | "nao_atribuidas" | "bot" | "encerradas";

const FILTROS: { valor: FiltroConversa; label: string }[] = [
  { valor: "todas", label: "Todas" },
  { valor: "minhas", label: "Minhas" },
  { valor: "nao_atribuidas", label: "Não atribuídas" },
  { valor: "bot", label: "Bot" },
  { valor: "encerradas", label: "Encerradas" },
];

function passaFiltro(a: Atendimento, filtro: FiltroConversa, meuId: string) {
  switch (filtro) {
    case "minhas":
      return a.advogado_id === meuId && !conversaEncerrada(a.status);
    case "nao_atribuidas":
      return a.advogado_id === null && !conversaEncerrada(a.status);
    case "bot":
      return conversaComBot(a.status);
    case "encerradas":
      return conversaEncerrada(a.status);
    default:
      return true;
  }
}

const fmtHoje = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });
const fmtData = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit" });

function quando(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? fmtHoje.format(d) : fmtData.format(d);
}

const PONTO_PRIORIDADE: Record<string, string> = { alta: "bg-red-500", media: "bg-amber-400", baixa: "bg-emerald-500" };

export function ListaConversas({
  itens,
  meuId,
  selecionado,
  onSelecionar,
}: {
  itens: Atendimento[];
  meuId: string;
  selecionado: string | null;
  onSelecionar: (telefone: string) => void;
}) {
  const [filtro, setFiltro] = useState<FiltroConversa>("todas");
  const [busca, setBusca] = useState("");

  const contagem = useMemo(() => {
    const c = {} as Record<FiltroConversa, number>;
    for (const f of FILTROS) c[f.valor] = itens.filter((a) => passaFiltro(a, f.valor, meuId)).length;
    return c;
  }, [itens, meuId]);

  const visiveis = useMemo(() => {
    const termo = busca.trim().toLowerCase();
    const digitos = termo.replace(/\D/g, "");
    return itens.filter((a) => {
      if (!passaFiltro(a, filtro, meuId)) return false;
      if (!termo) return true;
      return (
        (a.nome_cliente ?? "").toLowerCase().includes(termo) ||
        (digitos.length >= 3 && a.telefone.includes(digitos)) ||
        (a.etiquetas ?? []).some((t) => t.includes(termo))
      );
    });
  }, [itens, filtro, busca, meuId]);

  return (
    <section aria-label="Conversas" className="flex min-h-0 flex-col border-slate-200 bg-white lg:border-r">
      <div className="space-y-3 border-b border-slate-200 p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
          <input
            type="search"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Buscar nome, telefone ou etiqueta"
            aria-label="Buscar conversas"
            className="block w-full rounded-lg border border-slate-300 bg-white py-2 pl-9 pr-3 text-sm outline-none transition focus:border-navy-500 focus:ring-3 focus:ring-navy-500/15"
          />
        </div>
        <div role="group" aria-label="Filtrar conversas" className="flex flex-wrap gap-1">
          {FILTROS.map(({ valor, label }) => {
            const ativo = filtro === valor;
            return (
              <button
                key={valor}
                type="button"
                onClick={() => setFiltro(valor)}
                aria-pressed={ativo}
                className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition ${
                  ativo ? "bg-navy-900 text-white" : "text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-50"
                }`}
              >
                {label}
                <span className={`tabular-nums ${ativo ? "text-white/70" : "text-slate-400"}`}>{contagem[valor]}</span>
              </button>
            );
          })}
        </div>
      </div>

      <ul className="min-h-0 flex-1 divide-y divide-slate-100 overflow-y-auto">
        {visiveis.length === 0 && (
          <li className="p-6 text-center text-sm text-slate-500">Nenhuma conversa neste filtro.</li>
        )}
        {visiveis.map((a) => {
          const ativo = a.telefone === selecionado;
          return (
            <li key={a.telefone}>
              <button
                type="button"
                onClick={() => onSelecionar(a.telefone)}
                aria-current={ativo ? "true" : undefined}
                className={`block w-full px-4 py-3 text-left transition ${ativo ? "bg-navy-50" : "hover:bg-slate-50"}`}
              >
                <div className="flex items-center gap-2">
                  <span className={`size-2 shrink-0 rounded-full ${PONTO_PRIORIDADE[a.prioridade] ?? "bg-slate-300"}`} aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900">
                    {a.nome_cliente || formatarTelefoneBr(a.telefone)}
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-slate-400">{quando(a.ultima_msg_cliente_em)}</span>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1">
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${estiloStatusConversa(a.status)}`}>
                    {rotuloStatusConversa(a.status)}
                  </span>
                  <span className="text-[11px] text-slate-500">
                    {a.area && isAreaJuridica(a.area) ? AREAS_JURIDICAS[a.area] : "Área a classificar"}
                  </span>
                  {a.advogado_id === null && !conversaEncerrada(a.status) && (
                    <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800 ring-1 ring-inset ring-amber-600/20">
                      Sem responsável
                    </span>
                  )}
                </div>
                {(a.etiquetas ?? []).length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {(a.etiquetas ?? []).slice(0, 3).map((t) => (
                      <span key={t} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">#{t}</span>
                    ))}
                  </div>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

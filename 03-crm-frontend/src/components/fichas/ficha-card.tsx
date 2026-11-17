"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, Clock, Gavel, Paperclip, Phone, CircleAlert } from "lucide-react";
import type { Ficha } from "@/lib/fichas";
import {
  AreaBadge,
  PRIORIDADE_ESTILO,
  PrioridadeBadge,
  StatusBadge,
  SupervisaoBadge,
} from "@/components/fichas/badges";

const LIMITE_RESUMO = 240;

const formatoData = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const formatoRelativo = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });

function tempoDecorrido(iso: string): string {
  const minutos = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  if (Math.abs(minutos) < 60) return formatoRelativo.format(minutos, "minute");
  const horas = Math.round(minutos / 60);
  if (Math.abs(horas) < 24) return formatoRelativo.format(horas, "hour");
  return formatoRelativo.format(Math.round(horas / 24), "day");
}

/** 5511987654321 → +55 (11) 98765-4321. Outros formatos são exibidos como vieram. */
function formatarTelefone(telefone: string): string {
  const d = telefone.replace(/\D/g, "");
  const m = d.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `+55 (${m[1]}) ${m[2]}-${m[3]}` : telefone;
}

function plural(n: number, singular: string, pluralForm: string) {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

export function FichaCard({ ficha }: { ficha: Ficha }) {
  const [expandido, setExpandido] = useState(false);
  const resumoLongo = ficha.resumo_fatos.length > LIMITE_RESUMO;
  const faixa = ficha.prioridade ? PRIORIDADE_ESTILO[ficha.prioridade].faixa : "bg-slate-300";
  const finalizada = ficha.status === "finalizado";

  return (
    <article
      className={`relative overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition hover:shadow-md ${
        finalizada ? "opacity-75" : ""
      }`}
    >
      <span className={`absolute inset-y-0 left-0 w-1 ${faixa}`} aria-hidden />

      <div className="p-5 pl-6">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold text-slate-900">{ficha.nome_cliente}</h3>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <AreaBadge area={ficha.area_identificada} />
              {ficha.estagiario && <SupervisaoBadge nome={ficha.estagiario.nome} />}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-1.5 sm:justify-end">
            <PrioridadeBadge prioridade={ficha.prioridade} />
            <StatusBadge status={ficha.status} original={ficha.status_original} />
          </div>
        </header>

        {ficha.motivo_prioridade && (
          <p className="mt-4 flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-slate-400" aria-hidden />
            <span>{ficha.motivo_prioridade}</span>
          </p>
        )}

        <div className="mt-4">
          <p
            className={`whitespace-pre-line text-sm leading-relaxed text-slate-600 ${
              resumoLongo && !expandido ? "line-clamp-3" : ""
            }`}
          >
            {ficha.resumo_fatos}
          </p>
          {resumoLongo && (
            <button
              type="button"
              onClick={() => setExpandido((v) => !v)}
              aria-expanded={expandido}
              className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-navy-700 hover:text-navy-900"
            >
              {expandido ? (
                <>
                  Mostrar menos <ChevronUp className="size-3.5" aria-hidden />
                </>
              ) : (
                <>
                  Ler resumo completo <ChevronDown className="size-3.5" aria-hidden />
                </>
              )}
            </button>
          )}
        </div>

        <footer className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-slate-100 pt-4 text-xs text-slate-500">
          <span className="inline-flex items-center gap-1.5" title={formatoData.format(new Date(ficha.created_at))}>
            <Clock className="size-3.5" aria-hidden />
            Chegou {tempoDecorrido(ficha.created_at)} · {formatoData.format(new Date(ficha.created_at))}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Phone className="size-3.5" aria-hidden />
            {formatarTelefone(ficha.telefone)}
          </span>
          {ficha.qtd_documentos > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <Paperclip className="size-3.5" aria-hidden />
              {plural(ficha.qtd_documentos, "documento", "documentos")}
            </span>
          )}
          {ficha.qtd_processos > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <Gavel className="size-3.5" aria-hidden />
              {plural(ficha.qtd_processos, "processo encontrado", "processos encontrados")}
            </span>
          )}
        </footer>
      </div>
    </article>
  );
}

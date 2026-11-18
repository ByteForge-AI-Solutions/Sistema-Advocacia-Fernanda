"use client";

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Gavel } from "lucide-react";
import { AREAS_JURIDICAS, isAreaJuridica } from "@/lib/advogados";
import { eventoCancelado, type EventoAgenda } from "@/lib/agenda";
import { chaveDia, fmtHora } from "@/lib/datas";
import { paraPrioridade } from "@/lib/fichas";
import { urgenciaDoPrazo, type PrazoProcessual } from "@/lib/prazos";

const DIAS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const MAX_POR_DIA = 3;
const fmtMes = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" });
const fmtDiaLongo = new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "numeric", month: "long" });

export function primeiroDiaDoMes(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/** Limites do mês em "YYYY-MM-DD" (para consultar prazos). */
export function limitesDoMes(mes: Date) {
  return { de: chaveDia(primeiroDiaDoMes(mes)), ate: chaveDia(new Date(mes.getFullYear(), mes.getMonth() + 1, 0)) };
}

type ItemDia =
  | { tipo: "prazo"; chave: string; prazo: PrazoProcessual }
  | { tipo: "evento"; chave: string; evento: EventoAgenda };

function rotuloArea(area: string) {
  return isAreaJuridica(area) ? AREAS_JURIDICAS[area] : area;
}

function ItemCalendario({
item,
compacto,
agora,
onAbrirEvento,
onAbrirPrazo,
}: {
item: ItemDia;
compacto: boolean;
agora: Date;
onAbrirEvento: (e: EventoAgenda) => void;
onAbrirPrazo: (p: PrazoProcessual) => void;
}) {
  if (item.tipo === "prazo") {
    const p = item.prazo;
    const u = urgenciaDoPrazo(p, agora);
    return (
      <button
        type="button"
        onClick={() => onAbrirPrazo(p)}
        title={`Prazo fatal: ${p.descricao_prazo} — ${p.numero_cnj}`}
        className={`flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-left text-[11px] font-semibold transition ${
          u === "vencido" || u === "hoje" || u === "urgente"
            ? "bg-red-600 text-white hover:bg-red-700"
            : "bg-red-50 text-red-800 ring-1 ring-inset ring-red-200 hover:bg-red-100"
        }`}
      >
        <Gavel className="size-3 shrink-0" aria-hidden />
        <span className="truncate">
          {compacto ? "Prazo: " : "Prazo fatal: "}
          {p.descricao_prazo}
          {!compacto && p.ficha ? ` · ${p.ficha.nome_cliente}` : ""}
        </span>
      </button>
    );
  }
  const e = item.evento;
  const cancelado = eventoCancelado(e.status);
  const alta = paraPrioridade(e.prioridade) === "alta";
  return (
    <button
      type="button"
      onClick={() => onAbrirEvento(e)}
      title={`${fmtHora.format(new Date(e.data_hora_inicio))} ${e.titulo_evento}${e.ficha ? ` — ${e.ficha.nome_cliente}` : ""} (${rotuloArea(e.area_juridica)})`}
      className={`block w-full rounded px-1.5 py-0.5 text-left text-[11px] transition hover:bg-navy-100 ${
        cancelado ? "text-slate-400 line-through" : "text-slate-800"
      } ${alta && !cancelado ? "bg-white ring-1 ring-inset ring-red-300" : "bg-navy-50"}`}
    >
      <span className="font-semibold tabular-nums text-navy-800">{fmtHora.format(new Date(e.data_hora_inicio))}</span>{" "}
      <span>{e.ficha?.nome_cliente ?? e.titulo_evento}</span>
      {!compacto && <span className="text-slate-500"> · {rotuloArea(e.area_juridica)}</span>}
      {!compacto && e.estagiario && <span className="text-slate-500"> · {e.estagiario.nome.split(" ")[0]}</span>}
    </button>
  );
}

/**
 * Grade mensal (dia 1 ao último dia). Prazos fatais aparecem primeiro, em vermelho;
 * compromissos de prioridade alta têm borda vermelha. Clique no dia para ver tudo.
 */
export function CalendarioMensal({
  mes,
  eventos,
  prazos,
  feriados,
  agora,
  onMudarMes,
  onAbrirEvento,
  onAbrirPrazo,
}: {
  mes: Date;
  eventos: EventoAgenda[];
  prazos: PrazoProcessual[];
  feriados: Set<string>;
  agora: Date;
  onMudarMes: (mes: Date) => void;
  onAbrirEvento: (e: EventoAgenda) => void;
  onAbrirPrazo: (p: PrazoProcessual) => void;
}) {
  const [diaAberto, setDiaAberto] = useState<string | null>(null);

  const porDia = useMemo(() => {
    const mapa = new Map<string, ItemDia[]>();
    const add = (k: string, item: ItemDia) => mapa.set(k, [...(mapa.get(k) ?? []), item]);
    for (const p of prazos) add(p.data_fatal.slice(0, 10), { tipo: "prazo", chave: `p${p.id}`, prazo: p });
    for (const e of eventos) add(chaveDia(new Date(e.data_hora_inicio)), { tipo: "evento", chave: `e${e.id}`, evento: e });
    for (const lista of mapa.values()) {
      lista.sort((a, b) => {
        if (a.tipo !== b.tipo) return a.tipo === "prazo" ? -1 : 1;
        if (a.tipo === "evento" && b.tipo === "evento") {
          return new Date(a.evento.data_hora_inicio).getTime() - new Date(b.evento.data_hora_inicio).getTime();
        }
        return 0;
      });
    }
    return mapa;
  }, [eventos, prazos]);

  const celulas = useMemo(() => {
    const inicio = primeiroDiaDoMes(mes);
    const total = new Date(mes.getFullYear(), mes.getMonth() + 1, 0).getDate();
    const vazias = inicio.getDay();
    const lista: (Date | null)[] = Array.from({ length: vazias }, () => null);
    for (let d = 1; d <= total; d++) lista.push(new Date(mes.getFullYear(), mes.getMonth(), d));
    while (lista.length % 7 !== 0) lista.push(null);
    return lista;
  }, [mes]);

  const hoje = chaveDia(agora);
  const itensAbertos = diaAberto ? (porDia.get(diaAberto) ?? []) : [];

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold capitalize text-navy-950">{fmtMes.format(mes)}</h2>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onMudarMes(new Date(mes.getFullYear(), mes.getMonth() - 1, 1))}
            aria-label="Mês anterior"
            className="rounded-lg p-2 text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-white"
          >
            <ChevronLeft className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => onMudarMes(primeiroDiaDoMes(agora))}
            className="rounded-lg px-3 py-2 text-sm font-medium text-slate-700 ring-1 ring-inset ring-slate-200 hover:bg-white"
          >
            Hoje
          </button>
          <button
            type="button"
            onClick={() => onMudarMes(new Date(mes.getFullYear(), mes.getMonth() + 1, 1))}
            aria-label="Próximo mês"
            className="rounded-lg p-2 text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-white"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="grid min-w-[720px] grid-cols-7">
          {DIAS.map((d) => (
            <div key={d} className="border-b border-slate-200 bg-slate-50 px-2 py-2 text-center text-xs font-semibold uppercase tracking-wide text-slate-500">
              {d}
            </div>
          ))}
          {celulas.map((dia, i) => {
            if (!dia) return <div key={`v${i}`} className="min-h-28 border-b border-r border-slate-100 bg-slate-50/60" aria-hidden />;
            const chave = chaveDia(dia);
            const itens = porDia.get(chave) ?? [];
            const feriado = feriados.has(chave);
            const ehHoje = chave === hoje;
            const fimDeSemana = dia.getDay() === 0 || dia.getDay() === 6;
            return (
              <div
                key={chave}
                className={`min-h-28 border-b border-r border-slate-100 p-1.5 ${fimDeSemana || feriado ? "bg-slate-50/70" : ""} ${
                  diaAberto === chave ? "ring-2 ring-inset ring-navy-500" : ""
                }`}
              >
                <button
                  type="button"
                  onClick={() => setDiaAberto(diaAberto === chave ? null : chave)}
                  aria-label={`${fmtDiaLongo.format(dia)}: ${itens.length} item(ns)`}
                  className="mb-1 flex w-full items-center justify-between rounded px-1 text-left hover:bg-slate-100"
                >
                  <span
                    className={`flex size-6 items-center justify-center rounded-full text-xs font-semibold tabular-nums ${
                      ehHoje ? "bg-navy-900 text-white" : "text-slate-700"
                    }`}
                  >
                    {dia.getDate()}
                  </span>
                  {feriado && <span className="text-[10px] font-medium text-slate-400">feriado</span>}
                </button>
                <div className="space-y-0.5">
                  {itens.slice(0, MAX_POR_DIA).map((it) => (
                    <ItemCalendario key={it.chave} item={it} compacto agora={agora} onAbrirEvento={onAbrirEvento} onAbrirPrazo={onAbrirPrazo} />
                  ))}
                  {itens.length > MAX_POR_DIA && (
                    <button
                      type="button"
                      onClick={() => setDiaAberto(chave)}
                      className="w-full rounded px-1.5 text-left text-[11px] font-medium text-navy-700 hover:underline"
                    >
                      +{itens.length - MAX_POR_DIA} mais
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-slate-500">
        <span className="inline-flex items-center gap-1.5"><span className="size-3 rounded bg-red-600" /> Prazo fatal urgente/vencido</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-3 rounded bg-red-50 ring-1 ring-red-200" /> Prazo fatal</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-3 rounded bg-white ring-1 ring-red-300" /> Reunião prioridade alta</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-3 rounded bg-navy-50" /> Reunião</span>
      </div>

      {diaAberto && (
        <section aria-label="Compromissos do dia" className="mt-5 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="text-sm font-semibold capitalize text-slate-800">{fmtDiaLongo.format(new Date(`${diaAberto}T12:00:00`))}</h3>
          {itensAbertos.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">Nada agendado neste dia.</p>
          ) : (
            <div className="mt-3 space-y-1.5">
              {itensAbertos.map((it) => (
                <ItemCalendario key={it.chave} item={it} compacto={false} agora={agora} onAbrirEvento={onAbrirEvento} onAbrirPrazo={onAbrirPrazo} />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

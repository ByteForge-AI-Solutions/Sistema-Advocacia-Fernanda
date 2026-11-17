"use client";

import { useEffect, useMemo, useState } from "react";
import { CalendarDays, CalendarX, CircleAlert, Clock, LoaderCircle, RefreshCw } from "lucide-react";
import { useAuth } from "@/components/auth-provider";
import { AreaBadge, PRIORIDADE_ESTILO, PrioridadeBadge, SupervisaoBadge } from "@/components/fichas/badges";
import {
  ErroAgenda,
  buscarAgenda,
  eventoCancelado,
  rotuloStatusEvento,
  type EventoAgenda,
} from "@/lib/agenda";
import { paraPrioridade } from "@/lib/fichas";

type Periodo = "proximos" | "todos";

const fmtHora = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });
const fmtDia = new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "numeric", month: "long" });
const fmtDiaAno = new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const fmtDataCurta = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit" });

/** Chave do dia no fuso local (YYYY-MM-DD), para agrupar eventos. */
function chaveDia(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function rotuloDia(d: Date, agora: Date) {
  const amanha = new Date(agora);
  amanha.setDate(agora.getDate() + 1);
  const texto = d.getFullYear() === agora.getFullYear() ? fmtDia.format(d) : fmtDiaAno.format(d);
  if (chaveDia(d) === chaveDia(agora)) return { destaque: "Hoje", texto };
  if (chaveDia(d) === chaveDia(amanha)) return { destaque: "Amanhã", texto };
  return { destaque: null, texto };
}

function duracao(inicio: Date, fim: Date) {
  const min = Math.round((fim.getTime() - inicio.getTime()) / 60000);
  if (min <= 0) return null;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h === 0 ? `${m} min` : m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, "0")}`;
}

function terminoDoEvento(e: EventoAgenda) {
  return new Date(e.data_hora_fim ?? e.data_hora_inicio);
}

function EventoCard({ evento, agora }: { evento: EventoAgenda; agora: Date }) {
  const prioridade = paraPrioridade(evento.prioridade);
  const alta = prioridade === "alta";
  const cancelado = eventoCancelado(evento.status);
  const inicio = new Date(evento.data_hora_inicio);
  const fim = evento.data_hora_fim ? new Date(evento.data_hora_fim) : null;
  const passado = terminoDoEvento(evento) < agora;
  const acontecendo = !cancelado && inicio <= agora && fim !== null && fim > agora;
  const fimEmOutroDia = fim && chaveDia(fim) !== chaveDia(inicio);
  const dur = fim ? duracao(inicio, fim) : null;

  return (
    <article
      className={`relative flex h-full flex-col overflow-hidden rounded-xl border bg-white p-5 pl-6 shadow-sm transition hover:shadow-md ${
        alta && !cancelado ? "border-red-300 ring-1 ring-red-200" : "border-slate-200"
      } ${passado || cancelado ? "opacity-70" : ""}`}
    >
      <span
        className={`absolute inset-y-0 left-0 w-1 ${prioridade ? PRIORIDADE_ESTILO[prioridade].faixa : "bg-slate-300"}`}
        aria-hidden
      />

      <div className="flex items-start justify-between gap-3">
        <p className="flex items-center gap-1.5 text-sm font-semibold tabular-nums text-navy-900">
          <Clock className="size-4 text-navy-400" aria-hidden />
          <time dateTime={evento.data_hora_inicio}>{fmtHora.format(inicio)}</time>
          {fim && (
            <>
              <span className="text-slate-400">–</span>
              <time dateTime={evento.data_hora_fim ?? undefined}>
                {fimEmOutroDia ? `${fmtDataCurta.format(fim)} ${fmtHora.format(fim)}` : fmtHora.format(fim)}
              </time>
            </>
          )}
        </p>
        {acontecendo ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-navy-900 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-white">
            <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" aria-hidden />
            Agora
          </span>
        ) : (
          dur && <span className="text-xs text-slate-400">{dur}</span>
        )}
      </div>

      <h3
        className={`mt-3 text-base font-semibold leading-snug text-slate-900 ${cancelado ? "line-through decoration-slate-400" : ""}`}
      >
        {evento.titulo_evento}
      </h3>

      {evento.estagiario && (
        <div className="mt-2">
          <SupervisaoBadge nome={evento.estagiario.nome} />
        </div>
      )}

      <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-4">
        <AreaBadge area={evento.area_juridica} />
        <PrioridadeBadge prioridade={prioridade} />
        <span
          className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${
            cancelado ? "bg-slate-100 text-slate-500 ring-slate-300" : "bg-sky-50 text-sky-700 ring-sky-600/20"
          }`}
        >
          {rotuloStatusEvento(evento.status)}
        </span>
      </div>
    </article>
  );
}

export default function AgendaPage() {
  // O layout de /painel só renderiza esta página com o perfil já carregado.
  const { perfil } = useAuth();
  const [eventos, setEventos] = useState<EventoAgenda[]>([]);
  const [agora, setAgora] = useState<Date | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [periodo, setPeriodo] = useState<Periodo>("proximos");
  const [versao, setVersao] = useState(0);

  useEffect(() => {
    if (!perfil) return;
    let atual = true;
    buscarAgenda(perfil).then(
      (dados) => {
        if (!atual) return;
        setEventos(dados);
        setAgora(new Date());
        setErro(null);
        setCarregando(false);
      },
      (e: unknown) => {
        if (!atual) return;
        console.error("Erro ao carregar agenda:", e);
        setErro(
          e instanceof ErroAgenda && e.tabelaAusente
            ? "A tabela agenda_advogados ainda não existe no Supabase (ou não está exposta na API)."
            : "Não foi possível carregar a agenda. Verifique sua conexão e tente novamente.",
        );
        setCarregando(false);
      },
    );
    return () => {
      atual = false;
    };
  }, [perfil, versao]);

  function atualizar() {
    setCarregando(true);
    setVersao((v) => v + 1);
  }

  const proximos = useMemo(
    () => (agora ? eventos.filter((e) => terminoDoEvento(e) >= agora) : []),
    [eventos, agora],
  );

  // Já vem ordenado por data_hora_inicio (crescente) do banco; aqui só agrupamos por dia.
  const grupos = useMemo(() => {
    const lista = periodo === "proximos" ? proximos : eventos;
    const mapa = new Map<string, { dia: Date; itens: EventoAgenda[] }>();
    for (const e of lista) {
      const inicio = new Date(e.data_hora_inicio);
      const chave = chaveDia(inicio);
      if (!mapa.has(chave)) mapa.set(chave, { dia: inicio, itens: [] });
      mapa.get(chave)!.itens.push(e);
    }
    return [...mapa.entries()];
  }, [periodo, proximos, eventos]);

  const opcoes: { valor: Periodo; label: string; qtd: number }[] = [
    { valor: "proximos", label: "Próximos", qtd: proximos.length },
    { valor: "todos", label: "Todos", qtd: eventos.length },
  ];

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2.5 text-2xl font-semibold tracking-tight text-navy-950">
            <CalendarDays className="size-6 text-navy-700" aria-hidden />
            Agenda de reuniões
          </h1>
          <p className="mt-1 text-sm text-slate-500">Compromissos em ordem cronológica.</p>
        </div>

        <div className="flex items-center gap-2">
          <div role="group" aria-label="Período" className="flex gap-1.5">
            {opcoes.map(({ valor, label, qtd }) => {
              const ativo = periodo === valor;
              return (
                <button
                  key={valor}
                  type="button"
                  onClick={() => setPeriodo(valor)}
                  aria-pressed={ativo}
                  className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition ${
                    ativo
                      ? "bg-navy-900 text-white shadow-sm"
                      : "bg-white text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-50 hover:text-slate-900"
                  }`}
                >
                  {label}
                  <span
                    className={`rounded-full px-1.5 text-xs tabular-nums ${ativo ? "bg-white/15 text-white" : "bg-slate-100 text-slate-500"}`}
                  >
                    {carregando ? "–" : qtd}
                  </span>
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={atualizar}
            disabled={carregando}
            aria-label="Atualizar agenda"
            className="flex size-9 items-center justify-center rounded-lg text-slate-500 ring-1 ring-inset ring-slate-200 transition hover:bg-white hover:text-slate-900 disabled:opacity-60"
          >
            <RefreshCw className={`size-4 ${carregando ? "animate-spin" : ""}`} aria-hidden />
          </button>
        </div>
      </div>

      <section aria-label="Eventos da agenda" aria-busy={carregando} className="mt-8">
        {carregando && eventos.length === 0 ? (
          <div className="flex items-center justify-center py-24" role="status">
            <LoaderCircle className="size-6 animate-spin text-navy-700" aria-hidden />
            <span className="sr-only">Carregando agenda…</span>
          </div>
        ) : erro ? (
          <div role="alert" className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800">
            <CircleAlert className="mt-0.5 size-5 shrink-0" aria-hidden />
            <div>
              <p>{erro}</p>
              <button type="button" onClick={atualizar} className="mt-2 font-medium underline underline-offset-2">
                Tentar novamente
              </button>
            </div>
          </div>
        ) : grupos.length === 0 || !agora ? (
          <div className="flex flex-col items-center rounded-xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center">
            <CalendarX className="size-8 text-slate-300" aria-hidden />
            <p className="mt-3 text-sm font-medium text-slate-700">
              {periodo === "proximos" && eventos.length > 0
                ? "Nenhum compromisso pela frente"
                : "Nenhum compromisso na agenda"}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {periodo === "proximos" && eventos.length > 0
                ? "Os compromissos anteriores continuam disponíveis em “Todos”."
                : "As reuniões agendadas aparecerão aqui."}
            </p>
          </div>
        ) : (
          <div className="space-y-10">
            {grupos.map(([chave, { dia, itens }]) => {
              const { destaque, texto } = rotuloDia(dia, agora);
              return (
                <section key={chave} aria-labelledby={`dia-${chave}`}>
                  <h2 id={`dia-${chave}`} className="flex items-baseline gap-2 border-b border-slate-200 pb-2">
                    {destaque && <span className="text-sm font-semibold text-navy-800">{destaque}</span>}
                    <span className={`text-sm capitalize ${destaque ? "text-slate-500" : "font-semibold text-slate-700"}`}>
                      {texto}
                    </span>
                    <span className="ml-auto text-xs tabular-nums text-slate-400">
                      {itens.length} {itens.length === 1 ? "compromisso" : "compromissos"}
                    </span>
                  </h2>
                  <ul className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                    {itens.map((evento) => (
                      <li key={evento.id}>
                        <EventoCard evento={evento} agora={agora} />
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}

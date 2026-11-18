"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CalendarDays,
  CalendarRange,
  CalendarX,
  CircleAlert,
  Clock,
  List,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  UserRound,
} from "lucide-react";
import { CalendarioMensal, limitesDoMes, primeiroDiaDoMes } from "@/components/agenda/calendario-mensal";
import { ReuniaoModal } from "@/components/agenda/reuniao-modal";
import { buscarFeriados, buscarPrazosPeriodo, type PrazoProcessual } from "@/lib/prazos";
import { useAuth } from "@/components/auth-provider";
import { AreaBadge, PRIORIDADE_ESTILO, PrioridadeBadge, VinculoBadge } from "@/components/fichas/badges";
import { Toast } from "@/components/toast";
import { rotuloMembro, type MembroEquipe } from "@/lib/advogados";
import {
  ErroAgenda,
  buscarAgenda,
  eventoCancelado,
  rotuloStatusEvento,
  terminoDoEvento,
  type EventoAgenda,
} from "@/lib/agenda";
import { chaveDia, fmtHora } from "@/lib/datas";
import { paraPrioridade } from "@/lib/fichas";

type Periodo = "proximos" | "todos";
type Visao = "mes" | "lista";
type EstadoModal = { modo: "novo" } | { modo: "editar"; evento: EventoAgenda } | null;

const fmtDia = new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "numeric", month: "long" });
const fmtDiaAno = new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const fmtDataCurta = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit" });

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

function EventoCard({
  evento,
  agora,
  onEditar,
}: {
  evento: EventoAgenda;
  agora: Date;
  onEditar: () => void;
}) {
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
      className={`group relative flex h-full flex-col overflow-hidden rounded-xl border bg-white p-5 pl-6 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-navy-600 ${
        alta && !cancelado ? "border-red-300 ring-1 ring-red-200" : "border-slate-200"
      } ${passado || cancelado ? "opacity-70 hover:opacity-100" : ""}`}
    >
      {/* Botão sobre o cartão inteiro: clique em qualquer lugar abre a edição */}
      <button
        type="button"
        onClick={onEditar}
        aria-label={`Editar reunião: ${evento.titulo_evento}`}
        className="absolute inset-0 z-10 cursor-pointer outline-none"
      />
      <Pencil
        className="absolute right-3 bottom-3 size-3.5 text-slate-300 opacity-0 transition group-hover:opacity-100 group-has-focus-visible:opacity-100"
        aria-hidden
      />
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

      {evento.ficha && (
        <p className="mt-1.5 flex items-center gap-1.5 text-sm text-slate-600">
          <UserRound className="size-3.5 shrink-0 text-slate-400" aria-hidden />
          <span className="truncate">{evento.ficha.nome_cliente}</span>
        </p>
      )}

      {evento.responsavel && (
        <div className="mt-2">
          <VinculoBadge estagiario={evento.estagiario} responsavel={evento.responsavel} />
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
  const [responsaveis, setResponsaveis] = useState<MembroEquipe[]>([]);
  const [modal, setModal] = useState<EstadoModal>(null);
  const [sucesso, setSucesso] = useState<string | null>(null);
  const fecharToast = useCallback(() => setSucesso(null), []);
  const [agora, setAgora] = useState<Date | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [periodo, setPeriodo] = useState<Periodo>("proximos");
  const [versao, setVersao] = useState(0);
  const router = useRouter();
  const [visao, setVisao] = useState<Visao>("mes");
  const [filtroResponsavel, setFiltroResponsavel] = useState<string>("todos");
  const [mes, setMes] = useState<Date>(() => primeiroDiaDoMes(new Date()));
  const [prazosMes, setPrazosMes] = useState<PrazoProcessual[]>([]);
  const [feriados, setFeriados] = useState<Set<string>>(new Set());

  useEffect(() => {
    let atual = true;
    buscarFeriados().then((f) => atual && setFeriados(f));
    return () => {
      atual = false;
    };
  }, []);

  // Prazos fatais do mês visível (dos responsáveis que o usuário pode ver).
  useEffect(() => {
    if (responsaveis.length === 0) return;
    let atual = true;
    const { de, ate } = limitesDoMes(mes);
    buscarPrazosPeriodo(
      responsaveis.map((r) => r.id),
      de,
      ate,
    ).then((p) => atual && setPrazosMes(p));
    return () => {
      atual = false;
    };
  }, [mes, responsaveis, versao]);

  useEffect(() => {
    if (!perfil) return;
    let atual = true;
    buscarAgenda(perfil).then(
      (dados) => {
        if (!atual) return;
        setEventos(dados.eventos);
        setResponsaveis(dados.responsaveis);
        setAgora(new Date());
        setErro(null);
        setCarregando(false);
      },
      (e: unknown) => {
        if (!atual) return;
        console.error("Erro ao carregar agenda:", e);
        setErro(
          e instanceof ErroAgenda && e.motivo === "tabela_ausente"
            ? "A tabela agenda_advogados ainda não existe no Supabase. Rode as seções 5, 6 e 7 do schema.sql."
            : e instanceof ErroAgenda && e.motivo === "banco_desatualizado"
              ? "O banco ainda não tem a coluna ficha_id da agenda. Rode a seção 7 do schema.sql."
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

  function aoSalvar(mensagem: string) {
    setModal(null);
    setSucesso(mensagem);
    atualizar();
  }

  const podeAgendar = !carregando && !erro && responsaveis.length > 0;

  // Filtro por advogado: o titular vê a própria agenda e a dos estagiários que supervisiona.
  const eventosFiltrados = useMemo(
    () => (filtroResponsavel === "todos" ? eventos : eventos.filter((e) => e.advogado_id === filtroResponsavel)),
    [eventos, filtroResponsavel],
  );
  const prazosFiltrados = useMemo(
    () => (filtroResponsavel === "todos" ? prazosMes : prazosMes.filter((p) => p.advogado_id === filtroResponsavel)),
    [prazosMes, filtroResponsavel],
  );

  const proximos = useMemo(
    () => (agora ? eventosFiltrados.filter((e) => terminoDoEvento(e) >= agora) : []),
    [eventosFiltrados, agora],
  );

  // Já vem ordenado por data_hora_inicio (crescente) do banco; aqui só agrupamos por dia.
  const grupos = useMemo(() => {
    const lista = periodo === "proximos" ? proximos : eventosFiltrados;
    const mapa = new Map<string, { dia: Date; itens: EventoAgenda[] }>();
    for (const e of lista) {
      const inicio = new Date(e.data_hora_inicio);
      const chave = chaveDia(inicio);
      if (!mapa.has(chave)) mapa.set(chave, { dia: inicio, itens: [] });
      mapa.get(chave)!.itens.push(e);
    }
    return [...mapa.entries()];
  }, [periodo, proximos, eventosFiltrados]);

  const opcoes: { valor: Periodo; label: string; qtd: number }[] = [
    { valor: "proximos", label: "Próximos", qtd: proximos.length },
    { valor: "todos", label: "Todos", qtd: eventosFiltrados.length },
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

        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="Visualização" className="flex rounded-lg bg-white p-0.5 ring-1 ring-inset ring-slate-200">
            {(
              [
                { valor: "mes", label: "Mês", icone: CalendarRange },
                { valor: "lista", label: "Lista", icone: List },
              ] as const
            ).map(({ valor, label, icone: Icone }) => (
              <button
                key={valor}
                type="button"
                onClick={() => setVisao(valor)}
                aria-pressed={visao === valor}
                className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition ${
                  visao === valor ? "bg-navy-900 text-white" : "text-slate-600 hover:text-slate-900"
                }`}
              >
                <Icone className="size-4" aria-hidden />
                {label}
              </button>
            ))}
          </div>
          {responsaveis.length > 1 && (
            <select
              value={filtroResponsavel}
              onChange={(e) => setFiltroResponsavel(e.target.value)}
              aria-label="Filtrar por advogado"
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-navy-500"
            >
              <option value="todos">{perfil?.cargo === "socio" ? "Todo o escritório" : "Toda a equipe"}</option>
              {responsaveis.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.id === perfil?.id ? "Minha agenda" : perfil ? rotuloMembro(r, perfil.id) : r.nome}
                </option>
              ))}
            </select>
          )}
          {visao === "lista" && (
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
          )}
          <button
            type="button"
            onClick={atualizar}
            disabled={carregando}
            aria-label="Atualizar agenda"
            className="flex size-9 items-center justify-center rounded-lg text-slate-500 ring-1 ring-inset ring-slate-200 transition hover:bg-white hover:text-slate-900 disabled:opacity-60"
          >
            <RefreshCw className={`size-4 ${carregando ? "animate-spin" : ""}`} aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => setModal({ modo: "novo" })}
            disabled={!podeAgendar}
            className="inline-flex items-center gap-2 rounded-lg bg-navy-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-navy-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Plus className="size-4" aria-hidden />
            Nova reunião
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
        ) : visao === "mes" && agora ? (
          <CalendarioMensal
            mes={mes}
            eventos={eventosFiltrados}
            prazos={prazosFiltrados}
            feriados={feriados}
            agora={agora}
            onMudarMes={setMes}
            onAbrirEvento={(evento) => setModal({ modo: "editar", evento })}
            onAbrirPrazo={() => router.push("/painel/processos")}
          />
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
            {podeAgendar && (
              <button
                type="button"
                onClick={() => setModal({ modo: "novo" })}
                className="mt-5 inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-navy-800 ring-1 ring-inset ring-navy-200 transition hover:bg-navy-50"
              >
                <Plus className="size-4" aria-hidden />
                Agendar reunião
              </button>
            )}
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
                        <EventoCard
                          evento={evento}
                          agora={agora}
                          onEditar={() => setModal({ modo: "editar", evento })}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </section>

      {modal && perfil && (
        <ReuniaoModal
          perfil={perfil}
          responsaveis={responsaveis}
          eventos={eventos}
          evento={modal.modo === "editar" ? modal.evento : undefined}
          onFechar={() => setModal(null)}
          onSalvo={aoSalvar}
        />
      )}
      {sucesso && <Toast mensagem={sucesso} onFechar={fecharToast} />}
    </main>
  );
}

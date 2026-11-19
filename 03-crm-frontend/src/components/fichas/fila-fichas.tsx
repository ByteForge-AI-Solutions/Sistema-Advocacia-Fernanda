"use client";

import { useEffect, useMemo, useState } from "react";
import { CalendarClock, CircleAlert, Inbox, ListFilter, LoaderCircle, RefreshCw, UsersRound, Workflow } from "lucide-react";
import { TEMPERATURAS, TEMPERATURA_INFO, situacaoProximaAcao, type SituacaoAcao } from "@/lib/leads";
import { buscarEquipeVisivel, ehSocio, ehTitular, rotuloMembro, type Advogado, type MembroEquipe } from "@/lib/advogados";
import {
  PRIORIDADES,
  PRIORIDADE_LABEL,
  STATUS_ATENDIMENTO,
  STATUS_LABEL,
  buscarFichas,
  nivelAtendimento,
  type Ficha,
  type StatusAtendimento,
} from "@/lib/fichas";
import {
  ETAPAS,
  ETAPA_INFO,
  carregarFollowup,
  estadoCadencia,
  etapaAtiva,
  montarTarefas,
  type ContatoLead,
  type EstadoCadencia,
  type EtapaFunil,
  type ToqueRegistrado,
} from "@/lib/funil";
import { PRIORIDADE_ESTILO } from "@/components/fichas/badges";
import { FichaCard } from "@/components/fichas/ficha-card";
import { TarefasDoDia } from "@/components/fichas/tarefas-do-dia";

type Filtro = "todos" | StatusAtendimento;
/** Filtro do funil (migração v6): todas, só as ativas ou uma etapa. */
type FiltroEtapa = "todas" | "ativas" | EtapaFunil;
/** "todos", "sem" (sem responsável) ou o id de um membro da equipe. */
type FiltroResponsavel = string;
/** Tarefas do dia (seção 7 do documento de leads). */
type FiltroAcao = "todas" | Exclude<SituacaoAcao, "futura">;
const FILTROS_ACAO: { valor: FiltroAcao; label: string }[] = [
  { valor: "todas", label: "Todas" },
  { valor: "vencida", label: "Vencidas" },
  { valor: "hoje", label: "Hoje" },
  { valor: "sem", label: "Sem próxima ação" },
];

interface DadosFollowup {
  toques: ToqueRegistrado[];
  contatos: Map<string, ContatoLead>;
}
const SEM_FOLLOWUP: DadosFollowup = { toques: [], contatos: new Map() };

/** Lead ativo: com a v6, pela etapa; sem ela, pelo status antigo. */
const leadAtivo = (f: Ficha) => (f.funil.disponivel ? etapaAtiva(f.funil.etapa) : f.status_original.trim().toLowerCase() !== "finalizado");

export function FilaFichas({ perfil }: { perfil: Advogado }) {
  const [fichas, setFichas] = useState<Ficha[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [filtro, setFiltro] = useState<Filtro>("todos");
  const [filtroEtapa, setFiltroEtapa] = useState<FiltroEtapa>("todas");
  const [versao, setVersao] = useState(0);
  const [equipe, setEquipe] = useState<MembroEquipe[]>([]);
  const [responsavel, setResponsavel] = useState<FiltroResponsavel>("todos");
  const [filtroAcao, setFiltroAcao] = useState<FiltroAcao>("todas");
  const [followup, setFollowup] = useState<DadosFollowup>(SEM_FOLLOWUP);
  // Momento da última carga: base estável para "vencida/hoje" durante a renderização.
  const [carregadoEm, setCarregadoEm] = useState<Date | null>(null);

  useEffect(() => {
    let atual = true; // descarta respostas de requisições antigas
    Promise.all([buscarFichas(perfil), buscarEquipeVisivel(perfil)])
      .then(async ([dados, membros]) => {
        // Toques e últimas mensagens só fazem sentido com o funil (v6) no banco.
        const fu = dados.some((f) => f.funil.disponivel) ? await carregarFollowup(dados.map((f) => f.id)) : SEM_FOLLOWUP;
        return [dados, membros, fu] as const;
      })
      .then(
        ([dados, membros, fu]) => {
          if (!atual) return;
          setFichas(dados);
          setEquipe(membros);
          setFollowup(fu);
          setCarregadoEm(new Date());
          setErro(null);
          setCarregando(false);
        },
        (e: unknown) => {
          if (!atual) return;
          console.error("Erro ao carregar fichas:", e);
          setErro("Não foi possível carregar as fichas. Verifique sua conexão e tente novamente.");
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

  const funilDisponivel = fichas.some((f) => f.funil.disponivel);
  const leadDisponivel = fichas.some((f) => f.lead.disponivel);

  // Filtro por responsável (sócio: qualquer pessoa do escritório; titular: ele e os estagiários).
  const doResponsavel = useMemo(() => {
    if (responsavel === "todos") return fichas;
    if (responsavel === "sem") return fichas.filter((f) => f.advogado_id === null);
    return fichas.filter((f) => f.advogado_id === responsavel);
  }, [fichas, responsavel]);
  const qtdSemResponsavel = useMemo(() => fichas.filter((f) => f.advogado_id === null).length, [fichas]);
  const mostrarFiltroResponsavel = equipe.length > 1 || qtdSemResponsavel > 0;

  const estados = useMemo(() => {
    const m = new Map<string, EstadoCadencia>();
    if (!carregadoEm) return m;
    for (const f of fichas) {
      m.set(f.id, estadoCadencia({ funil: f.funil, temperatura: f.lead.temperatura }, followup.toques, followup.contatos.get(f.id), carregadoEm));
    }
    return m;
  }, [fichas, followup, carregadoEm]);

  const tarefas = useMemo(
    () => (carregadoEm ? montarTarefas(doResponsavel, estados, carregadoEm, (f) => nivelAtendimento(f as Ficha)) : []),
    [doResponsavel, estados, carregadoEm],
  );

  const situacoes = useMemo(() => {
    const m = new Map<string, SituacaoAcao | null>();
    for (const f of fichas) {
      m.set(f.id, f.lead.disponivel && carregadoEm ? situacaoProximaAcao({ proxima_acao_em: f.lead.proxima_acao_em, ativo: leadAtivo(f) }, carregadoEm) : null);
    }
    return m;
  }, [fichas, carregadoEm]);
  const contagemAcao = useMemo(() => {
    const c: Record<FiltroAcao, number> = { todas: doResponsavel.length, vencida: 0, hoje: 0, sem: 0 };
    for (const f of doResponsavel) {
      const s = situacoes.get(f.id);
      if (s === "vencida" || s === "hoje" || s === "sem") c[s]++;
    }
    return c;
  }, [doResponsavel, situacoes]);

  const contagemStatus = useMemo(() => {
    const c: Record<Filtro, number> = { todos: doResponsavel.length, novo: 0, em_analise: 0, agendado: 0, finalizado: 0 };
    for (const f of doResponsavel) if (f.status) c[f.status]++;
    return c;
  }, [doResponsavel]);

  const contagemEtapa = useMemo(() => {
    const c = { todas: doResponsavel.length, ativas: 0 } as Record<FiltroEtapa, number>;
    for (const e of ETAPAS) c[e] = 0;
    for (const f of doResponsavel) {
      c[f.funil.etapa]++;
      if (etapaAtiva(f.funil.etapa)) c.ativas++;
    }
    return c;
  }, [doResponsavel]);

  const abertasPorPrioridade = useMemo(() => {
    const c = { alta: 0, media: 0, baixa: 0 };
    for (const f of doResponsavel) if (leadAtivo(f) && f.prioridade) c[f.prioridade]++;
    return c;
  }, [doResponsavel]);

  const qtdSupervisao = useMemo(() => fichas.filter((f) => f.estagiario).length, [fichas]);

  const visiveis = useMemo(() => {
    let base = filtroAcao === "todas" ? doResponsavel : doResponsavel.filter((f) => situacoes.get(f.id) === filtroAcao);
    if (funilDisponivel) {
      if (filtroEtapa === "ativas") base = base.filter((f) => etapaAtiva(f.funil.etapa));
      else if (filtroEtapa !== "todas") base = base.filter((f) => f.funil.etapa === filtroEtapa);
    } else if (filtro !== "todos") {
      return base.filter((f) => f.status === filtro);
    }
    // Encerradas/perdidas descem para o fim sem quebrar a ordem de prioridade/chegada.
    return [...base.filter(leadAtivo), ...base.filter((f) => !leadAtivo(f))];
  }, [doResponsavel, filtro, filtroEtapa, filtroAcao, situacoes, funilDisponivel]);

  const opcoes: { valor: Filtro; label: string }[] = [
    { valor: "todos", label: "Todas" },
    ...STATUS_ATENDIMENTO.map((s) => ({ valor: s, label: STATUS_LABEL[s] })),
  ];
  const opcoesEtapa: { valor: FiltroEtapa; label: string }[] = [
    { valor: "todas", label: "Todas" },
    { valor: "ativas", label: "Ativas" },
    ...ETAPAS.filter((e) => contagemEtapa[e] > 0 || e === filtroEtapa).map((e) => ({
      valor: e,
      label: ETAPA_INFO[e].numero ? `${ETAPA_INFO[e].numero}. ${ETAPA_INFO[e].label}` : ETAPA_INFO[e].label,
    })),
  ];
  const fichaPorId = useMemo(() => new Map(fichas.map((f) => [f.id, f])), [fichas]);

  const chip = (ativo: boolean) =>
    `inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition ${
      ativo ? "bg-navy-900 text-white shadow-sm" : "bg-white text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-50 hover:text-slate-900"
    }`;
  const contador = (ativo: boolean) => `rounded-full px-1.5 text-xs tabular-nums ${ativo ? "bg-white/15 text-white" : "bg-slate-100 text-slate-500"}`;

  return (
    <div>
      {/* Resumo da fila em aberto */}
      <section aria-label="Resumo da fila" className="grid gap-3 sm:grid-cols-3">
        {PRIORIDADES.map((p) => (
          <div key={p} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3.5 shadow-sm">
            <span className={`h-9 w-1 rounded-full ${PRIORIDADE_ESTILO[p].faixa}`} aria-hidden />
            <div>
              <p className="text-2xl font-semibold tabular-nums text-slate-900">{carregando ? "–" : abertasPorPrioridade[p]}</p>
              <p className="text-xs text-slate-500">Prioridade {PRIORIDADE_LABEL[p].toLowerCase()} em aberto</p>
            </div>
          </div>
        ))}
      </section>

      {funilDisponivel && !carregando && !erro && (
        <TarefasDoDia
          tarefas={tarefas}
          fichaPorId={fichaPorId}
          estados={estados}
          contatos={followup.contatos}
          perfil={perfil}
          onAtualizar={atualizar}
        />
      )}

      {/* Filtros */}
      <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-2">
          {funilDisponivel ? (
            <>
              <Workflow className="mt-2 size-4 shrink-0 text-slate-400" aria-hidden />
              <div role="group" aria-label="Filtrar por etapa do funil" className="flex flex-wrap gap-1.5">
                {opcoesEtapa.map(({ valor, label }) => (
                  <button key={valor} type="button" onClick={() => setFiltroEtapa(valor)} aria-pressed={filtroEtapa === valor} className={chip(filtroEtapa === valor)}>
                    {label}
                    <span className={contador(filtroEtapa === valor)}>{contagemEtapa[valor]}</span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <ListFilter className="mt-2 size-4 shrink-0 text-slate-400" aria-hidden />
              <div role="group" aria-label="Filtrar por status" className="flex flex-wrap gap-1.5">
                {opcoes.map(({ valor, label }) => (
                  <button key={valor} type="button" onClick={() => setFiltro(valor)} aria-pressed={filtro === valor} className={chip(filtro === valor)}>
                    {label}
                    <span className={contador(filtro === valor)}>{contagemStatus[valor]}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <button
          type="button"
          onClick={atualizar}
          disabled={carregando}
          className="inline-flex shrink-0 items-center gap-2 self-start rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 ring-1 ring-inset ring-slate-200 transition hover:bg-white hover:text-slate-900 disabled:opacity-60"
        >
          <RefreshCw className={`size-4 ${carregando ? "animate-spin" : ""}`} aria-hidden />
          Atualizar
        </button>
      </div>

      {leadDisponivel && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <CalendarClock className="size-4 text-slate-400" aria-hidden />
          <div role="group" aria-label="Filtrar por próxima ação" className="flex flex-wrap gap-1.5">
            {FILTROS_ACAO.map(({ valor, label }) => {
              const ativo = filtroAcao === valor;
              const alerta = valor === "vencida" && contagemAcao.vencida > 0;
              return (
                <button
                  key={valor}
                  type="button"
                  onClick={() => setFiltroAcao(valor)}
                  aria-pressed={ativo}
                  className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition ${
                    ativo
                      ? alerta
                        ? "bg-red-700 text-white"
                        : "bg-navy-900 text-white"
                      : alerta
                        ? "bg-red-50 text-red-800 ring-1 ring-inset ring-red-200 hover:bg-red-100"
                        : "bg-white text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-50"
                  }`}
                >
                  {label}
                  <span className="tabular-nums opacity-70">{contagemAcao[valor]}</span>
                </button>
              );
            })}
          </div>
          <span className="ml-auto hidden items-center gap-3 text-[11px] text-slate-500 md:flex" aria-label="Legenda de prioridade">
            {TEMPERATURAS.map((t) => (
              <span key={t} className="inline-flex items-center gap-1" title={`${TEMPERATURA_INFO[t].regra}. ${TEMPERATURA_INFO[t].acao}`}>
                <span className={`size-2 rounded-full ${TEMPERATURA_INFO[t].ponto}`} aria-hidden />
                {TEMPERATURA_INFO[t].label}
              </span>
            ))}
          </span>
        </div>
      )}

      {mostrarFiltroResponsavel && (
        <div className="mt-3 flex items-center gap-2">
          <UsersRound className="size-4 text-slate-400" aria-hidden />
          <label htmlFor="filtro-responsavel" className="text-sm text-slate-600">
            {ehSocio(perfil) ? "Advogado(a):" : "Responsável:"}
          </label>
          <select
            id="filtro-responsavel"
            value={responsavel}
            onChange={(e) => setResponsavel(e.target.value)}
            className="rounded-lg border-0 bg-white py-1.5 pl-3 pr-8 text-sm text-slate-700 ring-1 ring-inset ring-slate-200 focus:ring-2 focus:ring-navy-500"
          >
            <option value="todos">{ehSocio(perfil) ? "Todo o escritório" : "Toda a equipe"}</option>
            {equipe.map((m) => (
              <option key={m.id} value={m.id}>
                {rotuloMembro(m, perfil.id)}
              </option>
            ))}
            {qtdSemResponsavel > 0 && <option value="sem">Sem responsável ({qtdSemResponsavel})</option>}
          </select>
        </div>
      )}

      {ehTitular(perfil.cargo) && qtdSupervisao > 0 && (
        <p className="mt-3 text-xs text-slate-500">
          {qtdSupervisao === 1
            ? `1 ficha está com estagiário(a)${ehSocio(perfil) ? "" : " sob sua supervisão"}.`
            : `${qtdSupervisao} fichas estão com estagiários${ehSocio(perfil) ? "" : " sob sua supervisão"}.`}
        </p>
      )}

      {/* Lista */}
      <section aria-label="Fichas de clientes" aria-busy={carregando} className="mt-5">
        {carregando && fichas.length === 0 ? (
          <div className="flex items-center justify-center py-20" role="status">
            <LoaderCircle className="size-6 animate-spin text-navy-700" aria-hidden />
            <span className="sr-only">Carregando fichas…</span>
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
        ) : visiveis.length === 0 ? (
          <div className="flex flex-col items-center rounded-xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center">
            <Inbox className="size-8 text-slate-300" aria-hidden />
            <p className="mt-3 text-sm font-medium text-slate-700">
              {fichas.length === 0 ? "Nenhuma ficha na sua fila" : "Nenhuma ficha neste filtro"}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {fichas.length === 0 ? "Novos atendimentos aparecerão aqui assim que forem triados." : "Escolha outro filtro para ver as demais fichas."}
            </p>
          </div>
        ) : (
          <ul className="space-y-3">
            {visiveis.map((ficha) => (
              <li key={ficha.id}>
                <FichaCard ficha={ficha} podeAssumir={ehTitular(perfil.cargo)} onAlterada={atualizar} cadencia={estados.get(ficha.id)} perfil={perfil} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

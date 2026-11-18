"use client";

import { useEffect, useMemo, useState } from "react";
import { CircleAlert, Inbox, ListFilter, LoaderCircle, RefreshCw, UsersRound } from "lucide-react";
import { buscarEquipeVisivel, ehSocio, ehTitular, rotuloMembro, type Advogado, type MembroEquipe } from "@/lib/advogados";
import {
  PRIORIDADES,
  PRIORIDADE_LABEL,
  STATUS_ATENDIMENTO,
  STATUS_LABEL,
  buscarFichas,
  type Ficha,
  type StatusAtendimento,
} from "@/lib/fichas";
import { PRIORIDADE_ESTILO } from "@/components/fichas/badges";
import { FichaCard } from "@/components/fichas/ficha-card";

type Filtro = "todos" | StatusAtendimento;
/** "todos", "sem" (sem responsável) ou o id de um membro da equipe. */
type FiltroResponsavel = string;

export function FilaFichas({ perfil }: { perfil: Advogado }) {
  const [fichas, setFichas] = useState<Ficha[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [filtro, setFiltro] = useState<Filtro>("todos");
  const [versao, setVersao] = useState(0);
  const [equipe, setEquipe] = useState<MembroEquipe[]>([]);
  const [responsavel, setResponsavel] = useState<FiltroResponsavel>("todos");

  useEffect(() => {
    let atual = true; // descarta respostas de requisições antigas
    Promise.all([buscarFichas(perfil), buscarEquipeVisivel(perfil)]).then(
      ([dados, membros]) => {
        if (!atual) return;
        setFichas(dados);
        setEquipe(membros);
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

  // Filtro por responsável (sócio: qualquer pessoa do escritório; titular: ele e os estagiários).
  const doResponsavel = useMemo(() => {
    if (responsavel === "todos") return fichas;
    if (responsavel === "sem") return fichas.filter((f) => f.advogado_id === null);
    return fichas.filter((f) => f.advogado_id === responsavel);
  }, [fichas, responsavel]);
  const qtdSemResponsavel = useMemo(() => fichas.filter((f) => f.advogado_id === null).length, [fichas]);
  const mostrarFiltroResponsavel = equipe.length > 1 || qtdSemResponsavel > 0;

  const contagemStatus = useMemo(() => {
    const c: Record<Filtro, number> = { todos: doResponsavel.length, novo: 0, em_analise: 0, agendado: 0, finalizado: 0 };
    for (const f of doResponsavel) if (f.status) c[f.status]++;
    return c;
  }, [doResponsavel]);

  const abertasPorPrioridade = useMemo(() => {
    const c = { alta: 0, media: 0, baixa: 0 };
    for (const f of doResponsavel) if (f.status !== "finalizado" && f.prioridade) c[f.prioridade]++;
    return c;
  }, [doResponsavel]);

  const qtdSupervisao = useMemo(() => fichas.filter((f) => f.estagiario).length, [fichas]);

  const visiveis = useMemo(() => {
    if (filtro !== "todos") return doResponsavel.filter((f) => f.status === filtro);
    // Em "Todas", as finalizadas descem para o fim sem quebrar a ordem de prioridade/chegada.
    return [
      ...doResponsavel.filter((f) => f.status !== "finalizado"),
      ...doResponsavel.filter((f) => f.status === "finalizado"),
    ];
  }, [doResponsavel, filtro]);

  const opcoes: { valor: Filtro; label: string }[] = [
    { valor: "todos", label: "Todas" },
    ...STATUS_ATENDIMENTO.map((s) => ({ valor: s, label: STATUS_LABEL[s] })),
  ];

  return (
    <div>
      {/* Resumo da fila em aberto */}
      <section aria-label="Resumo da fila" className="grid gap-3 sm:grid-cols-3">
        {PRIORIDADES.map((p) => (
          <div key={p} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3.5 shadow-sm">
            <span className={`h-9 w-1 rounded-full ${PRIORIDADE_ESTILO[p].faixa}`} aria-hidden />
            <div>
              <p className="text-2xl font-semibold tabular-nums text-slate-900">
                {carregando ? "–" : abertasPorPrioridade[p]}
              </p>
              <p className="text-xs text-slate-500">Prioridade {PRIORIDADE_LABEL[p].toLowerCase()} em aberto</p>
            </div>
          </div>
        ))}
      </section>

      {/* Filtros */}
      <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <ListFilter className="size-4 text-slate-400" aria-hidden />
          <div role="group" aria-label="Filtrar por status" className="flex flex-wrap gap-1.5">
            {opcoes.map(({ valor, label }) => {
              const ativo = filtro === valor;
              return (
                <button
                  key={valor}
                  type="button"
                  onClick={() => setFiltro(valor)}
                  aria-pressed={ativo}
                  className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition ${
                    ativo
                      ? "bg-navy-900 text-white shadow-sm"
                      : "bg-white text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-50 hover:text-slate-900"
                  }`}
                >
                  {label}
                  <span
                    className={`rounded-full px-1.5 text-xs tabular-nums ${
                      ativo ? "bg-white/15 text-white" : "bg-slate-100 text-slate-500"
                    }`}
                  >
                    {contagemStatus[valor]}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <button
          type="button"
          onClick={atualizar}
          disabled={carregando}
          className="inline-flex items-center gap-2 self-start rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 ring-1 ring-inset ring-slate-200 transition hover:bg-white hover:text-slate-900 disabled:opacity-60 sm:self-auto"
        >
          <RefreshCw className={`size-4 ${carregando ? "animate-spin" : ""}`} aria-hidden />
          Atualizar
        </button>
      </div>

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
              {filtro === "todos"
                ? "Nenhuma ficha na sua fila"
                : `Nenhuma ficha com status "${STATUS_LABEL[filtro]}"`}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {filtro === "todos"
                ? "Novos atendimentos aparecerão aqui assim que forem triados."
                : "Escolha outro filtro para ver as demais fichas."}
            </p>
          </div>
        ) : (
          <ul className="space-y-3">
            {visiveis.map((ficha) => (
              <li key={ficha.id}>
                <FichaCard ficha={ficha} podeAssumir={ehTitular(perfil.cargo)} onAlterada={atualizar} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

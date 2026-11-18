"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CircleAlert, CircleCheckBig, Gavel, Handshake, LoaderCircle, Pencil, Plus, Search, Trash, Undo2, UserRound } from "lucide-react";
import { useAuth } from "@/components/auth-provider";
import { VinculoBadge } from "@/components/fichas/badges";
import { PrazoModal } from "@/components/processos/prazo-modal";
import { Toast } from "@/components/toast";
import { rotuloMembro, type MembroEquipe } from "@/lib/advogados";
import {
  CATEGORIA_INFO,
  URGENCIA_INFO,
  alterarStatusPrazo,
  identificacaoPrazo,
  resumirAcordos,
  type CategoriaPrazo,
  buscarPrazos,
  dataLocal,
  diasRestantes,
  excluirPrazo,
  urgenciaDoPrazo,
  type PrazoNaTela,
  type Urgencia,
} from "@/lib/prazos";

type Visao = "abertos" | "cumpridos" | "todos";
/** Agrupamento das categorias (migração v5) no filtro da tela. */
type Grupo = "todos" | "processuais" | "acordos" | "certidoes" | "outros";
const GRUPOS: { valor: Grupo; label: string; categorias: CategoriaPrazo[] }[] = [
  { valor: "todos", label: "Tudo", categorias: [] },
  { valor: "processuais", label: "Processuais e execução fiscal", categorias: ["processual", "execucao_fiscal", "embargos"] },
  { valor: "acordos", label: "Acordos e parcelas", categorias: ["parcela"] },
  { valor: "certidoes", label: "Certidões", categorias: ["certidao"] },
  { valor: "outros", label: "Outros", categorias: ["outro"] },
];
const fmtData = new Intl.DateTimeFormat("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" });
const ORDEM: Urgencia[] = ["vencido", "hoje", "urgente", "proximo", "futuro", "cumprido"];

function textoRestante(p: PrazoNaTela) {
  if (p.status === "cumprido") return p.categoria === "parcela" ? "Paga" : "Cumprido";
  const n = diasRestantes(p.data_fatal);
  if (n < 0 && p.categoria === "parcela") return `Em atraso há ${-n} dia${n === -1 ? "" : "s"}`;
  if (n < 0) return `Venceu há ${-n} dia${n === -1 ? "" : "s"}`;
  if (n === 0) return "Vence hoje";
  if (n === 1) return "Vence amanhã";
  return `Faltam ${n} dias`;
}

export default function ProcessosPage() {
  const { perfil } = useAuth();
  const [prazos, setPrazos] = useState<PrazoNaTela[]>([]);
  const [responsaveis, setResponsaveis] = useState<MembroEquipe[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [versao, setVersao] = useState(0);
  const [visao, setVisao] = useState<Visao>("abertos");
  const [busca, setBusca] = useState("");
  /** "todos" ou o id de um membro da equipe visível (sócio: todo o escritório). */
  const [filtroResponsavel, setFiltroResponsavel] = useState("todos");
  const [grupo, setGrupo] = useState<Grupo>("todos");
  const [modal, setModal] = useState<{ prazo?: PrazoNaTela } | null>(null);
  const [sucesso, setSucesso] = useState<string | null>(null);
  const [erroAcao, setErroAcao] = useState<string | null>(null);
  const fecharToast = useCallback(() => setSucesso(null), []);

  useEffect(() => {
    if (!perfil) return;
    let atual = true;
    buscarPrazos(perfil).then(
      (r) => {
        if (!atual) return;
        setPrazos(r.prazos);
        setResponsaveis(r.responsaveis);
        setErro(null);
        setCarregando(false);
      },
      (e: unknown) => {
        if (!atual) return;
        setErro(e instanceof Error ? e.message : "Não foi possível carregar os prazos.");
        setCarregando(false);
      },
    );
    return () => {
      atual = false;
    };
  }, [perfil, versao]);

  const recarregar = () => {
    setCarregando(true);
    setVersao((v) => v + 1);
  };

  const doResponsavel = useMemo(() => {
    const cats = GRUPOS.find((g) => g.valor === grupo)?.categorias ?? [];
    return prazos.filter(
      (p) => (filtroResponsavel === "todos" || p.advogado_id === filtroResponsavel) && (cats.length === 0 || cats.includes(p.categoria)),
    );
  }, [prazos, filtroResponsavel, grupo]);

  // Pós-venda: acordos com parcelas em atraso (3 seguidas ou 6 alternadas podem rescindir).
  const acordos = useMemo(
    () => resumirAcordos(prazos.filter((p) => filtroResponsavel === "todos" || p.advogado_id === filtroResponsavel)),
    [prazos, filtroResponsavel],
  );
  const acordosAtencao = acordos.filter((a) => a.emAtraso > 0);
  const temCategorias = prazos.some((p) => p.categoria !== "processual");

  const contagem = useMemo(() => {
    const c: Record<Urgencia, number> = { vencido: 0, hoje: 0, urgente: 0, proximo: 0, futuro: 0, cumprido: 0 };
    for (const p of doResponsavel) c[urgenciaDoPrazo(p)]++;
    return c;
  }, [doResponsavel]);

  const grupos = useMemo(() => {
    const termo = busca.trim().toLowerCase();
    const filtrados = doResponsavel.filter((p) => {
      const u = urgenciaDoPrazo(p);
      if (visao === "abertos" && u === "cumprido") return false;
      if (visao === "cumpridos" && u !== "cumprido") return false;
      if (!termo) return true;
      return [identificacaoPrazo(p), p.descricao_prazo, p.ficha?.nome_cliente ?? "", p.tribunal_vara ?? ""].some((s) =>
        s.toLowerCase().includes(termo),
      );
    });
    return ORDEM.map((u) => ({ urgencia: u, itens: filtrados.filter((p) => urgenciaDoPrazo(p) === u) })).filter(
      (g) => g.itens.length > 0,
    );
  }, [doResponsavel, visao, busca]);

  async function acao(fn: () => Promise<void>, ok: string) {
    setErroAcao(null);
    try {
      await fn();
      setSucesso(ok);
      recarregar();
    } catch (e) {
      setErroAcao(e instanceof Error ? e.message : "Não foi possível concluir.");
    }
  }

  if (!perfil) return null;

  const resumo: { u: Urgencia; texto: string }[] = [
    { u: "vencido", texto: "vencidos" },
    { u: "hoje", texto: "vencem hoje" },
    { u: "urgente", texto: "urgentes" },
    { u: "proximo", texto: "nos próximos 7 dias" },
  ];

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2.5 text-2xl font-semibold tracking-tight text-navy-950">
            <Gavel className="size-6 text-navy-700" aria-hidden /> Processos e prazos
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Prazos fatais e acompanhamento pós-venda (parcelas de acordos, certidões, execução fiscal), em ordem de urgência.
            Também aparecem na agenda mensal.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setModal({})}
          disabled={carregando || Boolean(erro)}
          className="inline-flex items-center gap-2 self-start rounded-lg bg-navy-900 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-navy-800 disabled:opacity-60"
        >
          <Plus className="size-4" aria-hidden /> Novo prazo ou controle
        </button>
      </div>

      {!carregando && !erro && (
        <section aria-label="Resumo" className="mt-6 grid gap-3 sm:grid-cols-4">
          {resumo.map(({ u, texto }) => (
            <div key={u} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
              <span className={`h-9 w-1 rounded-full ${URGENCIA_INFO[u].faixa}`} aria-hidden />
              <div>
                <p className="text-2xl font-semibold tabular-nums text-slate-900">{contagem[u]}</p>
                <p className="text-xs text-slate-500">{texto}</p>
              </div>
            </div>
          ))}
        </section>
      )}

      {!carregando && !erro && acordosAtencao.length > 0 && (
        <section aria-label="Acordos com parcelas em atraso" className="mt-6 rounded-xl border border-red-200 bg-red-50/60 p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-red-900">
            <Handshake className="size-4" aria-hidden /> Acordos com parcelas em atraso
          </h2>
          <p className="mt-0.5 text-xs text-red-900/80">
            Atraso de 3 parcelas seguidas ou 6 alternadas pode rescindir o acordo. Confira a regra da modalidade.
          </p>
          <ul className="mt-3 space-y-1.5">
            {acordosAtencao.map((a) => (
              <li key={a.chave} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-white px-3 py-2 text-sm ring-1 ring-red-100">
                <span className="font-semibold text-slate-900">{a.acordo_ref}</span>
                {a.cliente && <span className="text-slate-500">{a.cliente}</span>}
                <span className="text-slate-600">
                  {a.pagas}/{a.total} pagas · <strong className="text-red-700">{a.emAtraso} em atraso</strong>
                  {a.maiorSequencia > 1 && ` (${a.maiorSequencia} seguidas)`}
                </span>
                {a.risco && (
                  <span className="ml-auto rounded-full bg-red-700 px-2 py-0.5 text-xs font-semibold text-white">Risco de rescisão</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {temCategorias && (
        <div role="group" aria-label="Tipo de controle" className="mt-6 flex flex-wrap gap-1.5">
          {GRUPOS.map((g) => (
            <button
              key={g.valor}
              type="button"
              onClick={() => setGrupo(g.valor)}
              aria-pressed={grupo === g.valor}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                grupo === g.valor ? "bg-navy-900 text-white" : "bg-white text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-50"
              }`}
            >
              {g.label}
            </button>
          ))}
        </div>
      )}

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div role="group" aria-label="Visão" className="flex gap-1.5">
          {(["abertos", "cumpridos", "todos"] as Visao[]).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setVisao(v)}
              aria-pressed={visao === v}
              className={`rounded-full px-3 py-1.5 text-sm font-medium capitalize transition ${
                visao === v ? "bg-navy-900 text-white" : "bg-white text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-50"
              }`}
            >
              {v}
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        {responsaveis.length > 1 && (
          <select
            value={filtroResponsavel}
            onChange={(e) => setFiltroResponsavel(e.target.value)}
            aria-label="Filtrar por advogado"
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-navy-500"
          >
            <option value="todos">{perfil.cargo === "socio" ? "Todo o escritório" : "Toda a equipe"}</option>
            {responsaveis.map((r) => (
              <option key={r.id} value={r.id}>
                {r.id === perfil.id ? "Meus prazos" : rotuloMembro(r, perfil.id)}
              </option>
            ))}
          </select>
        )}
        <div className="relative sm:w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
          <input
            type="search"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Buscar CNJ, cliente, vara…"
            aria-label="Buscar prazos"
            className="block w-full rounded-lg border border-slate-300 bg-white py-2 pl-9 pr-3 text-sm outline-none focus:border-navy-500 focus:ring-3 focus:ring-navy-500/15"
          />
        </div>
        </div>
      </div>

      {erroAcao && (
        <p role="alert" className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> {erroAcao}
        </p>
      )}

      <section aria-label="Prazos" aria-busy={carregando} className="mt-6">
        {carregando ? (
          <div className="flex justify-center py-20" role="status">
            <LoaderCircle className="size-6 animate-spin text-navy-700" aria-hidden />
          </div>
        ) : erro ? (
          <div role="alert" className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800">
            <CircleAlert className="mt-0.5 size-5 shrink-0" aria-hidden /> {erro}
          </div>
        ) : grupos.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center">
            <Gavel className="mx-auto size-8 text-slate-300" aria-hidden />
            <p className="mt-3 text-sm font-medium text-slate-700">Nenhum prazo nesta visão</p>
            <p className="mt-1 text-xs text-slate-500">Cadastre prazos fatais para acompanhá-los aqui e na agenda.</p>
          </div>
        ) : (
          <div className="space-y-8">
            {grupos.map(({ urgencia, itens }) => (
              <section key={urgencia} aria-labelledby={`g-${urgencia}`}>
                <h2 id={`g-${urgencia}`} className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700">
                  <span className={`size-2 rounded-full ${URGENCIA_INFO[urgencia].faixa}`} aria-hidden />
                  {URGENCIA_INFO[urgencia].label}
                  <span className="font-normal text-slate-400">· {itens.length}</span>
                </h2>
                <ul className="space-y-2">
                  {itens.map((p) => {
                    const u = urgenciaDoPrazo(p);
                    const critico = u === "vencido" || u === "hoje" || u === "urgente";
                    return (
                      <li
                        key={p.id}
                        className={`relative overflow-hidden rounded-xl border bg-white p-4 pl-5 shadow-sm ${critico ? "border-red-300 ring-1 ring-red-200" : "border-slate-200"}`}
                      >
                        <span className={`absolute inset-y-0 left-0 w-1 ${URGENCIA_INFO[u].faixa}`} aria-hidden />
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0">
                            <p className={`font-semibold ${u === "cumprido" ? "text-slate-500 line-through" : "text-slate-900"}`}>{p.descricao_prazo}</p>
                            <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                              {p.categoria !== "processual" && (
                                <span className="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-700">{CATEGORIA_INFO[p.categoria].curto}</span>
                              )}
                              <span className={p.numero_cnj ? "font-mono" : ""}>{identificacaoPrazo(p)}</span>
                            </p>
                            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                              {p.ficha && (
                                <span className="inline-flex items-center gap-1">
                                  <UserRound className="size-3.5" aria-hidden /> {p.ficha.nome_cliente}
                                </span>
                              )}
                              {p.tribunal_vara && <span>{p.tribunal_vara}</span>}
                              {p.fase_processual && <span>Fase: {p.fase_processual}</span>}
                              {CATEGORIA_INFO[p.categoria].exigeCnj && <span>{p.tipo_contagem === "uteis" ? "Dias úteis" : "Dias corridos"}</span>}
                              <VinculoBadge estagiario={p.estagiario} responsavel={p.responsavel} />
                            </div>
                          </div>
                          <div className="shrink-0 text-left sm:text-right">
                            <p className="text-sm font-semibold tabular-nums text-slate-900">{fmtData.format(dataLocal(p.data_fatal))}</p>
                            <span className={`mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${URGENCIA_INFO[u].badge}`}>
                              {textoRestante(p)}
                            </span>
                          </div>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-1.5 border-t border-slate-100 pt-3">
                          {p.status !== "cumprido" ? (
                            <button
                              type="button"
                              onClick={() =>
                                void acao(
                                  () => alterarStatusPrazo(p.id, "cumprido"),
                                  p.categoria === "parcela" ? "Parcela marcada como paga." : "Prazo marcado como cumprido.",
                                )
                              }
                              className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200 hover:bg-emerald-50"
                            >
                              <CircleCheckBig className="size-3.5" aria-hidden /> {p.categoria === "parcela" ? "Marcar paga" : "Marcar cumprido"}
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => void acao(() => alterarStatusPrazo(p.id, "pendente"), "Prazo reaberto.")}
                              className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-50"
                            >
                              <Undo2 className="size-3.5" aria-hidden /> Reabrir
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => setModal({ prazo: p })}
                            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-50"
                          >
                            <Pencil className="size-3.5" aria-hidden /> Editar
                          </button>
                          {perfil.cargo !== "estagiario" && (
                            <button
                              type="button"
                              onClick={() =>
                                confirm(`Excluir o prazo "${p.descricao_prazo}"? Prefira marcar como cumprido para manter o histórico.`) &&
                                void acao(() => excluirPrazo(p.id), "Prazo excluído.")
                              }
                              className="ml-auto inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
                            >
                              <Trash className="size-3.5" aria-hidden /> Excluir
                            </button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </section>

      {modal && (
        <PrazoModal
          perfil={perfil}
          responsaveis={responsaveis}
          prazo={modal.prazo}
          onFechar={() => setModal(null)}
          onSalvo={(msg) => {
            setModal(null);
            setSucesso(msg);
            recarregar();
          }}
        />
      )}
      {sucesso && <Toast mensagem={sucesso} onFechar={fecharToast} />}
    </main>
  );
}

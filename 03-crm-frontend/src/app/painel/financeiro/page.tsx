"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CircleAlert, HandCoins, LoaderCircle, RefreshCw, Wallet } from "lucide-react";
import { useAuth } from "@/components/auth-provider";
import { RegistrarPagamentoModal } from "@/components/clientes/registrar-pagamento-modal";
import { Toast } from "@/components/toast";
import { buscarEquipeVisivel, rotuloMembro, type MembroEquipe } from "@/lib/advogados";
import { chaveDia } from "@/lib/datas";
import {
  MEIO_LABEL,
  STATUS_PARCELA_INFO,
  TIPO_CONTRATO_LABEL,
  buscarRecebiveis,
  formatarMoeda,
  statusParcela,
  type ParcelaComContrato,
} from "@/lib/financeiro";

type Filtro = "atrasadas" | "a_vencer" | "pagas_mes" | "todas";
const FILTROS: { valor: Filtro; label: string }[] = [
  { valor: "atrasadas", label: "Atrasadas" },
  { valor: "a_vencer", label: "A vencer (30 dias)" },
  { valor: "pagas_mes", label: "Recebidas no mês" },
  { valor: "todas", label: "Todas" },
];
const fmtData = (iso: string) => new Intl.DateTimeFormat("pt-BR").format(new Date(`${iso.slice(0, 10)}T12:00:00`));

/**
 * Financeiro: parcelas de honorários de todos os contratos visíveis (RLS: sócio vê o
 * escritório; titular, ele e os estagiários; estagiário e desenvolvedor, só os próprios).
 */
export default function FinanceiroPage() {
  const { perfil } = useAuth();
  const [parcelas, setParcelas] = useState<ParcelaComContrato[]>([]);
  const [equipe, setEquipe] = useState<MembroEquipe[]>([]);
  const [disponivel, setDisponivel] = useState(true);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [versao, setVersao] = useState(0);
  const [filtro, setFiltro] = useState<Filtro>("atrasadas");
  const [responsavel, setResponsavel] = useState("todos");
  const [pagar, setPagar] = useState<ParcelaComContrato | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [hoje, setHoje] = useState<Date | null>(null);
  const fecharAviso = useCallback(() => setAviso(null), []);

  useEffect(() => {
    if (!perfil) return;
    let atual = true;
    Promise.all([buscarRecebiveis(), buscarEquipeVisivel(perfil)]).then(
      ([r, membros]) => {
        if (!atual) return;
        setParcelas(r.parcelas);
        setDisponivel(r.disponivel);
        setEquipe(membros);
        setHoje(new Date());
        setErro(null);
        setCarregando(false);
      },
      (e: unknown) => {
        if (!atual) return;
        setErro(e instanceof Error ? e.message : "Não foi possível carregar o financeiro.");
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

  const doResponsavel = useMemo(
    () => (responsavel === "todos" ? parcelas : parcelas.filter((p) => p.contrato.advogado_id === responsavel)),
    [parcelas, responsavel],
  );

  const resumo = useMemo(() => {
    const r = { atrasado: 0, aVencer: 0, recebidoMes: 0, qtdAtrasadas: 0 };
    if (!hoje) return r;
    const hojeChave = chaveDia(hoje);
    const limite = chaveDia(new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() + 30));
    const mes = hojeChave.slice(0, 7);
    for (const p of doResponsavel) {
      const s = statusParcela(p, hoje);
      if (s === "atrasada") {
        r.atrasado += p.valor;
        r.qtdAtrasadas++;
      } else if (s === "pendente" && p.vencimento <= limite) r.aVencer += p.valor;
      if (p.pago_em?.startsWith(mes)) r.recebidoMes += p.valor_pago ?? p.valor;
    }
    return r;
  }, [doResponsavel, hoje]);

  const visiveis = useMemo(() => {
    if (!hoje) return [];
    const limite = chaveDia(new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() + 30));
    const mes = chaveDia(hoje).slice(0, 7);
    const lista = doResponsavel.filter((p) => {
      const s = statusParcela(p, hoje);
      if (filtro === "atrasadas") return s === "atrasada";
      if (filtro === "a_vencer") return s === "pendente" && p.vencimento <= limite;
      if (filtro === "pagas_mes") return Boolean(p.pago_em?.startsWith(mes));
      return true;
    });
    return filtro === "pagas_mes" ? [...lista].sort((a, b) => (b.pago_em ?? "").localeCompare(a.pago_em ?? "")) : lista;
  }, [doResponsavel, filtro, hoje]);

  if (!perfil) return null;
  const nomes = new Map(equipe.map((m) => [m.id, m.nome]));

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2.5 text-2xl font-semibold tracking-tight text-navy-950">
            <Wallet className="size-6 text-navy-700" aria-hidden /> Financeiro
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Honorários a receber e entradas. Contratos e parcelas são criados na ficha do cliente (&quot;Cliente e honorários&quot;).
          </p>
        </div>
        <button
          type="button"
          onClick={recarregar}
          disabled={carregando}
          className="inline-flex items-center gap-2 self-start rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-white disabled:opacity-60"
        >
          <RefreshCw className={`size-4 ${carregando ? "animate-spin" : ""}`} aria-hidden /> Atualizar
        </button>
      </div>

      {!disponivel ? (
        <p className="mt-8 rounded-xl bg-amber-50 p-5 text-sm text-amber-900">O financeiro exige a migração 20261119_v7_financeiro_documentos.sql no Supabase.</p>
      ) : erro ? (
        <p role="alert" className="mt-8 flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800">
          <CircleAlert className="mt-0.5 size-5 shrink-0" aria-hidden /> {erro}
        </p>
      ) : carregando && parcelas.length === 0 ? (
        <div className="flex justify-center py-24" role="status"><LoaderCircle className="size-6 animate-spin text-navy-700" aria-hidden /></div>
      ) : (
        <>
          <section aria-label="Resumo" className="mt-8 grid gap-4 sm:grid-cols-3">
            <div className="rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
              <p className="text-sm text-slate-500">Em atraso</p>
              <p className={`mt-1 text-3xl font-semibold ${resumo.atrasado > 0 ? "text-red-700" : "text-slate-900"}`}>{formatarMoeda(resumo.atrasado)}</p>
              <p className="mt-1 text-xs text-slate-500">{resumo.qtdAtrasadas} parcela(s)</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
              <p className="text-sm text-slate-500">A vencer em 30 dias</p>
              <p className="mt-1 text-3xl font-semibold text-slate-900">{formatarMoeda(resumo.aVencer)}</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
              <p className="text-sm text-slate-500">Recebido no mês</p>
              <p className="mt-1 text-3xl font-semibold text-emerald-700">{formatarMoeda(resumo.recebidoMes)}</p>
            </div>
          </section>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div role="group" aria-label="Filtro" className="flex flex-wrap gap-1.5">
              {FILTROS.map((f) => (
                <button
                  key={f.valor}
                  type="button"
                  onClick={() => setFiltro(f.valor)}
                  aria-pressed={filtro === f.valor}
                  className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
                    filtro === f.valor ? "bg-navy-900 text-white" : "bg-white text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-50"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
            {equipe.length > 1 && (
              <select
                value={responsavel}
                onChange={(e) => setResponsavel(e.target.value)}
                aria-label="Filtrar por advogado"
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-navy-500"
              >
                <option value="todos">{perfil.cargo === "socio" ? "Todo o escritório" : "Toda a equipe"}</option>
                {equipe.map((m) => (
                  <option key={m.id} value={m.id}>{m.id === perfil.id ? "Meus contratos" : rotuloMembro(m, perfil.id)}</option>
                ))}
              </select>
            )}
          </div>

          <section aria-label="Parcelas" className="mt-4 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
            {visiveis.length === 0 ? (
              <p className="px-6 py-12 text-center text-sm text-slate-500">Nenhuma parcela neste filtro.</p>
            ) : (
              <table className="w-full min-w-[760px] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs font-medium text-slate-500">
                    <th scope="col" className="px-4 py-2.5 font-medium">Cliente</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">Contrato</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">Parcela</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">Vencimento</th>
                    <th scope="col" className="px-4 py-2.5 text-right font-medium">Valor</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">Situação</th>
                    <th scope="col" className="px-4 py-2.5"><span className="sr-only">Ações</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {visiveis.map((p) => {
                    const s = hoje ? statusParcela(p, hoje) : "pendente";
                    return (
                      <tr key={p.id}>
                        <td className="px-4 py-2.5 text-slate-900">
                          {p.contrato.ficha?.nome_cliente ?? "—"}
                          {p.contrato.advogado_id !== perfil.id && nomes.get(p.contrato.advogado_id) && (
                            <span className="block text-xs text-slate-400">{nomes.get(p.contrato.advogado_id)}</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-slate-600">
                          {TIPO_CONTRATO_LABEL[p.contrato.tipo]}
                          <span className="block max-w-56 truncate text-xs text-slate-400">{p.contrato.descricao}</span>
                        </td>
                        <td className="px-4 py-2.5 tabular-nums text-slate-600">{p.numero}</td>
                        <td className="px-4 py-2.5 tabular-nums text-slate-700">{fmtData(p.vencimento)}</td>
                        <td className="px-4 py-2.5 text-right font-medium tabular-nums text-slate-900">{formatarMoeda(p.valor)}</td>
                        <td className="px-4 py-2.5">
                          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${STATUS_PARCELA_INFO[s].badge}`}>{STATUS_PARCELA_INFO[s].label}</span>
                          {p.pago_em && (
                            <span className="block text-xs text-slate-400">
                              {fmtData(p.pago_em)} · {p.meio ? MEIO_LABEL[p.meio] : ""}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          {!p.pago_em && (
                            <button
                              type="button"
                              onClick={() => setPagar(p)}
                              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200 hover:bg-emerald-50"
                            >
                              <HandCoins className="size-3.5" aria-hidden /> Registrar
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}

      {pagar && (
        <RegistrarPagamentoModal
          parcela={pagar}
          fichaId={pagar.contrato.ficha_id}
          cliente={pagar.contrato.ficha?.nome_cliente ?? "Cliente"}
          descricao={pagar.contrato.descricao}
          onFechar={() => setPagar(null)}
          onSalvo={() => {
            setPagar(null);
            setAviso("Pagamento registrado.");
            recarregar();
          }}
        />
      )}
      {aviso && <Toast mensagem={aviso} onFechar={fecharAviso} />}
    </main>
  );
}

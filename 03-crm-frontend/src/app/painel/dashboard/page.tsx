"use client";

import { useEffect, useMemo, useState } from "react";
import { ChartNoAxesColumn, CircleAlert, Hourglass, LoaderCircle } from "lucide-react";
import { useAuth } from "@/components/auth-provider";
import { AREAS_JURIDICAS, isAreaJuridica } from "@/lib/advogados";
import { rotuloStatusConversa } from "@/lib/atendimentos";
import { PRESETS, buscarIndicadores, intervaloDoPreset, type Indicadores, type PresetPeriodo } from "@/lib/indicadores";
import {
  ETAPAS,
  ETAPA_INFO,
  MOTIVO_PERDA_LABEL,
  buscarIndicadoresFunil,
  isMotivoPerda,
  type IndicadoresFunil,
} from "@/lib/funil";

const fmtNum = new Intl.NumberFormat("pt-BR");
const fmtPct = new Intl.NumberFormat("pt-BR", { style: "percent", maximumFractionDigits: 1 });
const fmtData = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });

/** Cor única das barras (navy-500): validada no dataviz para superfície clara. */
const COR_BARRA = "bg-navy-500";

function StatTile({ rotulo, valor, detalhe }: { rotulo: string; valor: string; detalhe?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
      <p className="text-sm text-slate-500">{rotulo}</p>
      <p className="mt-1 text-3xl font-semibold text-slate-900">{valor}</p>
      {detalhe && <p className="mt-1 text-xs text-slate-500">{detalhe}</p>}
    </div>
  );
}

/** Barras horizontais ordenadas (uma série, uma cor): valor ao fim da barra, detalhe no hover/foco. */
function BarrasOrdenadas({ itens, unidade }: { itens: { nome: string; valor: number }[]; unidade: string }) {
  const max = Math.max(1, ...itens.map((i) => i.valor));
  const total = itens.reduce((s, i) => s + i.valor, 0);
  return (
    <ul className="space-y-2.5">
      {itens.map((i) => {
        const detalhe = `${i.nome}: ${fmtNum.format(i.valor)} ${unidade} (${fmtPct.format(total ? i.valor / total : 0)} do total)`;
        return (
          <li key={i.nome} tabIndex={0} aria-label={detalhe} className="group relative grid grid-cols-[9rem_1fr] items-center gap-3 rounded outline-none focus-visible:ring-2 focus-visible:ring-navy-500/40">
            <span className="truncate text-sm text-slate-700">{i.nome}</span>
            <span className="flex items-center gap-2">
              <span className="h-3 flex-1">
                <span
                  className={`block h-3 rounded-r-[4px] ${COR_BARRA} transition-opacity group-hover:opacity-80`}
                  style={{ width: `${Math.max(2, (i.valor / max) * 100)}%` }}
                />
              </span>
              <span className="w-10 text-right text-sm font-medium tabular-nums text-slate-700">{fmtNum.format(i.valor)}</span>
            </span>
            <span
              role="tooltip"
              className="pointer-events-none absolute -top-8 left-36 z-10 hidden whitespace-nowrap rounded-md bg-navy-950 px-2.5 py-1 text-xs text-white shadow-lg group-hover:block group-focus-visible:block"
            >
              {detalhe}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export default function DashboardPage() {
  const { perfil } = useAuth();
  const [preset, setPreset] = useState<PresetPeriodo>("30d");
  const [dados, setDados] = useState<Indicadores | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [funil, setFunil] = useState<IndicadoresFunil | null>(null);

  const intervalo = useMemo(() => intervaloDoPreset(preset), [preset]);

  useEffect(() => {
    if (!perfil) return;
    let atual = true;
    Promise.all([buscarIndicadores(intervalo.inicio, intervalo.fim), buscarIndicadoresFunil(intervalo.inicio, intervalo.fim)]).then(
      ([d, f]) => {
        if (!atual) return;
        setDados(d);
        setFunil(f);
        setErro(null);
        setCarregando(false);
      },
      (e: unknown) => {
        if (!atual) return;
        setErro(e instanceof Error ? e.message : "Não foi possível carregar os indicadores.");
        setCarregando(false);
      },
    );
    return () => {
      atual = false;
    };
  }, [perfil, intervalo]);

  function escolher(p: PresetPeriodo) {
    setCarregando(true);
    setPreset(p);
  }

  if (!perfil) return null;

  const conversao = dados && dados.leads > 0 ? dados.leads_com_reuniao / dados.leads : null;
  const fimInclusivo = new Date(intervalo.fim.getTime() - 1);
  const areas = (dados?.por_area ?? []).map((a) => ({
    nome: isAreaJuridica(a.area) ? AREAS_JURIDICAS[a.area] : a.area,
    valor: a.fichas,
  }));
  const statusLeads = Object.entries(dados?.leads_por_status ?? {})
    .map(([status, n]) => ({ nome: rotuloStatusConversa(status), valor: n }))
    .sort((a, b) => b.valor - a.valor);
  const maxFichasAdv = Math.max(1, ...(dados?.por_advogado ?? []).map((a) => a.fichas));
  // Etapas na ordem do funil (categoria ordinal: não reordenar por valor).
  const porEtapa = funil
    ? ETAPAS.map((e) => ({
        nome: ETAPA_INFO[e].numero ? `${ETAPA_INFO[e].numero}. ${ETAPA_INFO[e].label}` : ETAPA_INFO[e].label,
        valor: funil.por_etapa[e] ?? 0,
      })).filter((i) => i.valor > 0)
    : [];
  const perdas = funil
    ? Object.entries(funil.perdas_por_motivo)
        .map(([m, n]) => ({ nome: isMotivoPerda(m) ? MOTIVO_PERDA_LABEL[m] : m, valor: n }))
        .sort((a, b) => b.valor - a.valor)
    : [];
  const totalPerdas = perdas.reduce((t, p) => t + p.valor, 0);

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2.5 text-2xl font-semibold tracking-tight text-navy-950">
            <ChartNoAxesColumn className="size-6 text-navy-700" aria-hidden /> Indicadores
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {dados?.escopo === "escritorio"
              ? "Visão de sócio: todo o escritório (contas de teste não entram nas contagens)."
              : "Seus números (e os da sua equipe, se houver)."}{" "}
            Período: {fmtData.format(intervalo.inicio)} a {fmtData.format(fimInclusivo)}.
          </p>
        </div>
        <div role="group" aria-label="Período" className="flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p.valor}
              type="button"
              onClick={() => escolher(p.valor)}
              aria-pressed={preset === p.valor}
              className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
                preset === p.valor ? "bg-navy-900 text-white" : "bg-white text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-50"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {erro ? (
        <div role="alert" className="mt-8 flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800">
          <CircleAlert className="mt-0.5 size-5 shrink-0" aria-hidden /> {erro}
        </div>
      ) : !dados ? (
        <div className="flex justify-center py-24" role="status">
          <LoaderCircle className="size-6 animate-spin text-navy-700" aria-hidden />
        </div>
      ) : (
        <div className={`transition-opacity ${carregando ? "opacity-50" : ""}`} aria-busy={carregando}>
          <section aria-label="Números principais" className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              rotulo="Leads recebidos pelo bot"
              valor={fmtNum.format(dados.leads)}
              detalhe={dados.leads_sem_responsavel ? `${fmtNum.format(dados.leads_sem_responsavel)} ainda sem responsável` : undefined}
            />
            <StatTile
              rotulo="Conversão em reunião"
              valor={conversao === null ? "—" : fmtPct.format(conversao)}
              detalhe={`${fmtNum.format(dados.leads_com_reuniao)} de ${fmtNum.format(dados.leads)} leads com reunião`}
            />
            <StatTile
              rotulo="Reuniões agendadas"
              valor={fmtNum.format(dados.reunioes)}
              detalhe={`${fmtNum.format(dados.reunioes_realizadas)} já realizadas`}
            />
            <StatTile rotulo="Fichas criadas" valor={fmtNum.format(dados.fichas)} />
          </section>

          {(dados.prazos_vencidos > 0 || dados.prazos_proximos_7d > 0) && (
            <p className="mt-4 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
              <Hourglass className="size-4 shrink-0" aria-hidden />
              <span>
                <strong>Atenção a prazos:</strong> {fmtNum.format(dados.prazos_vencidos)} vencido(s) e{" "}
                {fmtNum.format(dados.prazos_proximos_7d)} nos próximos 7 dias.
              </span>
            </p>
          )}

          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-900">Atendimentos por área jurídica</h2>
              <p className="mt-0.5 text-xs text-slate-500">Fichas criadas no período, por área identificada.</p>
              <div className="mt-5">
                {areas.length === 0 ? (
                  <p className="text-sm text-slate-400">Sem fichas no período.</p>
                ) : (
                  <BarrasOrdenadas itens={areas} unidade="fichas" />
                )}
              </div>
            </section>

            <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-900">Leads por situação atual</h2>
              <p className="mt-0.5 text-xs text-slate-500">Onde estão hoje as conversas que chegaram no período.</p>
              <div className="mt-5">
                {statusLeads.length === 0 ? (
                  <p className="text-sm text-slate-400">Nenhum lead no período.</p>
                ) : (
                  <BarrasOrdenadas itens={statusLeads} unidade="leads" />
                )}
              </div>
            </section>
          </div>

          {funil && (
            <div className="mt-6 grid gap-6 lg:grid-cols-2">
              <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
                <h2 className="text-sm font-semibold text-slate-900">Funil: etapa atual dos leads</h2>
                <p className="mt-0.5 text-xs text-slate-500">Fichas criadas no período, pela etapa em que estão hoje (na ordem do funil).</p>
                <div className="mt-5">
                  {porEtapa.length === 0 ? (
                    <p className="text-sm text-slate-400">Sem fichas no período.</p>
                  ) : (
                    <BarrasOrdenadas itens={porEtapa} unidade="leads" />
                  )}
                </div>
              </section>
              <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
                <h2 className="text-sm font-semibold text-slate-900">Motivos de perda</h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  {totalPerdas > 0
                    ? `${fmtNum.format(totalPerdas)} lead(s) perdido(s) no período. Mostra onde o anúncio ou a abordagem precisa mudar.`
                    : "Leads marcados como perdidos no período."}
                </p>
                <div className="mt-5">
                  {perdas.length === 0 ? (
                    <p className="text-sm text-slate-400">Nenhuma perda registrada no período.</p>
                  ) : (
                    <BarrasOrdenadas itens={perdas} unidade="perdas" />
                  )}
                </div>
              </section>
            </div>
          )}

          <section className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-sm font-semibold text-slate-900">Volume por advogado</h2>
            <p className="mt-0.5 text-xs text-slate-500">Atendimentos do bot, fichas e reuniões criados no período.</p>
            {dados.por_advogado.length === 0 ? (
              <p className="mt-5 text-sm text-slate-400">Sem movimentação no período.</p>
            ) : (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs font-medium text-slate-500">
                      <th scope="col" className="py-2 pr-3 font-medium">Advogado(a)</th>
                      <th scope="col" className="w-[40%] py-2 pr-3 font-medium">Fichas</th>
                      <th scope="col" className="py-2 pr-3 text-right font-medium">Atendimentos</th>
                      <th scope="col" className="py-2 text-right font-medium">Reuniões</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {dados.por_advogado.map((a) => (
                      <tr key={a.advogado_id}>
                        <td className="py-2.5 pr-3 text-slate-800">
                          {a.nome}
                          {a.cargo === "estagiario" && <span className="ml-1 text-xs text-slate-400">· estagiário(a)</span>}
                          {a.cargo === "socio" && <span className="ml-1 text-xs text-slate-400">· sócio(a)</span>}
                        </td>
                        <td className="py-2.5 pr-3">
                          <span className="flex items-center gap-2">
                            <span className="h-2.5 flex-1" aria-hidden>
                              <span className={`block h-2.5 rounded-r-[4px] ${COR_BARRA}`} style={{ width: `${Math.max(2, (a.fichas / maxFichasAdv) * 100)}%` }} />
                            </span>
                            <span className="w-8 text-right tabular-nums text-slate-700">{fmtNum.format(a.fichas)}</span>
                          </span>
                        </td>
                        <td className="py-2.5 pr-3 text-right tabular-nums text-slate-700">{fmtNum.format(a.atendimentos)}</td>
                        <td className="py-2.5 text-right tabular-nums text-slate-700">{fmtNum.format(a.reunioes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}

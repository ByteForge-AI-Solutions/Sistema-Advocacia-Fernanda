"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { CircleAlert, FileDown, Landmark, LoaderCircle, Play, RefreshCw, Search, ShieldAlert } from "lucide-react";
import { useAuth } from "@/components/auth-provider";
import { AvisosExecucao, ResultadoExecucaoPainel } from "@/components/prospeccao/resultado-execucao";
import { Toast } from "@/components/toast";
import { chaveDia } from "@/lib/datas";
import { formatarMoeda } from "@/lib/financeiro";
import {
  FILTROS_PADRAO,
  MAX_EXPORTACAO,
  ORIGEM_LABEL,
  SITUACAO_LABEL,
  TRIBUNAIS_PROSPECCAO,
  VALOR_FONTE_LABEL,
  VALOR_MINIMO_PROSPECCAO,
  baixarArquivo,
  buscarNovosProcessos,
  buscarOportunidades,
  carregarParaExportar,
  formatarCnj,
  formatarCnpj,
  formatarData,
  gerarCsv,
  ErroProspeccao,
  podeProspectar,
  processarFila,
  registrarExportacao,
  resumoFila,
  type FiltrosProspeccao,
  type Oportunidade,
  type ResultadoExecucao,
  type SituacaoFila,
  type TribunalProspeccao,
} from "@/lib/prospeccao";

const campo =
  "rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-navy-500 focus:ring-2 focus:ring-navy-500/20";

function alternar<T>(lista: T[], item: T): T[] {
  return lista.includes(item) ? lista.filter((x) => x !== item) : [...lista, item];
}

/** Mesmas regras da Edge Function (validarPedido): confere antes de gastar uma das 6 chamadas/min. */
function conferirPeriodo(de: string, ate: string): string | null {
  if (de > ate) return "A data inicial é depois da final.";
  const amanha = chaveDia(new Date(Date.now() + 86_400_000));
  if (ate > amanha) return "O período não pode estar no futuro.";
  const dias = (Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / 86_400_000;
  if (dias > 31) return "O DataJud aceita no máximo 31 dias por busca. Divida o período.";
  return null;
}

/**
 * Prospecção de execuções fiscais (CNPJ). Só sócios e advogados titulares: a tela some
 * para os demais, e o RLS/Edge Function negam no servidor de qualquer forma.
 */
export default function ProspeccaoPage() {
  const { perfil } = useAuth();
  const autorizado = perfil ? podeProspectar(perfil.cargo) : false;

  // Lista
  const [rascunho, setRascunho] = useState<FiltrosProspeccao>(FILTROS_PADRAO);
  const [filtros, setFiltros] = useState<FiltrosProspeccao>(FILTROS_PADRAO);
  const [linhas, setLinhas] = useState<Oportunidade[]>([]);
  const [pagina, setPagina] = useState(0);
  const [temMais, setTemMais] = useState(false);
  const [disponivel, setDisponivel] = useState(true);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [versao, setVersao] = useState(0);
  const [fila, setFila] = useState<Record<SituacaoFila, number> | null>(null);

  // Busca de processos novos (Edge Function)
  const [tribunaisBusca, setTribunaisBusca] = useState<TribunalProspeccao[]>([...TRIBUNAIS_PROSPECCAO]);
  const [buscaDe, setBuscaDe] = useState("");
  const [buscaAte, setBuscaAte] = useState("");
  const [limite, setLimite] = useState(200);
  const [executando, setExecutando] = useState<"buscar" | "processar" | null>(null);
  const [resultado, setResultado] = useState<ResultadoExecucao | null>(null);
  const [erroExecucao, setErroExecucao] = useState<{ mensagem: string; parcial: Partial<ResultadoExecucao> | null } | null>(null);
  // Limite de 6 execuções por minuto (servidor): botões travados até liberaEm.
  const [liberaEm, setLiberaEm] = useState<number | null>(null);
  const [agora, setAgora] = useState(() => Date.now());

  const [exportando, setExportando] = useState(false);
  const [erroExportacao, setErroExportacao] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const fecharAviso = useCallback(() => setAviso(null), []);

  useEffect(() => {
    if (!autorizado) return;
    let atual = true;
    Promise.all([buscarOportunidades(filtros, pagina), pagina === 0 ? resumoFila() : Promise.resolve(undefined)]).then(
      ([r, f]) => {
        if (!atual) return;
        setLinhas((antes) => (pagina === 0 ? r.linhas : [...antes, ...r.linhas]));
        setTemMais(r.temMais);
        setDisponivel(r.disponivel);
        if (f !== undefined) setFila(f);
        setErro(null);
        setCarregando(false);
      },
      (e: unknown) => {
        if (!atual) return;
        setErro(e instanceof Error ? e.message : "Não foi possível carregar a prospecção.");
        setCarregando(false);
      },
    );
    return () => {
      atual = false;
    };
  }, [autorizado, filtros, pagina, versao]);

  useEffect(() => {
    if (!liberaEm) return;
    const t = setInterval(() => {
      const n = Date.now();
      setAgora(n);
      if (n >= liberaEm) setLiberaEm(null);
    }, 1_000);
    return () => clearInterval(t);
  }, [liberaEm]);
  const aguardar = liberaEm ? Math.max(0, Math.ceil((liberaEm - agora) / 1_000)) : 0;
  const travado = executando !== null || aguardar > 0;

  const recarregar = () => {
    setCarregando(true);
    setPagina(0);
    setVersao((v) => v + 1);
  };

  const aplicarFiltros = (e: FormEvent) => {
    e.preventDefault();
    setCarregando(true);
    setPagina(0);
    setFiltros({ ...rascunho, valorMinimo: Math.max(rascunho.valorMinimo || 0, VALOR_MINIMO_PROSPECCAO) });
  };

  const executar = async (acao: "buscar" | "processar") => {
    setErroExecucao(null);
    setResultado(null);
    let de = buscaDe;
    let ate = buscaAte;
    if (acao === "buscar") {
      if (!tribunaisBusca.length) {
        setErroExecucao({ mensagem: "Escolha pelo menos um tribunal.", parcial: null });
        return;
      }
      // Sem datas: últimos 7 dias.
      const hoje = new Date();
      if (!ate) ate = chaveDia(hoje);
      if (!de) de = chaveDia(new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() - 7));
      const problema = conferirPeriodo(de, ate);
      if (problema) {
        setErroExecucao({ mensagem: problema, parcial: null });
        return;
      }
    }
    setExecutando(acao);
    try {
      const r = acao === "buscar"
        ? await buscarNovosProcessos({ tribunais: tribunaisBusca, de, ate, limite })
        : await processarFila();
      setResultado(r);
      recarregar();
    } catch (e) {
      if (e instanceof ErroProspeccao) {
        if (e.aguardeSegundos) {
          setAgora(Date.now());
          setLiberaEm(Date.now() + e.aguardeSegundos * 1_000);
        }
        setErroExecucao({ mensagem: e.message, parcial: e.parcial });
        // Parte do trabalho pode ter sido salva antes da falha: a lista é recarregada.
        recarregar();
      } else {
        setErroExecucao({ mensagem: e instanceof Error ? e.message : "Falha ao executar.", parcial: null });
      }
    } finally {
      setExecutando(null);
    }
  };

  const exportar = async () => {
    setExportando(true);
    setErroExportacao(null);
    try {
      const { linhas: todas, cortado } = await carregarParaExportar(filtros);
      if (!todas.length) {
        setAviso("Nada para exportar com estes filtros.");
        return;
      }
      await registrarExportacao(filtros, todas.length);
      baixarArquivo(gerarCsv(todas), `prospeccao-execucoes-${chaveDia(new Date())}.csv`);
      setAviso(cortado ? `Exportadas as ${MAX_EXPORTACAO} primeiras linhas (maior valor primeiro). Refine os filtros para o restante.` : `${todas.length} linha(s) exportada(s).`);
    } catch (e) {
      setErroExportacao(e instanceof Error ? e.message : "Falha ao exportar.");
    } finally {
      setExportando(false);
    }
  };

  if (!perfil) return null;
  if (!autorizado) {
    return (
      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-10">
        <p role="alert" className="flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-700 shadow-sm">
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-navy-700" aria-hidden />
          A prospecção de execuções fiscais está disponível apenas para sócios e advogados titulares.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2.5 text-2xl font-semibold tracking-tight text-navy-950">
            <Landmark className="size-6 text-navy-700" aria-hidden /> Prospecção de execuções fiscais
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-500">
            Execuções fiscais da Fazenda Nacional contra empresas (CNPJ) nos TRF1, TRF3 e TRF4, acima de R$ 100 mil, do maior valor para o menor.
            Fontes públicas: DataJud/CNJ, DJEN, Dados Abertos da PGFN e a base aberta de CNPJ da Receita.
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

      <p className="mt-4 rounded-lg bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-900 ring-1 ring-inset ring-amber-200">
        Uso interno. A lista serve para inteligência de mercado e públicos de anúncio. O Código de Ética da OAB e o Provimento 205/2021 vedam a captação
        de clientela: não faça abordagem ativa e individual (ligação, WhatsApp ou e-mail não solicitados) a partir destes dados. Exportações ficam registradas.
      </p>

      {/* ---------- Buscar processos novos ---------- */}
      <section aria-labelledby="titulo-busca" className="mt-8 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 id="titulo-busca" className="text-base font-semibold text-slate-900">Buscar processos novos</h2>
        <p className="mt-1 text-xs text-slate-500">
          Consulta o DataJud (classe 1116) pela data de ajuizamento, no máximo 31 dias por busca. Sem datas, usa os últimos 7 dias. Depois, cada processo
          é cruzado com o DJEN (partes, CNPJ e polo ativo) e a base de CNPJ (telefone e e-mail). Isso leva alguns minutos e roda em etapas.
        </p>
        <div className="mt-4 flex flex-wrap items-end gap-4">
          <fieldset className="flex gap-2">
            <legend className="mb-1 text-xs font-medium text-slate-600">Tribunais</legend>
            {TRIBUNAIS_PROSPECCAO.map((t) => (
              <label key={t} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-slate-700 ring-1 ring-inset ring-slate-200">
                <input type="checkbox" checked={tribunaisBusca.includes(t)} onChange={() => setTribunaisBusca((l) => alternar(l, t))} />
                {t}
              </label>
            ))}
          </fieldset>
          <label className="flex flex-col text-xs font-medium text-slate-600">
            Ajuizados de
            <input type="date" value={buscaDe} onChange={(e) => setBuscaDe(e.target.value)} className={`${campo} mt-1`} />
          </label>
          <label className="flex flex-col text-xs font-medium text-slate-600">
            até
            <input type="date" value={buscaAte} onChange={(e) => setBuscaAte(e.target.value)} className={`${campo} mt-1`} />
          </label>
          <label className="flex flex-col text-xs font-medium text-slate-600">
            Máx. por tribunal
            <input
              type="number"
              min={1}
              max={500}
              value={limite}
              onChange={(e) => setLimite(Math.min(500, Math.max(1, Number(e.target.value) || 1)))}
              className={`${campo} mt-1 w-28`}
            />
          </label>
          <button
            type="button"
            onClick={() => void executar("buscar")}
            disabled={travado}
            className="inline-flex items-center gap-2 rounded-lg bg-navy-900 px-4 py-2 text-sm font-semibold text-white hover:bg-navy-800 disabled:opacity-60"
          >
            {executando === "buscar" ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <Search className="size-4" aria-hidden />}
            Buscar no DataJud
          </button>
          <button
            type="button"
            onClick={() => void executar("processar")}
            disabled={travado}
            className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-navy-900 ring-1 ring-inset ring-navy-200 hover:bg-navy-50 disabled:opacity-60"
          >
            {executando === "processar" ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <Play className="size-4" aria-hidden />}
            Processar fila
          </button>
        </div>
        {executando && (
          <p role="status" className="mt-3 text-sm text-slate-600">
            Consultando as fontes públicas… pode levar até 2 minutos. Cada página recebida já é salva, mesmo que a fonte caia no meio.
          </p>
        )}
        {aguardar > 0 && !executando && (
          <p role="status" className="mt-3 text-sm text-slate-600">Limite de 6 execuções por minuto: liberado em {aguardar} s.</p>
        )}
        {resultado && !executando && <ResultadoExecucaoPainel r={resultado} />}
        {erroExecucao && !executando && (
          <div className="mt-3">
            <p role="alert" className="flex items-start gap-2 text-sm text-red-700">
              <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> {erroExecucao.mensagem}
            </p>
            {erroExecucao.parcial && (erroExecucao.parcial.novos || erroExecucao.parcial.consultados || erroExecucao.parcial.cnpjsEnriquecidos) ? (
              <p className="mt-1 text-xs text-slate-600">
                Salvo antes da falha: {erroExecucao.parcial.novos ?? 0} processo(s) novo(s), {erroExecucao.parcial.consultados ?? 0} consultado(s) no DJEN,{" "}
                {erroExecucao.parcial.cnpjsEnriquecidos ?? 0} contato(s).
              </p>
            ) : null}
            {erroExecucao.parcial?.avisos && <AvisosExecucao avisos={erroExecucao.parcial.avisos} />}
          </div>
        )}
        {fila && (
          <dl className="mt-4 grid gap-2 text-xs sm:grid-cols-3 lg:grid-cols-6">
            {(Object.keys(SITUACAO_LABEL) as SituacaoFila[]).map((s) => (
              <div key={s} className="rounded-lg bg-slate-50 px-3 py-2">
                <dt className="text-slate-500">{SITUACAO_LABEL[s]}</dt>
                <dd className="mt-0.5 text-base font-semibold tabular-nums text-slate-900">{fila[s]}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      {/* ---------- Filtros da lista ---------- */}
      <form onSubmit={aplicarFiltros} aria-label="Filtros" className="mt-8 flex flex-wrap items-end gap-4">
        <fieldset className="flex gap-2">
          <legend className="mb-1 text-xs font-medium text-slate-600">Tribunal</legend>
          {TRIBUNAIS_PROSPECCAO.map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={rascunho.tribunais.includes(t)}
              onClick={() => setRascunho((r) => ({ ...r, tribunais: alternar(r.tribunais, t) }))}
              className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
                rascunho.tribunais.includes(t) ? "bg-navy-900 text-white" : "bg-white text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-50"
              }`}
            >
              {t}
            </button>
          ))}
        </fieldset>
        <label className="flex flex-col text-xs font-medium text-slate-600">
          Origem
          <select
            value={rascunho.origem}
            onChange={(e) => setRascunho((r) => ({ ...r, origem: e.target.value as FiltrosProspeccao["origem"] }))}
            className={`${campo} mt-1`}
          >
            <option value="todas">Todas</option>
            <option value="processo">{ORIGEM_LABEL.processo}</option>
            <option value="pgfn">{ORIGEM_LABEL.pgfn}</option>
          </select>
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-600">
          Distribuídos de
          <input type="date" value={rascunho.de} onChange={(e) => setRascunho((r) => ({ ...r, de: e.target.value }))} className={`${campo} mt-1`} />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-600">
          até
          <input type="date" value={rascunho.ate} onChange={(e) => setRascunho((r) => ({ ...r, ate: e.target.value }))} className={`${campo} mt-1`} />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-600">
          Valor mínimo (R$)
          <input
            type="number"
            min={VALOR_MINIMO_PROSPECCAO}
            step={10000}
            value={rascunho.valorMinimo}
            onChange={(e) => setRascunho((r) => ({ ...r, valorMinimo: Number(e.target.value) }))}
            className={`${campo} mt-1 w-36`}
          />
        </label>
        <label className="flex min-w-56 flex-1 flex-col text-xs font-medium text-slate-600">
          Busca (nome, CNPJ ou nº do processo)
          <input
            type="search"
            value={rascunho.busca}
            maxLength={100}
            onChange={(e) => setRascunho((r) => ({ ...r, busca: e.target.value }))}
            className={`${campo} mt-1`}
          />
        </label>
        <button type="submit" className="inline-flex items-center gap-2 rounded-lg bg-navy-900 px-4 py-2 text-sm font-semibold text-white hover:bg-navy-800">
          <Search className="size-4" aria-hidden /> Filtrar
        </button>
        <button
          type="button"
          onClick={() => void exportar()}
          disabled={exportando || !linhas.length}
          className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-emerald-800 ring-1 ring-inset ring-emerald-200 hover:bg-emerald-50 disabled:opacity-60"
        >
          {exportando ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <FileDown className="size-4" aria-hidden />}
          Exportar CSV
        </button>
      </form>
      {erroExportacao && (
        <p role="alert" className="mt-2 flex items-start gap-2 text-sm text-red-700">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> {erroExportacao}
        </p>
      )}
      {(filtros.de || filtros.ate) && filtros.origem !== "processo" && (
        <p className="mt-2 text-xs text-slate-500">Com período definido, só aparecem processos: a base da PGFN não tem data de distribuição.</p>
      )}

      {/* ---------- Lista ---------- */}
      {!disponivel ? (
        <p className="mt-6 rounded-xl bg-amber-50 p-5 text-sm text-amber-900">A prospecção exige a migração 20261123_v11_prospeccao_execucoes.sql no Supabase.</p>
      ) : erro ? (
        <p role="alert" className="mt-6 flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800">
          <CircleAlert className="mt-0.5 size-5 shrink-0" aria-hidden /> {erro}
        </p>
      ) : carregando && linhas.length === 0 ? (
        <div className="flex justify-center py-24" role="status">
          <LoaderCircle className="size-6 animate-spin text-navy-700" aria-hidden />
          <span className="sr-only">Carregando…</span>
        </div>
      ) : (
        <section aria-label="Oportunidades" className="mt-6 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          {linhas.length === 0 ? (
            <p className="px-6 py-12 text-center text-sm text-slate-500">
              Nenhuma oportunidade com estes filtros. Busque processos novos acima ou importe a base da PGFN.
            </p>
          ) : (
            <table className="w-full min-w-[1100px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs font-medium text-slate-500">
                  <th scope="col" className="px-3 py-2.5 font-medium">CNPJ</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Nome</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Distribuição</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Polo ativo</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Processo</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Tribunal</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Valor</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Classe</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Contato</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {linhas.map((o) => (
                  <tr key={o.chave}>
                    <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-slate-700">
                      {formatarCnpj(o.cnpj)}
                      {o.cadastro_verificado === false && (
                        <span className="block text-[11px] text-slate-400" title="Ainda não conferido na base da Receita: natureza jurídica e contato chegam no próximo &quot;Processar fila&quot;.">
                          cadastro a conferir
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-slate-900">
                      {o.nome ?? "—"}
                      {o.situacao_cadastral && o.situacao_cadastral.toUpperCase() !== "ATIVA" && (
                        <span className="block text-xs text-amber-700">Situação na Receita: {o.situacao_cadastral}</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-slate-600">{formatarData(o.data_distribuicao) || "—"}</td>
                    <td className="px-3 py-2.5 text-slate-600">{o.polo_ativo ?? "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-slate-600">{formatarCnj(o.numero_processo) || "—"}</td>
                    <td className="px-3 py-2.5 text-slate-600">{o.tribunal ?? "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right font-medium tabular-nums text-slate-900">
                      {formatarMoeda(o.valor_causa)}
                      {o.valor_fonte && <span className="block text-[11px] font-normal text-slate-400">{VALOR_FONTE_LABEL[o.valor_fonte] ?? o.valor_fonte}</span>}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-slate-600">{o.classe ?? "—"}</td>
                    <td className="px-3 py-2.5 text-xs text-slate-600">
                      {o.telefone || o.email ? (
                        <>
                          {o.telefone && <span className="block">{o.telefone}</span>}
                          {o.email && <span className="block break-all">{o.email}</span>}
                        </>
                      ) : (
                        <span className="text-slate-400">Sem contato público</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {temMais && (
            <div className="border-t border-slate-100 p-3 text-center">
              <button
                type="button"
                disabled={carregando}
                onClick={() => {
                  setCarregando(true);
                  setPagina((p) => p + 1);
                }}
                className="rounded-lg px-4 py-1.5 text-sm font-medium text-navy-800 ring-1 ring-inset ring-slate-200 hover:bg-slate-50 disabled:opacity-60"
              >
                {carregando ? "Carregando…" : "Carregar mais"}
              </button>
            </div>
          )}
        </section>
      )}

      {aviso && <Toast mensagem={aviso} onFechar={fecharAviso} />}
    </main>
  );
}

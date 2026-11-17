"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { CalendarClock, CircleAlert, Copy, Info, LoaderCircle, Save, Sparkles } from "lucide-react";
import { useAuth } from "@/components/auth-provider";
import { Toast } from "@/components/toast";
import {
  DIAS_SEMANA,
  DURACOES_REUNIAO,
  ErroDisponibilidade,
  GRADE_SUGERIDA,
  GRADE_VAZIA,
  LIMITE_MAX_REUNIOES,
  buscarMinhaDisponibilidade,
  capacidadeDoDia,
  nomeDia,
  salvarMinhaDisponibilidade,
  validarGrade,
  type DisponibilidadeAdvogado,
  type DisponibilidadeRow,
  type GradeDisponibilidade,
  type HorarioDia,
} from "@/lib/disponibilidade";

const campo =
  "block w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition focus:border-navy-500 focus:ring-3 focus:ring-navy-500/15 disabled:bg-slate-50 disabled:text-slate-400";

const HORARIO_PADRAO = { hora_inicio: "09:00", hora_fim: "18:00" };

function gradeDe(d: DisponibilidadeAdvogado): GradeDisponibilidade {
  return { dias: d.dias, duracao_reuniao_min: d.duracao_reuniao_min, max_reunioes_dia: d.max_reunioes_dia };
}

function chave(g: GradeDisponibilidade) {
  const dias = [...g.dias].sort((a, b) => a.dia_semana - b.dia_semana);
  return JSON.stringify([dias, String(g.duracao_reuniao_min), String(g.max_reunioes_dia)]);
}

function rotuloDuracao(m: number) {
  if (m < 60) return `${m} minutos`;
  if (m === 60) return "1 hora";
  return `${String(m / 60).replace(".", ",")} horas`;
}

function Cartao({
  titulo,
  descricao,
  acao,
  children,
}: {
  titulo: string;
  descricao: string;
  acao?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">{titulo}</h2>
          <p className="mt-0.5 text-xs text-slate-500">{descricao}</p>
        </div>
        {acao}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export default function DisponibilidadePage() {
  // O layout de /painel só renderiza esta página com o perfil já carregado.
  const { perfil } = useAuth();

  const [grade, setGrade] = useState<GradeDisponibilidade>(GRADE_VAZIA);
  const [salva, setSalva] = useState<GradeDisponibilidade | null>(null);
  const [linhas, setLinhas] = useState<DisponibilidadeRow[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erroCarregar, setErroCarregar] = useState<{ mensagem: string; detalhe?: string } | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [erros, setErros] = useState<string[]>([]);
  const [sucesso, setSucesso] = useState<string | null>(null);
  const [versao, setVersao] = useState(0);
  const fecharToast = useCallback(() => setSucesso(null), []);

  useEffect(() => {
    if (!perfil) return;
    let atual = true;
    buscarMinhaDisponibilidade(perfil.id).then(
      (d) => {
        if (!atual) return;
        // Sem cadastro: formulário em branco para preencher (não é erro).
        if (d) {
          setGrade(gradeDe(d));
          setSalva(gradeDe(d));
          setLinhas(d.linhas);
        }
        setErroCarregar(null);
        setCarregando(false);
      },
      (e: unknown) => {
        if (!atual) return;
        console.error("Erro ao carregar disponibilidade:", e);
        setErroCarregar({
          mensagem:
            e instanceof ErroDisponibilidade && e.tabelaAusente
              ? "A tabela disponibilidade_advogados não foi encontrada no Supabase."
              : "Não foi possível carregar sua disponibilidade.",
          detalhe: e instanceof ErroDisponibilidade ? e.detalhe : e instanceof Error ? e.message : undefined,
        });
        setCarregando(false);
      },
    );
    return () => {
      atual = false;
    };
  }, [perfil, versao]);

  const alterado = salva === null || chave(grade) !== chave(salva);
  const diasOrdenados = useMemo(
    () =>
      DIAS_SEMANA.map(({ valor }) => grade.dias.find((d) => d.dia_semana === valor)).filter(
        (d): d is HorarioDia => Boolean(d),
      ),
    [grade.dias],
  );

  // Dia mais "apertado": onde cabem menos reuniões da duração escolhida.
  const menorCapacidade = useMemo(() => {
    if (!Number.isInteger(grade.duracao_reuniao_min)) return null;
    let menor: { dia: number; qtd: number } | null = null;
    for (const d of diasOrdenados) {
      const qtd = capacidadeDoDia(d, grade.duracao_reuniao_min);
      if (qtd > 0 && (!menor || qtd < menor.qtd)) menor = { dia: d.dia_semana, qtd };
    }
    return menor;
  }, [diasOrdenados, grade.duracao_reuniao_min]);

  function alternarDia(dia: number) {
    setGrade((g) => {
      if (g.dias.some((d) => d.dia_semana === dia)) {
        return { ...g, dias: g.dias.filter((d) => d.dia_semana !== dia) };
      }
      // Ao marcar, sugere o horário de outro dia já configurado (ou 09:00–18:00).
      const modelo = g.dias[0] ?? HORARIO_PADRAO;
      return { ...g, dias: [...g.dias, { dia_semana: dia, hora_inicio: modelo.hora_inicio, hora_fim: modelo.hora_fim }] };
    });
  }

  function alterarHorario(dia: number, campoHora: "hora_inicio" | "hora_fim", valor: string) {
    setGrade((g) => ({
      ...g,
      dias: g.dias.map((d) => (d.dia_semana === dia ? { ...d, [campoHora]: valor } : d)),
    }));
  }

  function copiarParaTodos() {
    const modelo = diasOrdenados[0];
    if (!modelo) return;
    setGrade((g) => ({
      ...g,
      dias: g.dias.map((d) => ({ ...d, hora_inicio: modelo.hora_inicio, hora_fim: modelo.hora_fim })),
    }));
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!perfil) return;
    const problemas = validarGrade(grade);
    setErros(problemas);
    if (problemas.length > 0) return;

    setSalvando(true);
    try {
      const resultado = await salvarMinhaDisponibilidade(perfil.id, grade, linhas);
      setGrade(gradeDe(resultado));
      setSalva(gradeDe(resultado));
      setLinhas(resultado.linhas);
      setSucesso("Disponibilidade salva com sucesso.");
    } catch (err) {
      setErros([err instanceof Error ? err.message : "Não foi possível salvar."]);
    } finally {
      setSalvando(false);
    }
  }

  if (!perfil) return null;

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-10">
      <h1 className="flex items-center gap-2.5 text-2xl font-semibold tracking-tight text-navy-950">
        <CalendarClock className="size-6 text-navy-700" aria-hidden />
        Minha disponibilidade
      </h1>
      <p className="mt-1 text-sm text-slate-500">
        Defina quando você atende. Esses dados orientam o agendamento e alertam sobre conflitos.
      </p>

      {carregando ? (
        <div className="flex items-center justify-center py-24" role="status">
          <LoaderCircle className="size-6 animate-spin text-navy-700" aria-hidden />
          <span className="sr-only">Carregando…</span>
        </div>
      ) : erroCarregar ? (
        <div role="alert" className="mt-8 flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800">
          <CircleAlert className="mt-0.5 size-5 shrink-0" aria-hidden />
          <div className="min-w-0">
            <p>{erroCarregar.mensagem}</p>
            {erroCarregar.detalhe && (
              <p className="mt-1 break-words font-mono text-xs text-red-700/80">Detalhe técnico: {erroCarregar.detalhe}</p>
            )}
            <button
              type="button"
              onClick={() => {
                setCarregando(true);
                setVersao((v) => v + 1);
              }}
              className="mt-2 font-medium underline underline-offset-2"
            >
              Tentar novamente
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="mt-8 space-y-5" noValidate>
          {salva === null && (
            <div className="flex flex-col gap-3 rounded-lg border border-navy-100 bg-navy-50 px-4 py-3 text-sm text-navy-800 sm:flex-row sm:items-center sm:justify-between">
              <p className="flex items-start gap-2.5">
                <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
                Você ainda não cadastrou sua disponibilidade. Preencha abaixo e salve.
              </p>
              <button
                type="button"
                onClick={() => setGrade(GRADE_SUGERIDA)}
                className="inline-flex shrink-0 items-center gap-1.5 self-start rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-navy-800 ring-1 ring-inset ring-navy-200 transition hover:bg-navy-100 sm:self-auto"
              >
                <Sparkles className="size-3.5" aria-hidden />
                Usar sugestão (seg–sex, 9h–18h)
              </button>
            </div>
          )}

          <Cartao
            titulo="Dias e horários de atendimento"
            descricao="Marque os dias em que você recebe clientes e o horário de cada um (horário de Brasília)."
            acao={
              diasOrdenados.length > 1 && (
                <button
                  type="button"
                  onClick={copiarParaTodos}
                  className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-navy-700 transition hover:bg-navy-50"
                >
                  <Copy className="size-3.5" aria-hidden />
                  Usar o horário de {nomeDia(diasOrdenados[0].dia_semana)} em todos
                </button>
              )
            }
          >
            <ul className="divide-y divide-slate-100">
              {DIAS_SEMANA.map(({ valor, longo }) => {
                const dia = grade.dias.find((d) => d.dia_semana === valor);
                const ativo = Boolean(dia);
                return (
                  <li key={valor} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center">
                    <label className="flex w-44 shrink-0 cursor-pointer items-center gap-3">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={ativo}
                        aria-label={`Atende ${longo}`}
                        onClick={() => alternarDia(valor)}
                        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition ${
                          ativo ? "bg-navy-900" : "bg-slate-300"
                        }`}
                      >
                        <span
                          className={`inline-block size-5 rounded-full bg-white shadow transition ${ativo ? "translate-x-5.5" : "translate-x-0.5"}`}
                        />
                      </button>
                      <span className={`text-sm font-medium capitalize ${ativo ? "text-slate-900" : "text-slate-400"}`}>
                        {longo}
                      </span>
                    </label>

                    {dia ? (
                      <div className="flex flex-1 items-center gap-2">
                        <input
                          type="time"
                          step={900}
                          aria-label={`Início de ${longo}`}
                          value={dia.hora_inicio}
                          onChange={(e) => alterarHorario(valor, "hora_inicio", e.target.value)}
                          className={campo}
                        />
                        <span className="text-sm text-slate-400">às</span>
                        <input
                          type="time"
                          step={900}
                          aria-label={`Término de ${longo}`}
                          value={dia.hora_fim}
                          onChange={(e) => alterarHorario(valor, "hora_fim", e.target.value)}
                          className={campo}
                        />
                      </div>
                    ) : (
                      <p className="flex-1 text-sm text-slate-400">Não atende</p>
                    )}
                  </li>
                );
              })}
            </ul>
          </Cartao>

          <Cartao titulo="Reuniões" descricao="Duração padrão de cada reunião e quantas são confortáveis por dia.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="duracao" className="block text-sm font-medium text-slate-700">Duração padrão</label>
                <select
                  id="duracao"
                  value={Number.isNaN(grade.duracao_reuniao_min) ? "" : grade.duracao_reuniao_min}
                  onChange={(e) => setGrade((g) => ({ ...g, duracao_reuniao_min: Number(e.target.value) }))}
                  className={`mt-1.5 ${campo}`}
                >
                  <option value="" disabled>Selecione…</option>
                  {!Number.isNaN(grade.duracao_reuniao_min) &&
                    !DURACOES_REUNIAO.includes(grade.duracao_reuniao_min as (typeof DURACOES_REUNIAO)[number]) && (
                      <option value={grade.duracao_reuniao_min}>{rotuloDuracao(grade.duracao_reuniao_min)}</option>
                    )}
                  {DURACOES_REUNIAO.map((m) => (
                    <option key={m} value={m}>{rotuloDuracao(m)}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="max-reunioes" className="block text-sm font-medium text-slate-700">
                  Máximo de reuniões por dia
                </label>
                <input
                  id="max-reunioes"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={LIMITE_MAX_REUNIOES}
                  placeholder="Ex.: 6"
                  value={Number.isNaN(grade.max_reunioes_dia) ? "" : grade.max_reunioes_dia}
                  onChange={(e) => setGrade((g) => ({ ...g, max_reunioes_dia: e.target.valueAsNumber }))}
                  className={`mt-1.5 ${campo}`}
                />
              </div>
            </div>

            {menorCapacidade && Number.isInteger(grade.max_reunioes_dia) && (
              <p
                className={`mt-4 flex items-start gap-2 rounded-lg px-3 py-2 text-xs ${
                  grade.max_reunioes_dia > menorCapacidade.qtd ? "bg-amber-50 text-amber-800" : "bg-slate-50 text-slate-600"
                }`}
              >
                <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {grade.max_reunioes_dia > menorCapacidade.qtd
                  ? `Na ${nomeDia(menorCapacidade.dia)} cabem só ${menorCapacidade.qtd} reuniões de ${grade.duracao_reuniao_min} min; o limite de ${grade.max_reunioes_dia} por dia não será alcançado nesse dia.`
                  : `Sua grade comporta o limite de ${grade.max_reunioes_dia} reuniões de ${grade.duracao_reuniao_min} min em todos os dias marcados.`}
              </p>
            )}
          </Cartao>

          {erros.length > 0 && (
            <div role="alert" className="flex items-start gap-2.5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <ul className="min-w-0 space-y-0.5 break-words">
                {erros.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex items-center justify-end gap-3">
            {alterado && salva !== null && <span className="text-xs text-slate-500">Alterações não salvas</span>}
            <button
              type="submit"
              disabled={salvando || !alterado}
              className="inline-flex items-center gap-2 rounded-lg bg-navy-900 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-navy-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {salvando ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <Save className="size-4" aria-hidden />}
              {salvando ? "Salvando…" : "Salvar disponibilidade"}
            </button>
          </div>
        </form>
      )}

      {sucesso && <Toast mensagem={sucesso} onFechar={fecharToast} />}
    </main>
  );
}

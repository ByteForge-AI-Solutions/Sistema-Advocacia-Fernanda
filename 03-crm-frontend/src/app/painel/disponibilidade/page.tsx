"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { CalendarClock, CircleAlert, Info, LoaderCircle, Save } from "lucide-react";
import { useAuth } from "@/components/auth-provider";
import { Toast } from "@/components/toast";
import {
  DIAS_SEMANA,
  DURACOES_REUNIAO,
  ErroDisponibilidade,
  GRADE_PADRAO,
  LIMITE_MAX_REUNIOES,
  buscarMinhaDisponibilidade,
  capacidadeDiaria,
  salvarMinhaDisponibilidade,
  validarGrade,
  type GradeDisponibilidade,
} from "@/lib/disponibilidade";

const campo =
  "block w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition focus:border-navy-500 focus:ring-3 focus:ring-navy-500/15";

function mesmaGrade(a: GradeDisponibilidade, b: GradeDisponibilidade) {
  return (
    [...a.dias_semana].sort().join() === [...b.dias_semana].sort().join() &&
    a.hora_inicio === b.hora_inicio &&
    a.hora_fim === b.hora_fim &&
    a.duracao_reuniao_min === b.duracao_reuniao_min &&
    a.max_reunioes_dia === b.max_reunioes_dia
  );
}

function Cartao({ titulo, descricao, children }: { titulo: string; descricao: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-sm font-semibold text-slate-900">{titulo}</h2>
      <p className="mt-0.5 text-xs text-slate-500">{descricao}</p>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export default function DisponibilidadePage() {
  // O layout de /painel só renderiza esta página com o perfil já carregado.
  const { perfil } = useAuth();

  const [grade, setGrade] = useState<GradeDisponibilidade>(GRADE_PADRAO);
  const [salva, setSalva] = useState<GradeDisponibilidade | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erroCarregar, setErroCarregar] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [erros, setErros] = useState<string[]>([]);
  const [sucesso, setSucesso] = useState<string | null>(null);
  const fecharToast = useCallback(() => setSucesso(null), []);

  useEffect(() => {
    if (!perfil) return;
    let atual = true;
    buscarMinhaDisponibilidade(perfil.id).then(
      (d) => {
        if (!atual) return;
        if (d) {
          const g: GradeDisponibilidade = {
            dias_semana: d.dias_semana,
            hora_inicio: d.hora_inicio,
            hora_fim: d.hora_fim,
            duracao_reuniao_min: d.duracao_reuniao_min,
            max_reunioes_dia: d.max_reunioes_dia,
          };
          setGrade(g);
          setSalva(g);
        }
        setCarregando(false);
      },
      (e: unknown) => {
        if (!atual) return;
        console.error("Erro ao carregar disponibilidade:", e);
        setErroCarregar(
          e instanceof ErroDisponibilidade && e.tabelaAusente
            ? "A tabela disponibilidade_advogados ainda não existe no Supabase. Rode a seção 7 do schema.sql."
            : "Não foi possível carregar sua disponibilidade. Recarregue a página.",
        );
        setCarregando(false);
      },
    );
    return () => {
      atual = false;
    };
  }, [perfil]);

  const capacidade = useMemo(() => capacidadeDiaria(grade), [grade]);
  const alterado = salva === null || !mesmaGrade(grade, salva);

  function alternarDia(dia: number) {
    setGrade((g) => ({
      ...g,
      dias_semana: g.dias_semana.includes(dia) ? g.dias_semana.filter((d) => d !== dia) : [...g.dias_semana, dia],
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
      await salvarMinhaDisponibilidade(perfil.id, grade);
      setSalva(grade);
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
          <p>{erroCarregar}</p>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="mt-8 space-y-5" noValidate>
          {salva === null && (
            <p className="flex items-start gap-2.5 rounded-lg border border-navy-100 bg-navy-50 px-4 py-3 text-sm text-navy-800">
              <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
              Você ainda não configurou sua disponibilidade. Sugerimos uma grade padrão; ajuste e salve.
            </p>
          )}

          <Cartao titulo="Dias de atendimento" descricao="Selecione os dias em que você recebe clientes.">
            <div role="group" aria-label="Dias da semana" className="flex flex-wrap gap-2">
              {DIAS_SEMANA.map(({ valor, curto, longo }) => {
                const ativo = grade.dias_semana.includes(valor);
                return (
                  <button
                    key={valor}
                    type="button"
                    onClick={() => alternarDia(valor)}
                    aria-pressed={ativo}
                    aria-label={longo}
                    className={`h-10 w-14 rounded-lg text-sm font-medium transition ${
                      ativo
                        ? "bg-navy-900 text-white shadow-sm"
                        : "bg-white text-slate-600 ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
                    }`}
                  >
                    {curto}
                  </button>
                );
              })}
            </div>
          </Cartao>

          <Cartao titulo="Horário de atendimento" descricao="Janela diária disponível para reuniões (horário de Brasília).">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="hora-inicio" className="block text-sm font-medium text-slate-700">Início</label>
                <input
                  id="hora-inicio"
                  type="time"
                  step={900}
                  required
                  value={grade.hora_inicio}
                  onChange={(e) => setGrade((g) => ({ ...g, hora_inicio: e.target.value }))}
                  className={`mt-1.5 ${campo}`}
                />
              </div>
              <div>
                <label htmlFor="hora-fim" className="block text-sm font-medium text-slate-700">Término</label>
                <input
                  id="hora-fim"
                  type="time"
                  step={900}
                  required
                  value={grade.hora_fim}
                  onChange={(e) => setGrade((g) => ({ ...g, hora_fim: e.target.value }))}
                  className={`mt-1.5 ${campo}`}
                />
              </div>
            </div>
          </Cartao>

          <Cartao titulo="Reuniões" descricao="Duração padrão de cada reunião e quantas são confortáveis por dia.">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="duracao" className="block text-sm font-medium text-slate-700">Duração padrão</label>
                <select
                  id="duracao"
                  value={grade.duracao_reuniao_min}
                  onChange={(e) => setGrade((g) => ({ ...g, duracao_reuniao_min: Number(e.target.value) }))}
                  className={`mt-1.5 ${campo}`}
                >
                  {!DURACOES_REUNIAO.includes(grade.duracao_reuniao_min as (typeof DURACOES_REUNIAO)[number]) && (
                    <option value={grade.duracao_reuniao_min}>{grade.duracao_reuniao_min} minutos</option>
                  )}
                  {DURACOES_REUNIAO.map((m) => (
                    <option key={m} value={m}>
                      {m < 60 ? `${m} minutos` : m === 60 ? "1 hora" : `${m / 60} horas`.replace(".5", ",5")}
                    </option>
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
                  required
                  value={Number.isNaN(grade.max_reunioes_dia) ? "" : grade.max_reunioes_dia}
                  onChange={(e) => setGrade((g) => ({ ...g, max_reunioes_dia: e.target.valueAsNumber }))}
                  className={`mt-1.5 ${campo}`}
                />
              </div>
            </div>

            {capacidade > 0 && (
              <p
                className={`mt-4 flex items-start gap-2 rounded-lg px-3 py-2 text-xs ${
                  grade.max_reunioes_dia > capacidade ? "bg-amber-50 text-amber-800" : "bg-slate-50 text-slate-600"
                }`}
              >
                <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {grade.max_reunioes_dia > capacidade
                  ? `Na sua janela cabem no máximo ${capacidade} reuniões de ${grade.duracao_reuniao_min} min. O limite de ${grade.max_reunioes_dia} por dia não será alcançado.`
                  : `Na sua janela cabem até ${capacidade} reuniões de ${grade.duracao_reuniao_min} min; o limite confortável é ${grade.max_reunioes_dia}.`}
              </p>
            )}
          </Cartao>

          {erros.length > 0 && (
            <div role="alert" className="flex items-start gap-2.5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <ul className="space-y-0.5">
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

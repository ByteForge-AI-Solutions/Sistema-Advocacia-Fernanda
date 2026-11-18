"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { CalendarPlus, CircleAlert, Info, LoaderCircle, Pencil, X } from "lucide-react";
import {
  AREAS_JURIDICAS,
  isAreaJuridica,
  type Advogado,
  type AreaJuridica,
  type MembroEquipe,
} from "@/lib/advogados";
import {
  STATUS_EVENTO,
  STATUS_EVENTO_LABEL,
  eventoCancelado,
  isStatusEvento,
  salvarReuniao,
  terminoDoEvento,
  type DadosReuniao,
  type EventoAgenda,
  type StatusEvento,
} from "@/lib/agenda";
import {
  chaveDia,
  deInputLocal,
  fmtHora,
  minutosDoDia,
  paraInputLocal,
  proximaHoraCheia,
  somarMinutos,
} from "@/lib/datas";
import {
  buscarDisponibilidades,
  nomeDia,
  paraMinutos,
  type DisponibilidadeAdvogado,
} from "@/lib/disponibilidade";
import {
  PRIORIDADES,
  PRIORIDADE_LABEL,
  STATUS_LABEL,
  buscarFichas,
  normalizar,
  paraPrioridade,
  type Ficha,
  type Prioridade,
} from "@/lib/fichas";

const DURACAO_PADRAO = 60;

interface FormReuniao {
  titulo_evento: string;
  ficha_id: string;
  advogado_id: string;
  area_juridica: AreaJuridica | "";
  prioridade: Prioridade;
  inicio: string;
  fim: string;
  status: StatusEvento;
}

interface Props {
  perfil: Advogado;
  /** Quem o usuário pode escolher como responsável: ele mesmo + estagiários supervisionados. */
  responsaveis: MembroEquipe[];
  /** Eventos já carregados na agenda (usados para avisos de conflito e limite diário). */
  eventos: EventoAgenda[];
  /** Ausente = nova reunião. */
  evento?: EventoAgenda;
  onFechar: () => void;
  onSalvo: (mensagem: string) => void;
}

const campo =
  "block w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition focus:border-navy-500 focus:ring-3 focus:ring-navy-500/15 disabled:bg-slate-50 disabled:text-slate-500";
const rotulo = "block text-sm font-medium text-slate-700";

const ESTILO_STATUS: Record<StatusEvento, string> = {
  agendado: "bg-sky-600 text-white",
  confirmado: "bg-navy-900 text-white",
  realizado: "bg-emerald-600 text-white",
  cancelado: "bg-slate-600 text-white",
};

function formInicial(perfil: Advogado, evento?: EventoAgenda): FormReuniao {
  if (evento) {
    const status = normalizar(evento.status);
    return {
      titulo_evento: evento.titulo_evento,
      ficha_id: evento.ficha_id ?? "",
      advogado_id: evento.advogado_id,
      area_juridica: isAreaJuridica(evento.area_juridica) ? evento.area_juridica : "",
      prioridade: paraPrioridade(evento.prioridade) ?? "media",
      inicio: paraInputLocal(evento.data_hora_inicio),
      fim: evento.data_hora_fim ? paraInputLocal(evento.data_hora_fim) : "",
      status: isStatusEvento(status) ? status : "agendado",
    };
  }
  const inicio = proximaHoraCheia();
  return {
    titulo_evento: "",
    ficha_id: "",
    advogado_id: perfil.id,
    area_juridica: perfil.areas_atuacao[0] ?? "",
    prioridade: "media",
    inicio: paraInputLocal(inicio),
    fim: paraInputLocal(somarMinutos(inicio, DURACAO_PADRAO)),
    status: "agendado",
  };
}

export function ReuniaoModal({ perfil, responsaveis, eventos, evento, onFechar, onSalvo }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const editando = Boolean(evento);

  const [form, setForm] = useState<FormReuniao>(() => formInicial(perfil, evento));
  // Enquanto o usuário não mexer no término, ele acompanha início + duração padrão.
  const [fimManual, setFimManual] = useState(editando);
  const [fichas, setFichas] = useState<Ficha[] | null>(null);
  const [erroFichas, setErroFichas] = useState(false);
  const [disponibilidades, setDisponibilidades] = useState<Map<string, DisponibilidadeAdvogado>>(new Map());
  const [erros, setErros] = useState<string[]>([]);
  const [salvando, setSalvando] = useState(false);

  // <dialog> nativo: foco preso no modal, Esc fecha, fundo inerte.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);

  useEffect(() => {
    let atual = true;
    buscarFichas(perfil).then(
      (lista) => atual && setFichas([...lista].sort((a, b) => a.nome_cliente.localeCompare(b.nome_cliente, "pt-BR"))),
      (e: unknown) => {
        console.error("Erro ao carregar fichas:", e);
        if (atual) {
          setFichas([]);
          setErroFichas(true);
        }
      },
    );
    // Sem grade configurada (ou tabela ausente) o formulário funciona normalmente, só sem avisos de grade.
    buscarDisponibilidades(responsaveis.map((r) => r.id)).then(
      (mapa) => atual && setDisponibilidades(mapa),
      (e: unknown) => console.warn("Disponibilidade indisponível:", e),
    );
    return () => {
      atual = false;
    };
  }, [perfil, responsaveis]);

  const duracaoDe = (advogadoId: string) => {
    const d = disponibilidades.get(advogadoId)?.duracao_reuniao_min;
    return d && Number.isInteger(d) && d > 0 ? d : DURACAO_PADRAO;
  };

  function definir<K extends keyof FormReuniao>(chave: K, valor: FormReuniao[K]) {
    setForm((f) => ({ ...f, [chave]: valor }));
  }

  function alterarInicio(valor: string) {
    setForm((f) => {
      const ini = deInputLocal(valor);
      const fimAtual = deInputLocal(f.fim);
      const recalcular = ini && (!fimManual || !fimAtual || fimAtual <= ini);
      return { ...f, inicio: valor, fim: recalcular ? paraInputLocal(somarMinutos(ini, duracaoDe(f.advogado_id))) : f.fim };
    });
  }

  function alterarResponsavel(advogadoId: string) {
    setForm((f) => {
      const ini = deInputLocal(f.inicio);
      return {
        ...f,
        advogado_id: advogadoId,
        fim: !fimManual && ini ? paraInputLocal(somarMinutos(ini, duracaoDe(advogadoId))) : f.fim,
      };
    });
  }

  /** Ao vincular uma ficha, sugere área, prioridade e título a partir dela. */
  function alterarFicha(fichaId: string) {
    const ficha = fichas?.find((x) => x.id === fichaId);
    setForm((f) => ({
      ...f,
      ficha_id: fichaId,
      ...(ficha && isAreaJuridica(ficha.area_identificada) ? { area_juridica: ficha.area_identificada } : {}),
      ...(ficha?.prioridade ? { prioridade: ficha.prioridade } : {}),
      ...(ficha && !f.titulo_evento.trim() ? { titulo_evento: `Reunião com ${ficha.nome_cliente}` } : {}),
    }));
  }

  // Avisos não bloqueiam o salvamento: só orientam sobre grade, limite diário e conflitos.
  const avisos = useMemo(() => {
    const ini = deInputLocal(form.inicio);
    if (!ini || form.status === "cancelado") return [];
    const fim = deInputLocal(form.fim);
    const fimEfetivo = fim && fim > ini ? fim : somarMinutos(ini, 1);
    const lista: string[] = [];
    const ehProprio = form.advogado_id === perfil.id;
    const nome = responsaveis.find((r) => r.id === form.advogado_id)?.nome.split(" ")[0] ?? "O responsável";

    const outros = eventos.filter(
      (e) => e.advogado_id === form.advogado_id && e.id !== evento?.id && !eventoCancelado(e.status),
    );

    const disp = disponibilidades.get(form.advogado_id);
    if (disp) {
      // Grade por dia: cada dia da semana tem sua própria janela de atendimento.
      const janela = disp.dias.find((d) => d.dia_semana === ini.getDay());
      if (!janela) {
        lista.push(`${ehProprio ? "Você não atende" : `${nome} não atende`} neste dia (${nomeDia(ini.getDay())}).`);
      } else {
        const foraDoHorario =
          minutosDoDia(ini) < paraMinutos(janela.hora_inicio) ||
          chaveDia(fimEfetivo) !== chaveDia(ini) ||
          minutosDoDia(fimEfetivo) > paraMinutos(janela.hora_fim);
        if (foraDoHorario) {
          lista.push(
            `Fora do horário de atendimento de ${nomeDia(ini.getDay())} (${janela.hora_inicio} às ${janela.hora_fim}).`,
          );
        }
      }
      const noDia = outros.filter((e) => chaveDia(new Date(e.data_hora_inicio)) === chaveDia(ini)).length;
      if (Number.isInteger(disp.max_reunioes_dia) && noDia >= disp.max_reunioes_dia) {
        lista.push(
          `Limite confortável de ${disp.max_reunioes_dia} reuniões por dia atingido: já há ${noDia} neste dia.`,
        );
      }
    }

    for (const e of outros) {
      const eIni = new Date(e.data_hora_inicio);
      const eFim = e.data_hora_fim ? terminoDoEvento(e) : somarMinutos(eIni, 1);
      if (eIni < fimEfetivo && eFim > ini) {
        lista.push(
          `Conflita com “${e.titulo_evento}” (${fmtHora.format(eIni)}${e.data_hora_fim ? `–${fmtHora.format(eFim)}` : ""}).`,
        );
      }
    }
    return lista;
  }, [form, eventos, evento, disponibilidades, responsaveis, perfil.id]);

  function validar(): string[] {
    const problemas: string[] = [];
    if (!form.titulo_evento.trim()) problemas.push("Informe o título da reunião.");
    if (!responsaveis.some((r) => r.id === form.advogado_id)) {
      problemas.push("Você só pode agendar para si mesmo ou para estagiários que supervisiona.");
    }
    if (!form.area_juridica) problemas.push("Selecione a área jurídica.");
    const ini = deInputLocal(form.inicio);
    const fim = deInputLocal(form.fim);
    if (!ini) problemas.push("Informe a data e hora de início.");
    if (!fim) problemas.push("Informe a data e hora de término.");
    if (ini && fim && fim <= ini) problemas.push("O término precisa ser depois do início.");
    return problemas;
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const problemas = validar();
    setErros(problemas);
    if (problemas.length > 0 || !form.area_juridica) return;

    const dados: DadosReuniao = {
      advogado_id: form.advogado_id,
      ficha_id: form.ficha_id || null,
      titulo_evento: form.titulo_evento.trim(),
      area_juridica: form.area_juridica,
      prioridade: form.prioridade,
      data_hora_inicio: deInputLocal(form.inicio)!.toISOString(),
      data_hora_fim: deInputLocal(form.fim)!.toISOString(),
      status: form.status,
    };

    setSalvando(true);
    try {
      await salvarReuniao(dados, evento?.id);
      onSalvo(editando ? "Reunião atualizada com sucesso." : "Reunião criada com sucesso.");
    } catch (err) {
      setErros([err instanceof Error ? err.message : "Não foi possível salvar a reunião."]);
      setSalvando(false);
    }
  }

  const fichaVinculadaOculta =
    form.ficha_id !== "" && fichas !== null && !fichas.some((f) => f.id === form.ficha_id);
  const unicoResponsavel = responsaveis.length <= 1;

  return (
    <dialog
      ref={dialogRef}
      onClose={onFechar}
      onClick={(e) => {
        if (e.target === dialogRef.current) onFechar();
      }}
      aria-labelledby="reuniao-titulo"
      className="m-auto max-h-[92vh] w-[calc(100%-2rem)] max-w-2xl overflow-hidden rounded-2xl bg-white p-0 shadow-2xl ring-1 ring-slate-900/10 backdrop:bg-navy-950/60 backdrop:backdrop-blur-sm"
    >
      <form onSubmit={handleSubmit} noValidate className="flex max-h-[92vh] flex-col">
        <header className="flex items-center justify-between gap-4 border-b border-slate-200 px-6 py-4">
          <div className="flex items-center gap-3">
            <span className="flex size-9 items-center justify-center rounded-lg bg-navy-50 text-navy-700">
              {editando ? <Pencil className="size-4.5" aria-hidden /> : <CalendarPlus className="size-4.5" aria-hidden />}
            </span>
            <h2 id="reuniao-titulo" className="text-lg font-semibold text-navy-950">
              {editando ? "Editar reunião" : "Nova reunião"}
            </h2>
          </div>
          <button
            type="button"
            onClick={onFechar}
            aria-label="Fechar"
            className="flex size-8 items-center justify-center rounded-md text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          {/* Status */}
          <fieldset>
            <legend className={rotulo}>Status</legend>
            <div className="mt-1.5 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
              {STATUS_EVENTO.map((s) => {
                const ativo = form.status === s;
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => definir("status", s)}
                    aria-pressed={ativo}
                    className={`rounded-lg px-3 py-2 text-sm font-medium transition ${
                      ativo ? `${ESTILO_STATUS[s]} shadow-sm` : "bg-white text-slate-600 ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
                    }`}
                  >
                    {STATUS_EVENTO_LABEL[s]}
                  </button>
                );
              })}
            </div>
          </fieldset>

          {/* Título */}
          <div>
            <label htmlFor="titulo" className={rotulo}>Título do evento</label>
            <input
              id="titulo"
              type="text"
              required
              maxLength={200}
              autoFocus={!editando}
              value={form.titulo_evento}
              onChange={(e) => definir("titulo_evento", e.target.value)}
              placeholder="Ex.: Primeira reunião – rescisão indireta"
              className={`mt-1.5 ${campo}`}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {/* Ficha */}
            <div>
              <label htmlFor="ficha" className={rotulo}>Cliente / ficha vinculada</label>
              <select
                id="ficha"
                value={form.ficha_id}
                disabled={fichas === null}
                onChange={(e) => alterarFicha(e.target.value)}
                className={`mt-1.5 ${campo}`}
              >
                <option value="">{fichas === null ? "Carregando fichas…" : "Sem ficha vinculada"}</option>
                {fichaVinculadaOculta && <option value={form.ficha_id}>Ficha vinculada (sem acesso)</option>}
                {fichas?.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.nome_cliente} · {isAreaJuridica(f.area_identificada) ? AREAS_JURIDICAS[f.area_identificada] : f.area_identificada}
                    {f.status === "finalizado" ? ` (${STATUS_LABEL.finalizado.toLowerCase()})` : ""}
                  </option>
                ))}
              </select>
              {erroFichas && <p className="mt-1 text-xs text-red-700">Não foi possível carregar as fichas.</p>}
            </div>

            {/* Responsável */}
            <div>
              <label htmlFor="responsavel" className={rotulo}>Advogado responsável</label>
              <select
                id="responsavel"
                value={form.advogado_id}
                disabled={unicoResponsavel}
                onChange={(e) => alterarResponsavel(e.target.value)}
                className={`mt-1.5 ${campo}`}
              >
                {responsaveis.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.id === perfil.id ? `${r.nome} (você)` : `${r.nome} · estagiário(a)`}
                  </option>
                ))}
              </select>
              {perfil.cargo === "estagiario" && (
                <p className="mt-1 text-xs text-slate-500">Estagiários agendam apenas para si.</p>
              )}
              {perfil.cargo === "desenvolvedor" && (
                <p className="mt-1 text-xs text-slate-500">Conta de teste: agenda apenas para si.</p>
              )}
            </div>

            {/* Área */}
            <div>
              <label htmlFor="area" className={rotulo}>Área jurídica</label>
              <select
                id="area"
                required
                value={form.area_juridica}
                onChange={(e) => definir("area_juridica", e.target.value as AreaJuridica)}
                className={`mt-1.5 ${campo}`}
              >
                <option value="" disabled>Selecione…</option>
                {(Object.keys(AREAS_JURIDICAS) as AreaJuridica[]).map((a) => (
                  <option key={a} value={a}>{AREAS_JURIDICAS[a]}</option>
                ))}
              </select>
            </div>

            {/* Prioridade */}
            <div>
              <label htmlFor="prioridade" className={rotulo}>Prioridade</label>
              <select
                id="prioridade"
                value={form.prioridade}
                onChange={(e) => definir("prioridade", e.target.value as Prioridade)}
                className={`mt-1.5 ${campo}`}
              >
                {PRIORIDADES.map((p) => (
                  <option key={p} value={p}>{PRIORIDADE_LABEL[p]}</option>
                ))}
              </select>
            </div>

            {/* Início / Fim */}
            <div>
              <label htmlFor="inicio" className={rotulo}>Início</label>
              <input
                id="inicio"
                type="datetime-local"
                required
                step={300}
                value={form.inicio}
                onChange={(e) => alterarInicio(e.target.value)}
                className={`mt-1.5 ${campo}`}
              />
            </div>
            <div>
              <label htmlFor="fim" className={rotulo}>Término</label>
              <input
                id="fim"
                type="datetime-local"
                required
                step={300}
                min={form.inicio || undefined}
                value={form.fim}
                onChange={(e) => {
                  setFimManual(true);
                  definir("fim", e.target.value);
                }}
                className={`mt-1.5 ${campo}`}
              />
            </div>
          </div>

          {avisos.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <p className="flex items-center gap-2 font-medium">
                <Info className="size-4 shrink-0" aria-hidden />
                Atenção antes de salvar
              </p>
              <ul className="mt-1.5 list-disc space-y-0.5 pl-6 text-amber-800">
                {avisos.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </div>
          )}

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
        </div>

        <footer className="flex flex-col-reverse gap-2 border-t border-slate-200 bg-slate-50 px-6 py-4 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onFechar}
            className="rounded-lg px-4 py-2.5 text-sm font-medium text-slate-600 transition hover:bg-slate-200/60"
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={salvando}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-navy-900 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-navy-800 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {salvando && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
            {salvando ? "Salvando…" : editando ? "Salvar alterações" : "Criar reunião"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}

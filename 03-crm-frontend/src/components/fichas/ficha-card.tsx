"use client";

import { useState } from "react";
import {
  CalendarClock,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Clock,
  FilePen,
  Gavel,
  LoaderCircle,
  Paperclip,
  Pencil,
  Wallet,
  Phone,
  UserRoundCheck,
} from "lucide-react";
import { EditarLeadModal } from "@/components/fichas/editar-lead-modal";
import { FichaClienteModal } from "@/components/clientes/ficha-cliente-modal";
import type { Advogado } from "@/lib/advogados";
import { TEMPERATURA_INFO, situacaoProximaAcao } from "@/lib/leads";
import { ETAPA_INFO, MOTIVO_PERDA_LABEL, etapaAtiva, horasAlemDoLimite, type EstadoCadencia } from "@/lib/funil";
import { GerarDocumentosModal } from "@/components/documentos/gerar-documentos-modal";
import { assumirFicha, type Ficha } from "@/lib/fichas";
import {
  AreaBadge,
  PRIORIDADE_ESTILO,
  PrioridadeBadge,
  SemResponsavelBadge,
  StatusBadge,
  VinculoBadge,
} from "@/components/fichas/badges";

const LIMITE_RESUMO = 240;

const formatoData = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const formatoRelativo = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });

function tempoDecorrido(iso: string): string {
  const minutos = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  if (Math.abs(minutos) < 60) return formatoRelativo.format(minutos, "minute");
  const horas = Math.round(minutos / 60);
  if (Math.abs(horas) < 24) return formatoRelativo.format(horas, "hour");
  return formatoRelativo.format(Math.round(horas / 24), "day");
}

/** 5511987654321 → +55 (11) 98765-4321. Outros formatos são exibidos como vieram. */
function formatarTelefone(telefone: string): string {
  const d = telefone.replace(/\D/g, "");
  const m = d.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `+55 (${m[1]}) ${m[2]}-${m[3]}` : telefone;
}

/** Mesmo critério do trigger crm_fichas_lead: só "finalizado" deixa de ser lead ativo. */
function finalizadaStatus(statusOriginal: string): boolean {
  return statusOriginal.trim().toLowerCase() === "finalizado";
}

function plural(n: number, singular: string, pluralForm: string) {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

/**
 * @param podeAssumir titular/sócio: mostra "Assumir" em fichas sem responsável.
 * @param onAlterada chamada depois de assumir, para recarregar a fila.
 */
export function FichaCard({
  ficha,
  podeAssumir = false,
  onAlterada,
  cadencia,
  perfil,
}: {
  ficha: Ficha;
  podeAssumir?: boolean;
  onAlterada?: () => void;
  /** Estado da cadência de follow-up (migração v6), calculado pela fila. */
  cadencia?: EstadoCadencia;
  /** Habilita "Cliente e honorários" (cadastro, financeiro e documentos, migração v7). */
  perfil?: Advogado;
}) {
  const [expandido, setExpandido] = useState(false);
  const [documentosAberto, setDocumentosAberto] = useState(false);
  const [assumindo, setAssumindo] = useState(false);
  const [erroAssumir, setErroAssumir] = useState<string | null>(null);
  const [editando, setEditando] = useState(false);
  const [clienteAberto, setClienteAberto] = useState(false);
  // Calculado uma vez na montagem: evita relógio na renderização (a fila recarrega a cada ação).
  const [parado] = useState(() => (ficha.funil.disponivel ? horasAlemDoLimite(ficha.funil) : 0));
  const semResponsavel = ficha.advogado_id === null;
  const temperatura = ficha.lead.temperatura ? TEMPERATURA_INFO[ficha.lead.temperatura] : null;
  const acao = ficha.lead.disponivel
    ? situacaoProximaAcao({
        proxima_acao_em: ficha.lead.proxima_acao_em,
        ativo: ficha.funil.disponivel ? etapaAtiva(ficha.funil.etapa) : !finalizadaStatus(ficha.status_original),
      })
    : null;

  function assumir() {
    setAssumindo(true);
    setErroAssumir(null);
    assumirFicha(ficha.id).then(
      () => {
        setAssumindo(false);
        onAlterada?.();
      },
      (e: unknown) => {
        setAssumindo(false);
        setErroAssumir(e instanceof Error ? e.message : "Não foi possível assumir a ficha.");
      },
    );
  }
  const resumoLongo = ficha.resumo_fatos.length > LIMITE_RESUMO;
  // A faixa lateral segue a cor do lead (urgente/quente/morno/frio) quando ele já foi qualificado.
  const faixa = ficha.lead.temperatura
    ? TEMPERATURA_INFO[ficha.lead.temperatura].ponto
    : ficha.prioridade
      ? PRIORIDADE_ESTILO[ficha.prioridade].faixa
      : "bg-slate-300";
  const finalizada = ficha.status === "finalizado";

  return (
    <article
      className={`relative overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition hover:shadow-md ${
        finalizada ? "opacity-75" : ""
      }`}
    >
      <span className={`absolute inset-y-0 left-0 w-1 ${faixa}`} aria-hidden />

      <div className="p-5 pl-6">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold text-slate-900">{ficha.nome_cliente}</h3>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {ficha.funil.disponivel && (
                <span
                  title={`Entra: ${ETAPA_INFO[ficha.funil.etapa].entra}. Sai: ${ETAPA_INFO[ficha.funil.etapa].sai}. Máx.: ${ETAPA_INFO[ficha.funil.etapa].tempoMaxLabel}.`}
                  className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${ETAPA_INFO[ficha.funil.etapa].cor}`}
                >
                  {ETAPA_INFO[ficha.funil.etapa].numero ? `${ETAPA_INFO[ficha.funil.etapa].numero}. ` : ""}
                  {ETAPA_INFO[ficha.funil.etapa].label}
                </span>
              )}
              {parado > 0 && (
                <span className="inline-flex items-center whitespace-nowrap rounded-full bg-red-600 px-2.5 py-0.5 text-xs font-semibold text-white">
                  Parado além do limite
                </span>
              )}
              {ficha.funil.nao_contatar && (
                <span className="inline-flex items-center whitespace-nowrap rounded-full bg-slate-800 px-2.5 py-0.5 text-xs font-semibold text-white">
                  Não contatar
                </span>
              )}
              <AreaBadge area={ficha.area_identificada} />
              {semResponsavel ? <SemResponsavelBadge /> : <VinculoBadge estagiario={ficha.estagiario} responsavel={ficha.responsavel} />}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-1.5 sm:justify-end">
            {temperatura && (
              <span
                title={`${temperatura.regra}. ${temperatura.acao}`}
                className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${temperatura.badge}`}
              >
                <span className={`size-2 rounded-full ${temperatura.ponto}`} aria-hidden />
                {temperatura.label}
              </span>
            )}
            <PrioridadeBadge prioridade={ficha.prioridade} />
            <StatusBadge status={ficha.status} original={ficha.status_original} />
          </div>
        </header>

        {semResponsavel && podeAssumir && (
          <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
            <p className="flex-1 text-sm text-amber-900">Esta ficha ainda não tem advogado responsável.</p>
            <button
              type="button"
              onClick={assumir}
              disabled={assumindo}
              className="inline-flex items-center gap-1.5 rounded-lg bg-navy-900 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-navy-800 disabled:opacity-60"
            >
              {assumindo ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : <UserRoundCheck className="size-3.5" aria-hidden />}
              Assumir ficha
            </button>
            {erroAssumir && <p role="alert" className="w-full text-xs text-red-700">{erroAssumir}</p>}
          </div>
        )}

        {ficha.funil.etapa === "perdido" && ficha.funil.motivo_perda && (
          <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-900">
            <strong>Motivo de perda:</strong> {MOTIVO_PERDA_LABEL[ficha.funil.motivo_perda]}
            {ficha.funil.motivo_perda_detalhe ? ` — ${ficha.funil.motivo_perda_detalhe}` : ""}
          </p>
        )}

        {cadencia?.tipo === "pendente" && (
          <p className={`mt-4 text-xs ${cadencia.situacao === "vencido" ? "font-semibold text-red-700" : "text-slate-500"}`}>
            Próximo toque: dia {cadencia.passo.dia} ({cadencia.indice + 1}/{cadencia.total}) · {formatoData.format(cadencia.devidoEm)} — {cadencia.passo.titulo}
            {cadencia.reiniciadaPorResposta ? " · reiniciada após resposta do lead" : ""}
          </p>
        )}
        {cadencia?.tipo === "pausada" && (
          <p className="mt-4 text-xs font-medium text-emerald-700">
            Lead respondeu em {formatoData.format(new Date(cadencia.respondeuEm))}: cadência pausada. Mova para &quot;{ETAPA_INFO[cadencia.sugestao].label}&quot;.
          </p>
        )}
        {cadencia?.tipo === "bloqueada" && (
          <p className="mt-4 text-xs text-slate-500">
            Cadência desligada: {cadencia.motivo === "nao_contatar" ? "cliente pediu para não ser contatado" : "cliente saiu da lista no WhatsApp (opt-out)"}.
          </p>
        )}

        {acao && (
          <div
            className={`mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg px-3 py-2 text-sm ${
              acao === "vencida"
                ? "bg-red-50 text-red-800 ring-1 ring-inset ring-red-200"
                : acao === "sem"
                  ? "bg-amber-50 text-amber-900 ring-1 ring-inset ring-amber-200"
                  : acao === "hoje"
                    ? "bg-navy-50 text-navy-900"
                    : "bg-slate-50 text-slate-700"
            }`}
          >
            <CalendarClock className="size-4 shrink-0" aria-hidden />
            {acao === "sem" ? (
              <span className="flex-1">
                <strong>Sem próxima ação.</strong> Defina o próximo passo para este lead não se perder.
              </span>
            ) : (
              <span className="min-w-0 flex-1">
                <strong>
                  {acao === "vencida" ? "Próxima ação vencida" : acao === "hoje" ? "Hoje" : "Próxima ação"}
                </strong>{" "}
                · {formatoData.format(new Date(ficha.lead.proxima_acao_em!))} — {ficha.lead.proxima_acao}
              </span>
            )}
          </div>
        )}

        {ficha.motivo_prioridade && (
          <p className="mt-4 flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-slate-400" aria-hidden />
            <span>{ficha.motivo_prioridade}</span>
          </p>
        )}

        <div className="mt-4">
          <p
            className={`whitespace-pre-line text-sm leading-relaxed text-slate-600 ${
              resumoLongo && !expandido ? "line-clamp-3" : ""
            }`}
          >
            {ficha.resumo_fatos}
          </p>
          {resumoLongo && (
            <button
              type="button"
              onClick={() => setExpandido((v) => !v)}
              aria-expanded={expandido}
              className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-navy-700 hover:text-navy-900"
            >
              {expandido ? (
                <>
                  Mostrar menos <ChevronUp className="size-3.5" aria-hidden />
                </>
              ) : (
                <>
                  Ler resumo completo <ChevronDown className="size-3.5" aria-hidden />
                </>
              )}
            </button>
          )}
        </div>

        <footer className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-slate-100 pt-4 text-xs text-slate-500">
          <span className="inline-flex items-center gap-1.5" title={formatoData.format(new Date(ficha.created_at))}>
            <Clock className="size-3.5" aria-hidden />
            Chegou {tempoDecorrido(ficha.created_at)} · {formatoData.format(new Date(ficha.created_at))}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Phone className="size-3.5" aria-hidden />
            {ficha.telefone.replace(/\D/g, "") ? formatarTelefone(ficha.telefone) : "Telefone não informado"}
          </span>
          {ficha.qtd_documentos > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <Paperclip className="size-3.5" aria-hidden />
              {plural(ficha.qtd_documentos, "documento", "documentos")}
            </span>
          )}
          {ficha.qtd_processos > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <Gavel className="size-3.5" aria-hidden />
              {plural(ficha.qtd_processos, "processo encontrado", "processos encontrados")}
            </span>
          )}
          {perfil && (
            <button
              type="button"
              onClick={() => setClienteAberto(true)}
              className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-navy-800 ring-1 ring-inset ring-navy-200 transition hover:bg-navy-50"
            >
              <Wallet className="size-3.5" aria-hidden />
              Cliente e honorários
            </button>
          )}
          {ficha.lead.disponivel && (
            <button
              type="button"
              onClick={() => setEditando(true)}
              className={`${perfil ? "" : "ml-auto "}inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-navy-800 ring-1 ring-inset ring-navy-200 transition hover:bg-navy-50`}
            >
              <Pencil className="size-3.5" aria-hidden />
              Editar lead
            </button>
          )}
          <button
            type="button"
            onClick={() => setDocumentosAberto(true)}
            className={`${ficha.lead.disponivel || perfil ? "" : "ml-auto "}inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-navy-800 ring-1 ring-inset ring-navy-200 transition hover:bg-navy-50`}
          >
            <FilePen className="size-3.5" aria-hidden />
            Gerar documentos
          </button>
        </footer>
        {documentosAberto && <GerarDocumentosModal fichaId={ficha.id} onFechar={() => setDocumentosAberto(false)} />}
        {clienteAberto && perfil && (
          <FichaClienteModal
            ficha={{ id: ficha.id, nome_cliente: ficha.nome_cliente, advogado_id: ficha.advogado_id }}
            perfil={perfil}
            onFechar={() => setClienteAberto(false)}
            onAlterada={onAlterada}
          />
        )}
        {editando && (
          <EditarLeadModal
            ficha={ficha}
            onFechar={() => setEditando(false)}
            onSalvo={() => {
              setEditando(false);
              onAlterada?.();
            }}
          />
        )}
      </div>
    </article>
  );
}

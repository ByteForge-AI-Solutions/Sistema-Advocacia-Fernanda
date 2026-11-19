"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, Hourglass, ListTodo, MessageCircleReply, Pencil, RotateCcw, UserRoundCheck } from "lucide-react";
import type { Advogado } from "@/lib/advogados";
import type { Ficha } from "@/lib/fichas";
import type { ContatoLead, EstadoCadencia, Tarefa, TipoTarefa } from "@/lib/funil";
import { TEMPERATURA_INFO } from "@/lib/leads";
import { EditarLeadModal } from "@/components/fichas/editar-lead-modal";
import { RegistrarToqueModal } from "@/components/fichas/registrar-toque-modal";

const fmt = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const LIMITE = 8;

const ICONE: Record<TipoTarefa, typeof ListTodo> = {
  toque: MessageCircleReply,
  respondeu: UserRoundCheck,
  proxima_acao: ListTodo,
  parado: Hourglass,
  reativavel: RotateCcw,
};

/**
 * Lista única do dia (documento, seção 7): o que vence hoje e o que está atrasado, em ordem
 * de prioridade. Atrasadas ficam no topo, em vermelho. Toques abrem o registro do follow-up;
 * as demais tarefas abrem a edição do lead (mudar etapa, motivo de perda, próxima ação).
 */
export function TarefasDoDia({
  tarefas,
  fichaPorId,
  estados,
  contatos,
  perfil,
  onAtualizar,
}: {
  tarefas: Tarefa[];
  fichaPorId: Map<string, Ficha>;
  estados: Map<string, EstadoCadencia>;
  contatos: Map<string, ContatoLead>;
  perfil: Advogado;
  onAtualizar: () => void;
}) {
  const [aberto, setAberto] = useState(true);
  const [todas, setTodas] = useState(false);
  const [toque, setToque] = useState<string | null>(null);
  const [editar, setEditar] = useState<string | null>(null);

  const vencidas = tarefas.filter((t) => t.vencida).length;
  const lista = todas ? tarefas : tarefas.slice(0, LIMITE);
  const fichaToque = toque ? fichaPorId.get(toque) : undefined;
  const estadoToque = toque ? estados.get(toque) : undefined;
  const fichaEditar = editar ? fichaPorId.get(editar) : undefined;

  return (
    <section aria-labelledby="tarefas-titulo" className="mt-6 rounded-xl border border-slate-200 bg-white shadow-sm">
      <button
        type="button"
        onClick={() => setAberto((v) => !v)}
        aria-expanded={aberto}
        className="flex w-full items-center gap-2 px-5 py-3.5 text-left"
      >
        <ListTodo className="size-5 text-navy-700" aria-hidden />
        <h2 id="tarefas-titulo" className="text-sm font-semibold text-slate-900">Tarefas do dia</h2>
        <span className="rounded-full bg-slate-100 px-2 text-xs tabular-nums text-slate-600">{tarefas.length}</span>
        {vencidas > 0 && <span className="rounded-full bg-red-600 px-2 text-xs font-semibold tabular-nums text-white">{vencidas} atrasada{vencidas > 1 ? "s" : ""}</span>}
        <span className="ml-auto text-slate-400">{aberto ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}</span>
      </button>

      {aberto && (
        <div className="border-t border-slate-100 px-3 pb-3">
          {tarefas.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-slate-500">Nada vencendo hoje. Bom trabalho!</p>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {lista.map((t) => {
                const f = fichaPorId.get(t.fichaId);
                if (!f) return null;
                const Icone = ICONE[t.tipo];
                const cor = f.lead.temperatura ? TEMPERATURA_INFO[f.lead.temperatura] : null;
                return (
                  <li
                    key={t.chave}
                    className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg px-3 py-2.5 ${
                      t.vencida ? "bg-red-50 ring-1 ring-inset ring-red-200" : "bg-slate-50"
                    }`}
                  >
                    <Icone className={`size-4 shrink-0 ${t.vencida ? "text-red-700" : "text-slate-500"}`} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-x-2 text-sm">
                        {cor && <span className={`size-2 shrink-0 rounded-full ${cor.ponto}`} title={cor.label} aria-label={`Prioridade ${cor.label}`} />}
                        <span className="font-semibold text-slate-900">{f.nome_cliente}</span>
                        <span className={t.vencida ? "text-red-800" : "text-slate-700"}>{t.titulo}</span>
                      </p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {t.vencida && <strong className="text-red-700">Atrasada · </strong>}
                        {t.quando && t.tipo !== "respondeu" ? `${fmt.format(t.quando)} · ` : ""}
                        {t.detalhe}
                      </p>
                    </div>
                    {t.tipo === "toque" ? (
                      <button
                        type="button"
                        onClick={() => setToque(f.id)}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-navy-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-navy-800"
                      >
                        <MessageCircleReply className="size-3.5" aria-hidden /> Registrar toque
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setEditar(f.id)}
                        className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-navy-800 ring-1 ring-inset ring-navy-200 hover:bg-navy-50"
                      >
                        <Pencil className="size-3.5" aria-hidden /> {t.tipo === "respondeu" ? "Mudar etapa" : "Editar lead"}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {tarefas.length > LIMITE && (
            <button type="button" onClick={() => setTodas((v) => !v)} className="mt-2 px-2 text-xs font-medium text-navy-700 hover:text-navy-900">
              {todas ? "Mostrar menos" : `Ver todas as ${tarefas.length} tarefas`}
            </button>
          )}
        </div>
      )}

      {fichaToque && estadoToque?.tipo === "pendente" && (
        <RegistrarToqueModal
          ficha={fichaToque}
          estado={estadoToque}
          contato={contatos.get(fichaToque.id)}
          perfil={perfil}
          onFechar={() => setToque(null)}
          onSalvo={() => {
            setToque(null);
            onAtualizar();
          }}
        />
      )}
      {fichaEditar && (
        <EditarLeadModal
          ficha={fichaEditar}
          onFechar={() => setEditar(null)}
          onSalvo={() => {
            setEditar(null);
            onAtualizar();
          }}
        />
      )}
    </section>
  );
}

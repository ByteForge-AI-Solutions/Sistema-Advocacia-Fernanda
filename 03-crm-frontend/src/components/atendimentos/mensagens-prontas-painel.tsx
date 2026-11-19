"use client";

import { useMemo, useState } from "react";
import { BookOpenText, ShieldCheck, X } from "lucide-react";
import { AREAS_JURIDICAS, isAreaJuridica } from "@/lib/advogados";
import {
  CATEGORIA_MENSAGEM_LABEL,
  mensagensParaArea,
  type CategoriaMensagem,
  type MensagemPronta,
} from "@/lib/mensagens-prontas";

const CATEGORIAS: CategoriaMensagem[] = ["primeiro_contato", "spin", "objecao", "especifica"];
const SPIN_LABEL = { S: "Situação", P: "Problema", I: "Implicação", N: "Necessidade" } as const;

/**
 * Biblioteca de mensagens prontas (SPIN + objeções) para o chat. Escolher uma mensagem a
 * coloca no campo de resposta, já com as variáveis preenchidas: nada é enviado sem revisão.
 */
export function MensagensProntasPainel({
  area,
  onEscolher,
  onFechar,
}: {
  area: string | null;
  onEscolher: (m: MensagemPronta) => void;
  onFechar: () => void;
}) {
  const [categoria, setCategoria] = useState<CategoriaMensagem>("primeiro_contato");
  const mensagens = useMemo(() => mensagensParaArea(area).filter((m) => m.categoria === categoria), [area, categoria]);

  return (
    <div role="dialog" aria-label="Mensagens prontas" className="mb-2 rounded-xl border border-slate-200 bg-white shadow-lg">
      <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2">
        <BookOpenText className="size-4 text-navy-700" aria-hidden />
        <p className="text-sm font-semibold text-slate-900">Mensagens prontas</p>
        <button type="button" onClick={onFechar} aria-label="Fechar mensagens prontas" className="ml-auto rounded-md p-1 text-slate-400 hover:bg-slate-100">
          <X className="size-4" />
        </button>
      </div>
      <div role="tablist" aria-label="Categoria" className="flex gap-1 overflow-x-auto px-3 pt-2">
        {CATEGORIAS.map((c) => (
          <button
            key={c}
            type="button"
            role="tab"
            aria-selected={categoria === c}
            onClick={() => setCategoria(c)}
            className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${
              categoria === c ? "bg-navy-900 text-white" : "text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-50"
            }`}
          >
            {CATEGORIA_MENSAGEM_LABEL[c]}
          </button>
        ))}
      </div>
      <ul className="max-h-64 space-y-1.5 overflow-y-auto p-3">
        {mensagens.map((m) => {
          const deOutraArea = m.areas && m.areas.length > 0 && !(area && m.areas.includes(area as never));
          return (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => onEscolher(m)}
                className={`block w-full rounded-lg px-3 py-2 text-left ring-1 ring-inset transition hover:bg-navy-50 ${deOutraArea ? "ring-slate-100 opacity-70" : "ring-slate-200"}`}
              >
                <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-slate-900">
                  {m.titulo}
                  {m.spin && (
                    <span className="rounded bg-navy-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-navy-800">
                      SPIN · {SPIN_LABEL[m.spin]}
                    </span>
                  )}
                  {m.areas?.map((a) => (
                    <span key={a} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
                      {isAreaJuridica(a) ? AREAS_JURIDICAS[a] : a}
                    </span>
                  ))}
                </span>
                <span className="mt-0.5 block text-xs text-slate-500">{m.uso}</span>
                <span className="mt-1 line-clamp-2 block whitespace-pre-line text-xs text-slate-600">{m.texto}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="flex items-start gap-1.5 border-t border-slate-100 px-3 py-2 text-[11px] leading-snug text-slate-500">
        <ShieldCheck className="mt-px size-3.5 shrink-0" aria-hidden />
        Uma pergunta por mensagem, sem preço ou percentual por escrito e sem promessa de resultado (OAB). Revise antes de enviar.
      </p>
    </div>
  );
}

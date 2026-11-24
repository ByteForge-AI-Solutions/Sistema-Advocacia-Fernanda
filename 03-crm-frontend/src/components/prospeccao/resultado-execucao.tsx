"use client";

import { Fragment } from "react";
import { CircleAlert, CircleCheck, TriangleAlert } from "lucide-react";
import type { AvisoExecucao, FimBuscaTribunal, ResultadoExecucao, TribunalProspeccao } from "@/lib/prospeccao";

const FIM_LABEL: Record<FimBuscaTribunal, string> = {
  fim: "busca completa",
  limite: "parou no máximo por tribunal",
  tempo: "parou por tempo (o que veio está salvo)",
  sobrecarga: "DataJud sobrecarregado (o que veio está salvo)",
  chave_recusada: "chave do DataJud recusada",
  sem_chave: "DATAJUD_API_KEY não configurada",
};

/** Mostra `comandos` da mensagem do servidor em fonte monoespaçada (texto puro, sem HTML). */
function TextoComCodigo({ texto }: { texto: string }) {
  return (
    <>
      {texto.split("`").map((parte, i) =>
        i % 2 === 1 ? (
          <code key={i} className="rounded bg-white/70 px-1 py-0.5 font-mono text-[12px] ring-1 ring-inset ring-slate-300">
            {parte}
          </code>
        ) : (
          <Fragment key={i}>{parte}</Fragment>
        ),
      )}
    </>
  );
}

export function AvisosExecucao({ avisos }: { avisos: AvisoExecucao[] }) {
  if (!avisos.length) return null;
  return (
    <ul className="mt-3 space-y-2">
      {avisos.map((a) => (
        <li
          key={a.codigo}
          role={a.gravidade === "erro" ? "alert" : "status"}
          className={`flex items-start gap-2 rounded-lg px-3 py-2 text-sm ring-1 ring-inset ${
            a.gravidade === "erro" ? "bg-red-50 text-red-800 ring-red-200" : "bg-amber-50 text-amber-900 ring-amber-200"
          }`}
        >
          {a.gravidade === "erro" ? (
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          ) : (
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          )}
          <span className="leading-relaxed">
            <TextoComCodigo texto={a.mensagem} />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Resumo objetivo de uma execução de "Buscar no DataJud" ou "Processar fila". */
export function ResultadoExecucaoPainel({ r }: { r: ResultadoExecucao }) {
  const tribunais = Object.entries(r.porTribunal) as [TribunalProspeccao, NonNullable<ResultadoExecucao["porTribunal"][TribunalProspeccao]>][];
  return (
    <div className="mt-3">
      <div role="status" className="flex items-start gap-2 text-sm text-slate-700">
        <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />
        <div className="space-y-1">
          {tribunais.length > 0 && (
            <p>
              <span className="font-medium">DataJud:</span>{" "}
              {tribunais.map(([t, p], i) => (
                <Fragment key={t}>
                  {i > 0 && " · "}
                  {t}: {p.recebidos} encontrado(s), {p.novos} novo(s) — {FIM_LABEL[p.fim] ?? p.fim}
                </Fragment>
              ))}
            </p>
          )}
          <p>
            <span className="font-medium">DJEN:</span> {r.consultados} consultado(s), {r.qualificados} qualificado(s)
            {r.foraDoFiltro > 0 && `, ${r.foraDoFiltro} fora do filtro`}
            {r.semPublicacao > 0 && `, ${r.semPublicacao} ainda sem publicação`}
            {r.semCnpj > 0 && `, ${r.semCnpj} sem CNPJ publicado`}
            {r.reagendados > 0 && `, ${r.reagendados} devolvido(s) à fila (fonte fora do ar, sem gastar tentativa)`}
            {r.erros > 0 && `, ${r.erros} com resposta fora do padrão`}.
          </p>
          <p>
            <span className="font-medium">Contatos (base de CNPJ):</span> {r.cnpjsEnriquecidos} CNPJ(s) atualizado(s).
            {r.pendentes ? ` ${r.pendentes} processo(s) ainda aguardam o DJEN.` : ""}
          </p>
        </div>
      </div>
      <AvisosExecucao avisos={r.avisos} />
    </div>
  );
}

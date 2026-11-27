"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { CircleAlert, LoaderCircle, UserPlus, X } from "lucide-react";
import {
  LIMITES,
  OPCOES_AREA,
  criarAtendimentoManual,
  validarAtendimento,
  type ErrosAtendimento,
  type NovoAtendimento,
} from "@/lib/atendimento-manual";

const VAZIO: NovoAtendimento = { nome: "", telefone: "", area: "", resumo: "" };
const campo =
  "mt-1.5 block w-full rounded-lg border bg-white px-3 py-2.5 text-sm text-slate-800 outline-none focus:border-navy-500 focus:ring-3 focus:ring-navy-500/15";

/**
 * Cadastro manual de atendimento (cliente que chegou por telefone, indicação ou balcão).
 * A ficha nasce com quem cadastrou como responsável, na etapa "Novo lead" e com a próxima
 * ação "Fazer o primeiro contato" para hoje (tudo decidido pela RPC no banco).
 */
export function NovoAtendimentoModal({ onFechar, onCriado }: { onFechar: () => void; onCriado: (id: string) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [dados, setDados] = useState<NovoAtendimento>(VAZIO);
  const [erros, setErros] = useState<ErrosAtendimento>({});
  const [erroGeral, setErroGeral] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);

  const mudar = <K extends keyof NovoAtendimento>(k: K, v: NovoAtendimento[K]) => {
    setDados((atual) => ({ ...atual, [k]: v }));
    if (erros[k]) setErros((e) => ({ ...e, [k]: undefined }));
  };

  async function salvar(e: FormEvent) {
    e.preventDefault();
    setErroGeral(null);
    const encontrados = validarAtendimento(dados);
    setErros(encontrados);
    if (Object.values(encontrados).some(Boolean)) return;
    setEnviando(true);
    try {
      const id = await criarAtendimentoManual(dados);
      onCriado(id);
    } catch (err) {
      setErroGeral(err instanceof Error ? err.message : "Não foi possível cadastrar o atendimento.");
    } finally {
      setEnviando(false);
    }
  }

  const borda = (k: keyof NovoAtendimento) => (erros[k] ? "border-red-400" : "border-slate-300");

  return (
    <dialog
      ref={ref}
      onClose={onFechar}
      aria-labelledby="novo-atendimento-titulo"
      className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-2xl bg-white p-6 shadow-2xl ring-1 ring-slate-900/10 backdrop:bg-navy-950/60"
    >
      <form onSubmit={(e) => void salvar(e)} noValidate>
        <div className="flex items-start justify-between gap-3">
          <h2 id="novo-atendimento-titulo" className="flex items-center gap-2 text-lg font-semibold text-navy-950">
            <UserPlus className="size-5 text-navy-700" aria-hidden /> Novo atendimento
          </h2>
          <button type="button" onClick={onFechar} aria-label="Fechar" className="rounded-md p-1 text-slate-400 hover:bg-slate-100">
            <X className="size-4" />
          </button>
        </div>
        <p className="mt-1.5 text-sm text-slate-500">
          Você fica como responsável e a ficha entra na fila como &quot;Novo lead&quot;, com o primeiro contato para hoje. Não informe CPF/CNPJ aqui:
          o documento vai no cadastro do cliente.
        </p>

        <label htmlFor="na-nome" className="mt-5 block text-sm font-medium text-slate-700">
          Nome do cliente <span className="text-red-600">*</span>
        </label>
        <input
          id="na-nome"
          value={dados.nome}
          onChange={(e) => mudar("nome", e.target.value)}
          maxLength={LIMITES.nomeMax}
          autoComplete="off"
          required
          aria-invalid={Boolean(erros.nome)}
          aria-describedby={erros.nome ? "na-nome-erro" : undefined}
          className={`${campo} ${borda("nome")}`}
        />
        {erros.nome && <p id="na-nome-erro" className="mt-1 text-xs text-red-700">{erros.nome}</p>}

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="na-telefone" className="block text-sm font-medium text-slate-700">
              Telefone / WhatsApp <span className="font-normal text-slate-400">(opcional)</span>
            </label>
            <input
              id="na-telefone"
              type="tel"
              inputMode="tel"
              value={dados.telefone}
              onChange={(e) => mudar("telefone", e.target.value)}
              maxLength={20}
              placeholder="(66) 99999-0000"
              autoComplete="off"
              aria-invalid={Boolean(erros.telefone)}
              aria-describedby={erros.telefone ? "na-telefone-erro" : undefined}
              className={`${campo} ${borda("telefone")}`}
            />
            {erros.telefone && <p id="na-telefone-erro" className="mt-1 text-xs text-red-700">{erros.telefone}</p>}
          </div>
          <div>
            <label htmlFor="na-area" className="block text-sm font-medium text-slate-700">
              Área jurídica <span className="text-red-600">*</span>
            </label>
            <select
              id="na-area"
              value={dados.area}
              onChange={(e) => mudar("area", e.target.value as NovoAtendimento["area"])}
              required
              aria-invalid={Boolean(erros.area)}
              aria-describedby={erros.area ? "na-area-erro" : undefined}
              className={`${campo} ${borda("area")}`}
            >
              <option value="">Selecione…</option>
              {OPCOES_AREA.map((o) => (
                <option key={o.valor} value={o.valor}>{o.label}</option>
              ))}
            </select>
            {erros.area && <p id="na-area-erro" className="mt-1 text-xs text-red-700">{erros.area}</p>}
          </div>
        </div>

        <label htmlFor="na-resumo" className="mt-4 block text-sm font-medium text-slate-700">
          Resumo inicial dos fatos / observações <span className="font-normal text-slate-400">(opcional)</span>
        </label>
        <textarea
          id="na-resumo"
          value={dados.resumo}
          onChange={(e) => mudar("resumo", e.target.value)}
          maxLength={LIMITES.resumoMax}
          rows={5}
          aria-invalid={Boolean(erros.resumo)}
          aria-describedby="na-resumo-ajuda"
          className={`${campo} ${borda("resumo")} resize-y`}
        />
        <p id="na-resumo-ajuda" className={`mt-1 text-xs ${erros.resumo ? "text-red-700" : "text-slate-400"}`}>
          {erros.resumo ?? `${dados.resumo.length}/${LIMITES.resumoMax}`}
        </p>

        {erroGeral && (
          <p role="alert" className="mt-4 flex items-start gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-800">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> {erroGeral}
          </p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onFechar} className="rounded-lg px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100">
            Cancelar
          </button>
          <button
            type="submit"
            disabled={enviando}
            className="inline-flex items-center gap-2 rounded-lg bg-navy-900 px-4 py-2 text-sm font-semibold text-white hover:bg-navy-800 disabled:opacity-50"
          >
            {enviando && <LoaderCircle className="size-4 animate-spin" aria-hidden />} Cadastrar atendimento
          </button>
        </div>
      </form>
    </dialog>
  );
}

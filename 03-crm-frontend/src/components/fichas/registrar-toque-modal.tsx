"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { CircleAlert, Copy, ExternalLink, LoaderCircle, MessageCircleReply, X } from "lucide-react";
import type { Advogado } from "@/lib/advogados";
import { deInputLocal, paraInputLocal } from "@/lib/datas";
import { lerDadosEscritorio } from "@/lib/documentos";
import type { Ficha } from "@/lib/fichas";
import {
  CANAL_LABEL,
  ETAPA_INFO,
  etapaAtiva,
  linkWhatsApp,
  proximoAposToque,
  registrarToque,
  textoProximaAcao,
  type CanalToque,
  type ContatoLead,
  type EstadoCadencia,
} from "@/lib/funil";
import { AVISO_DOCUMENTO, contemDocumentoPessoal } from "@/lib/leads";
import { avisosOab, mensagemPorId, preencherMensagem, variaveisPendentes } from "@/lib/mensagens-prontas";

const campo =
  "mt-1.5 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition focus:border-navy-500 focus:ring-3 focus:ring-navy-500/15";
const rotulo = "block text-sm font-medium text-slate-700";

type Pendente = Extract<EstadoCadencia, { tipo: "pendente" }>;

/**
 * Registra um toque da cadência: sugere a mensagem pronta do passo (com link wa.me),
 * pode avançar a etapa (ex.: 1ª mensagem → Primeiro contato) e já agenda o próximo toque
 * como próxima ação, tudo numa só transação (RPC crm_followup_registrar).
 */
export function RegistrarToqueModal({
  ficha,
  estado,
  contato,
  perfil,
  onFechar,
  onSalvo,
}: {
  ficha: Ficha;
  estado: Pendente;
  contato: ContatoLead | undefined;
  perfil: Advogado;
  onFechar: () => void;
  onSalvo: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const etapa = ficha.funil.etapa;
  const passo = estado.passo;
  const [canal, setCanal] = useState<CanalToque>(passo.canal);
  const [resultado, setResultado] = useState<"feito" | "pulado">("feito");
  const [nota, setNota] = useState("");
  const [avancar, setAvancar] = useState(Boolean(passo.avancaPara));
  const [mensagem, setMensagem] = useState(() => {
    const m = mensagemPorId(ficha.lead.temperatura === "urgente" && passo.dia === 0 && etapa === "novo_lead" ? "primeiro_contato_urgente" : passo.mensagemId);
    return m ? preencherMensagem(m.texto, { nome: ficha.nome_cliente, advogado: perfil.nome, oab: lerDadosEscritorio().advogado_oab }) : "";
  });
  const novaEtapa = avancar && passo.avancaPara ? passo.avancaPara : null;
  const etapaFinal = novaEtapa ?? etapa;

  const sugestao = useMemo(
    () => proximoAposToque({ funil: ficha.funil, temperatura: ficha.lead.temperatura }, estado, novaEtapa, contato),
    [ficha.funil, ficha.lead.temperatura, estado, novaEtapa, contato],
  );
  const [proxima, setProxima] = useState(() => (sugestao ? textoProximaAcao(sugestao.etapa, sugestao.passo) : ""));
  const [proximaEm, setProximaEm] = useState(() => (sugestao ? paraInputLocal(sugestao.devidoEm) : ""));
  const [erros, setErros] = useState<string[]>([]);
  const [salvando, setSalvando] = useState(false);
  const [copiado, setCopiado] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);

  /** Ao marcar/desmarcar "avançar etapa", a próxima ação sugerida acompanha. */
  function alternarAvanco(v: boolean) {
    setAvancar(v);
    const s = proximoAposToque({ funil: ficha.funil, temperatura: ficha.lead.temperatura }, estado, v && passo.avancaPara ? passo.avancaPara : null, contato);
    setProxima(s ? textoProximaAcao(s.etapa, s.passo) : "");
    setProximaEm(s ? paraInputLocal(s.devidoEm) : "");
  }

  const telefone = contato?.telefone ?? ficha.telefone;
  const pendentes = variaveisPendentes(mensagem);
  const oab = avisosOab(mensagem);
  const wa = mensagem && pendentes.length === 0 ? linkWhatsApp(telefone, mensagem) : null;
  const exigeProxima = etapaAtiva(etapaFinal);

  async function copiar() {
    try {
      await navigator.clipboard.writeText(mensagem);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2000);
    } catch {
      setCopiado(false);
    }
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const quando = deInputLocal(proximaEm);
    const problemas: string[] = [];
    if (exigeProxima && (!proxima.trim() || !quando)) problemas.push("Defina a próxima ação e a data: lead ativo não fica sem próximo passo.");
    if ([nota, proxima].some((t) => contemDocumentoPessoal(t))) problemas.push(AVISO_DOCUMENTO);
    setErros(problemas);
    if (problemas.length) return;
    setSalvando(true);
    try {
      await registrarToque({
        fichaId: ficha.id,
        etapa,
        passo: passo.dia,
        canal,
        resultado,
        nota: nota.trim() || null,
        novaEtapa,
        proximaAcao: proxima.trim() || null,
        proximaAcaoEm: quando ? quando.toISOString() : null,
      });
      onSalvo();
    } catch (err) {
      setErros([err instanceof Error ? err.message : "Não foi possível registrar."]);
      setSalvando(false);
    }
  }

  return (
    <dialog
      ref={ref}
      onClose={onFechar}
      aria-labelledby="toque-titulo"
      className="m-auto max-h-[92vh] w-[calc(100%-2rem)] max-w-xl overflow-hidden rounded-2xl bg-white p-0 shadow-2xl ring-1 ring-slate-900/10 backdrop:bg-navy-950/60"
    >
      <form onSubmit={handleSubmit} noValidate className="flex max-h-[92vh] flex-col">
        <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-6 py-4">
          <div className="min-w-0">
            <h2 id="toque-titulo" className="flex items-center gap-2 text-lg font-semibold text-navy-950">
              <MessageCircleReply className="size-5 text-navy-700" aria-hidden /> Follow-up · dia {passo.dia}
            </h2>
            <p className="truncate text-sm text-slate-500">
              {ficha.nome_cliente} · {ETAPA_INFO[etapa].label} · toque {estado.indice + 1} de {estado.total}
            </p>
          </div>
          <button type="button" onClick={onFechar} aria-label="Fechar" className="rounded-md p-1 text-slate-400 hover:bg-slate-100">
            <X className="size-4" />
          </button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <p className="rounded-lg bg-navy-50 px-3 py-2 text-sm text-navy-900">{passo.titulo}</p>

          <div>
            <label htmlFor="toque-msg" className={rotulo}>Mensagem {passo.mensagemId ? "sugerida" : "(opcional)"}</label>
            <textarea id="toque-msg" rows={6} value={mensagem} onChange={(e) => setMensagem(e.target.value)} className={campo} placeholder="Escreva a mensagem do toque, se for por texto." />
            {pendentes.length > 0 && (
              <p className="mt-1 text-xs text-amber-800">Complete antes de enviar: {pendentes.join(", ")}.</p>
            )}
            {oab.map((a) => (
              <p key={a} className="mt-1 flex items-start gap-1.5 text-xs text-red-800">
                <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden /> {a}
              </p>
            ))}
            {mensagem && (
              <div className="mt-2 flex flex-wrap gap-2">
                {wa && (
                  <a
                    href={wa}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
                  >
                    <ExternalLink className="size-3.5" aria-hidden /> Abrir no WhatsApp
                  </a>
                )}
                <button type="button" onClick={() => void copiar()} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50">
                  <Copy className="size-3.5" aria-hidden /> {copiado ? "Copiado" : "Copiar"}
                </button>
              </div>
            )}
            <p className="mt-1.5 text-[11px] text-slate-500">
              O link abre o WhatsApp de quem atende com o texto pronto; depois de enviar, registre o toque aqui.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="toque-canal" className={rotulo}>Canal</label>
              <select id="toque-canal" value={canal} onChange={(e) => setCanal(e.target.value as CanalToque)} className={campo}>
                {(Object.keys(CANAL_LABEL) as CanalToque[]).map((c) => (
                  <option key={c} value={c}>{CANAL_LABEL[c]}</option>
                ))}
              </select>
            </div>
            <fieldset>
              <legend className={rotulo}>Resultado</legend>
              <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                {(["feito", "pulado"] as const).map((r) => (
                  <button
                    key={r}
                    type="button"
                    aria-pressed={resultado === r}
                    onClick={() => setResultado(r)}
                    className={`rounded-lg px-2 py-2.5 text-sm font-medium transition ${
                      resultado === r ? "bg-navy-900 text-white" : "bg-white text-slate-600 ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
                    }`}
                  >
                    {r === "feito" ? "Toque feito" : "Pular toque"}
                  </button>
                ))}
              </div>
            </fieldset>
          </div>

          <div>
            <label htmlFor="toque-nota" className={rotulo}>Nota (opcional)</label>
            <input id="toque-nota" maxLength={500} value={nota} onChange={(e) => setNota(e.target.value)} placeholder="Ex.: ligou, caixa postal" className={campo} />
          </div>

          {passo.avancaPara && (
            <label className="flex items-start gap-2.5 text-sm text-slate-800">
              <input type="checkbox" checked={avancar} onChange={(e) => alternarAvanco(e.target.checked)} className="mt-0.5 size-4 rounded border-slate-300 text-navy-700" />
              <span>
                Mover para <strong>{ETAPA_INFO[passo.avancaPara].label}</strong>
                <span className="block text-xs text-slate-500">{ETAPA_INFO[passo.avancaPara].entra}.</span>
              </span>
            </label>
          )}

          <div className="grid gap-4 sm:grid-cols-[1fr_14rem]">
            <div>
              <label htmlFor="toque-proxima" className={rotulo}>
                Próxima ação {exigeProxima && <span className="text-red-600" aria-hidden>*</span>}
              </label>
              <input id="toque-proxima" maxLength={280} value={proxima} onChange={(e) => setProxima(e.target.value)} className={campo} placeholder={sugestao ? "" : "Cadência concluída: defina o próximo passo"} />
            </div>
            <div>
              <label htmlFor="toque-proxima-em" className={rotulo}>Data</label>
              <input id="toque-proxima-em" type="datetime-local" value={proximaEm} onChange={(e) => setProximaEm(e.target.value)} className={campo} />
            </div>
          </div>
          {!sugestao && exigeProxima && (
            <p className="text-xs text-amber-800">
              Esta foi a última mensagem da cadência. Defina o próximo passo ou mude a etapa (ex.: Sem resposta ou Perdido, com motivo) em &quot;Editar lead&quot;.
            </p>
          )}

          {erros.length > 0 && (
            <div role="alert" className="flex items-start gap-2.5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <ul className="space-y-0.5">{erros.map((e) => <li key={e}>{e}</li>)}</ul>
            </div>
          )}
        </div>

        <footer className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-6 py-4">
          <button type="button" onClick={onFechar} className="rounded-lg px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-200/60">
            Cancelar
          </button>
          <button type="submit" disabled={salvando} className="inline-flex items-center gap-2 rounded-lg bg-navy-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-navy-800 disabled:opacity-60">
            {salvando && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
            Registrar toque
          </button>
        </footer>
      </form>
    </dialog>
  );
}

"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  ArrowLeft,
  ArrowRightLeft,
  Bot,
  CircleAlert,
  CircleCheckBig,
  Clock3,
  LoaderCircle,
  Lock,
  PanelRight,
  Send,
  StickyNote,
  UserRoundCheck,
} from "lucide-react";
import {
  conversaEncerrada,
  estiloStatusConversa,
  formatarTelefoneBr,
  janela24hAberta,
  rotuloStatusConversa,
  type Atendimento,
  type Conversa,
} from "@/lib/atendimentos";

type ItemLinha =
  | { tipo: "msg"; id: string; quando: string; direcao: "IN" | "OUT"; texto: string; autor: string; humano: boolean }
  | { tipo: "nota"; id: string; quando: string; texto: string; autor: string; sistema: boolean }
  | { tipo: "saida"; id: string; quando: string; texto: string; autor: string; status: string };

const fmtHora = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export type AcaoConversa = "assumir" | "devolver" | "encerrar" | "transferir";

export function JanelaChat({
  atendimento,
  conversa,
  nomes,
  meuId,
  ocupado,
  erro,
  onAcao,
  onEnviar,
  onVoltar,
  onAbrirPainel,
}: {
  atendimento: Atendimento;
  conversa: Conversa | null;
  nomes: Map<string, string>;
  meuId: string;
  ocupado: boolean;
  erro: string | null;
  onAcao: (acao: AcaoConversa) => void;
  onEnviar: (texto: string, modo: "resposta" | "nota") => Promise<boolean>;
  onVoltar: () => void;
  onAbrirPainel: () => void;
}) {
  const [modo, setModo] = useState<"resposta" | "nota">("resposta");
  const [texto, setTexto] = useState("");
  const [enviando, setEnviando] = useState(false);
  const fimRef = useRef<HTMLDivElement>(null);

  const nomeAutor = (id: string | null) => (id === meuId ? "Você" : (id && nomes.get(id)?.split(" ")[0]) || "Equipe");

  const linha = useMemo<ItemLinha[]>(() => {
    if (!conversa) return [];
    const enviadasPorProvider = new Map(
      conversa.saidas.filter((s) => s.provider_id).map((s) => [s.provider_id as string, s]),
    );
    const providersExibidos = new Set<string>();
    const itens: ItemLinha[] = conversa.mensagens.map((m) => {
      const humana = m.provider_id ? enviadasPorProvider.get(m.provider_id) : undefined;
      if (m.provider_id) providersExibidos.add(m.provider_id);
      return {
        tipo: "msg",
        id: `m${m.id}`,
        quando: m.criado_em,
        direcao: m.direcao,
        texto: m.conteudo,
        autor: m.direcao === "IN" ? "Cliente" : humana ? nomeAutor(humana.autor_advogado_id) : "Assistente virtual",
        humano: Boolean(humana),
      };
    });
    for (const n of conversa.notas) {
      itens.push({ tipo: "nota", id: `n${n.id}`, quando: n.criado_em, texto: n.texto, autor: nomeAutor(n.autor_id), sistema: n.sistema });
    }
    for (const s of conversa.saidas) {
      // Enviadas aparecem como mensagem OUT (dfu_marcar_saida); aqui só o que ainda não saiu ou falhou.
      if (s.status === "ENVIADO" && s.provider_id && providersExibidos.has(s.provider_id)) continue;
      itens.push({ tipo: "saida", id: `s${s.id}`, quando: s.criado_em, texto: s.texto, autor: nomeAutor(s.autor_advogado_id), status: s.status });
    }
    return itens.sort((a, b) => new Date(a.quando).getTime() - new Date(b.quando).getTime());
    // nomeAutor depende de nomes/meuId
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversa, nomes, meuId]);

  useEffect(() => {
    fimRef.current?.scrollIntoView({ block: "end" });
  }, [linha.length, atendimento.telefone]);

  const status = atendimento.status;
  const optout = atendimento.bloqueado || status === "descadastrado";
  const humano = status === "humano";
  const janelaAberta = janela24hAberta(atendimento);
  const podeResponder = humano && !optout && janelaAberta;

  async function enviar() {
    const limpo = texto.trim();
    if (!limpo || enviando) return;
    if (modo === "resposta" && !podeResponder) return;
    setEnviando(true);
    const ok = await onEnviar(limpo, modo);
    setEnviando(false);
    if (ok) setTexto("");
  }

  function aoTeclar(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void enviar();
    }
  }

  const botao = "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:opacity-50";

  return (
    <section aria-label="Conversa" className="flex min-h-0 min-w-0 flex-1 flex-col bg-slate-50">
      <header className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-3">
        <button type="button" onClick={onVoltar} aria-label="Voltar para a lista" className="rounded-md p-1 text-slate-500 hover:bg-slate-100 lg:hidden">
          <ArrowLeft className="size-5" />
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold text-slate-900">{atendimento.nome_cliente || "Cliente não identificado"}</h2>
          <p className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            {formatarTelefoneBr(atendimento.telefone)}
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${estiloStatusConversa(status)}`}>
              {rotuloStatusConversa(status)}
            </span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {!humano && !optout && (
            <button type="button" disabled={ocupado} onClick={() => onAcao("assumir")} className={`${botao} bg-navy-900 text-white hover:bg-navy-800`}>
              <UserRoundCheck className="size-4" aria-hidden />
              {conversaEncerrada(status) || status === "agendado" ? "Reabrir" : "Assumir"}
            </button>
          )}
          {humano && (
            <button type="button" disabled={ocupado} onClick={() => onAcao("devolver")} className={`${botao} text-violet-700 ring-1 ring-inset ring-violet-200 hover:bg-violet-50`}>
              <Bot className="size-4" aria-hidden /> Devolver ao bot
            </button>
          )}
          {atendimento.advogado_id && !optout && (
            <button type="button" disabled={ocupado} onClick={() => onAcao("transferir")} className={`${botao} text-slate-700 ring-1 ring-inset ring-slate-200 hover:bg-slate-50`}>
              <ArrowRightLeft className="size-4" aria-hidden /> Transferir
            </button>
          )}
          {!conversaEncerrada(status) && (
            <button type="button" disabled={ocupado} onClick={() => onAcao("encerrar")} className={`${botao} text-emerald-700 ring-1 ring-inset ring-emerald-200 hover:bg-emerald-50`}>
              <CircleCheckBig className="size-4" aria-hidden /> Resolver
            </button>
          )}
          <button type="button" onClick={onAbrirPainel} aria-label="Dados do cliente" className="rounded-md p-1.5 text-slate-500 ring-1 ring-inset ring-slate-200 hover:bg-slate-50 xl:hidden">
            <PanelRight className="size-4" />
          </button>
        </div>
      </header>

      {erro && (
        <p role="alert" className="flex items-start gap-2 border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> {erro}
        </p>
      )}
      {conversa?.recursosV3Indisponiveis && (
        <p className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">
          Notas internas e respostas humanas precisam da migração 20261118_v3_crm_modulos.sql no Supabase.
        </p>
      )}

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-5">
        {!conversa && (
          <div className="flex justify-center py-10" role="status">
            <LoaderCircle className="size-6 animate-spin text-navy-700" aria-hidden />
            <span className="sr-only">Carregando conversa…</span>
          </div>
        )}
        {conversa && linha.length === 0 && <p className="py-10 text-center text-sm text-slate-500">Sem mensagens ainda.</p>}
        {linha.map((item) => {
          if (item.tipo === "nota") {
            return item.sistema ? (
              <p key={item.id} className="text-center text-xs text-slate-500">
                <span className="rounded-full bg-white px-3 py-1 ring-1 ring-slate-200">
                  {item.autor} · {item.texto} · {fmtHora.format(new Date(item.quando))}
                </span>
              </p>
            ) : (
              <div key={item.id} className="mx-auto max-w-[85%] rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
                <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-amber-800">
                  <Lock className="size-3" aria-hidden /> Nota interna · {item.autor}
                </p>
                <p className="whitespace-pre-wrap break-words">{item.texto}</p>
                <p className="mt-1.5 text-right text-[11px] text-amber-700/70">{fmtHora.format(new Date(item.quando))}</p>
              </div>
            );
          }
          const saida = item.tipo === "saida";
          const deFora = item.tipo === "msg" && item.direcao === "IN";
          const humanoEquipe = saida || (item.tipo === "msg" && item.humano);
          return (
            <div
              key={item.id}
              className={`max-w-[85%] rounded-2xl p-3 text-sm shadow-sm ${
                deFora
                  ? "mr-auto rounded-bl-sm bg-white text-slate-800"
                  : humanoEquipe
                    ? "ml-auto rounded-br-sm bg-navy-900 text-white"
                    : "ml-auto rounded-br-sm bg-violet-100 text-slate-900"
              } ${saida && item.status === "BLOQUEADO" ? "opacity-60" : ""}`}
            >
              <p className={`mb-1 flex items-center gap-1 text-xs font-semibold ${humanoEquipe ? "text-navy-200" : deFora ? "text-slate-500" : "text-violet-700"}`}>
                {!deFora && !humanoEquipe && <Bot className="size-3" aria-hidden />}
                {item.autor}
              </p>
              <p className="whitespace-pre-wrap break-words">{item.texto}</p>
              <p className={`mt-1.5 flex items-center justify-end gap-1 text-[11px] ${humanoEquipe ? "text-navy-200" : "text-slate-400"}`}>
                {saida && item.status === "PENDENTE" && (<><Clock3 className="size-3" aria-hidden /> na fila de envio ·</>)}
                {saida && item.status === "AMBIGUO" && (<><Clock3 className="size-3" aria-hidden /> enviando ·</>)}
                {saida && item.status === "BLOQUEADO" && <span className="font-medium text-red-300">não enviada ·</span>}
                {fmtHora.format(new Date(item.quando))}
              </p>
            </div>
          );
        })}
        <div ref={fimRef} />
      </div>

      <footer className="border-t border-slate-200 bg-white p-3">
        <div role="tablist" aria-label="Tipo de mensagem" className="mb-2 flex gap-1">
          <button
            type="button"
            role="tab"
            aria-selected={modo === "resposta"}
            onClick={() => setModo("resposta")}
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold ${modo === "resposta" ? "bg-navy-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}
          >
            <Send className="size-3.5" aria-hidden /> Responder ao cliente
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={modo === "nota"}
            onClick={() => setModo("nota")}
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold ${modo === "nota" ? "bg-amber-500 text-white" : "text-slate-600 hover:bg-slate-100"}`}
          >
            <StickyNote className="size-3.5" aria-hidden /> Nota interna
          </button>
        </div>

        {modo === "resposta" && !podeResponder && (
          <p className="mb-2 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
            {optout
              ? "O cliente pediu para não receber mensagens. Responder está bloqueado."
              : !humano
                ? "Assuma o atendimento para responder: enquanto o bot está ativo, só ele fala com o cliente."
                : "A janela de 24 h do WhatsApp terminou. Só é possível responder por texto depois que o cliente enviar uma nova mensagem."}
          </p>
        )}

        <div className="flex items-end gap-2">
          <textarea
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            onKeyDown={aoTeclar}
            rows={2}
            maxLength={4000}
            disabled={modo === "resposta" && !podeResponder}
            aria-label={modo === "resposta" ? "Mensagem para o cliente" : "Nota interna"}
            placeholder={
              modo === "resposta"
                ? "Escreva a resposta (enviada pelo WhatsApp em até 1 minuto). Ctrl+Enter envia."
                : "Nota visível só para a equipe jurídica. Ctrl+Enter salva."
            }
            className={`block max-h-40 min-h-[2.75rem] w-full resize-y rounded-lg border px-3 py-2 text-sm outline-none transition focus:ring-3 disabled:bg-slate-50 ${
              modo === "nota"
                ? "border-amber-300 bg-amber-50/40 focus:border-amber-500 focus:ring-amber-500/15"
                : "border-slate-300 focus:border-navy-500 focus:ring-navy-500/15"
            }`}
          />
          <button
            type="button"
            onClick={() => void enviar()}
            disabled={enviando || !texto.trim() || (modo === "resposta" && !podeResponder)}
            className={`inline-flex h-11 shrink-0 items-center gap-1.5 rounded-lg px-4 text-sm font-semibold text-white transition disabled:opacity-50 ${
              modo === "nota" ? "bg-amber-500 hover:bg-amber-600" : "bg-navy-900 hover:bg-navy-800"
            }`}
          >
            {enviando ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : modo === "nota" ? <StickyNote className="size-4" aria-hidden /> : <Send className="size-4" aria-hidden />}
            {modo === "nota" ? "Salvar nota" : "Enviar"}
          </button>
        </div>
      </footer>
    </section>
  );
}

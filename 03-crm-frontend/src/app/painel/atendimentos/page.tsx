"use client";

import { useCallback, useEffect, useState } from "react";
import { MessageCircle, RefreshCw, UserRoundCheck } from "lucide-react";
import { useAuth } from "@/components/auth-provider";
import { supabase } from "@/lib/supabase/client";

interface Atendimento {
  telefone: string;
  nome_cliente: string | null;
  area: string | null;
  status: string;
  etapa: string;
  resumo_fatos: string;
  prioridade: string;
  ficha_id: string | null;
  ultima_msg_cliente_em: string | null;
}
interface Mensagem {
  id: number;
  direcao: "IN" | "OUT";
  conteudo: string;
  tipo: string;
  criado_em: string;
}

/** Apenas atendimentos atribuídos ao advogado autenticado são visíveis:
 * o RLS do Supabase verifica pode_acessar_ficha(advogado_id). */
export default function ConversasBotPage() {
  const { perfil } = useAuth();
  const [itens, setItens] = useState<Atendimento[]>([]);
  const [selecionado, setSelecionado] = useState<string | null>(null);
  const [mensagens, setMensagens] = useState<Mensagem[]>([]);
  const [erro, setErro] = useState("");
  const [carregando, setCarregando] = useState(false);
  const [assumindo, setAssumindo] = useState(false);

  const atualizar = useCallback(async () => {
    if (!perfil) return;
    setCarregando(true);
    const { data, error } = await supabase.from("dfu_atendimentos")
      .select("telefone,nome_cliente,area,status,etapa,resumo_fatos,prioridade,ficha_id,ultima_msg_cliente_em")
      .order("ultima_msg_cliente_em", { ascending: false })
      .limit(100);
    setCarregando(false);
    if (error) { setErro("Não foi possível consultar as conversas. Verifique se a migração SQL foi aplicada."); return; }
    setErro("");
    setItens((data ?? []) as Atendimento[]);
  }, [perfil]);

  const carregarMensagens = useCallback(async (telefone: string) => {
    const { data, error } = await supabase.from("dfu_mensagens")
      .select("id,direcao,conteudo,tipo,criado_em")
      .eq("telefone", telefone)
      .order("id", { ascending: false }).limit(60);
    if (error) { setErro("Não foi possível consultar o histórico deste atendimento."); return; }
    setMensagens(((data ?? []) as Mensagem[]).reverse());
  }, []);

  useEffect(() => {
    void atualizar();
    const interval = setInterval(() => void atualizar(), 20000);
    return () => clearInterval(interval);
  }, [atualizar]);

  useEffect(() => {
    if (!selecionado) return;
    void carregarMensagens(selecionado);
    const interval = setInterval(() => void carregarMensagens(selecionado), 15000);
    return () => clearInterval(interval);
  }, [selecionado, carregarMensagens]);

  async function assumir() {
    if (!selecionado || assumindo) return;
    setAssumindo(true);
    const { data, error } = await supabase.rpc("dfu_assumir_atendimento", { p_telefone: selecionado });
    setAssumindo(false);
    if (error || data !== true) {
      setErro("Não foi possível assumir o atendimento. Confira suas permissões e o estado do caso.");
      return;
    }
    await atualizar();
  }

  const atual = itens.find((item) => item.telefone === selecionado);

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10">
      <div className="mb-7 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-navy-950">Conversas do assistente</h1>
          <p className="mt-1 text-sm text-slate-500">Atendimentos de WhatsApp vinculados às suas fichas. Atualização automática.</p>
        </div>
        <button type="button" onClick={() => void atualizar()} disabled={carregando}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 disabled:opacity-50">
          <RefreshCw size={16} /> Atualizar
        </button>
      </div>
      {erro && <p role="alert" className="mb-5 rounded-lg bg-red-50 p-3 text-sm text-red-800">{erro}</p>}
      <div className="grid min-h-[550px] gap-5 lg:grid-cols-[340px_1fr]">
        <section aria-label="Atendimentos" className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          {itens.length === 0 && <p className="p-5 text-sm text-slate-500">Nenhuma conversa atribuída ainda.</p>}
          <div className="max-h-[680px] overflow-y-auto">
            {itens.map((item) => (
              <button key={item.telefone} type="button" onClick={() => setSelecionado(item.telefone)}
                className={`block w-full border-b border-slate-100 p-4 text-left hover:bg-slate-50 ${selecionado===item.telefone?"bg-blue-50":""}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium text-slate-900">{item.nome_cliente || "Cliente não identificado"}</span>
                  <span className="shrink-0 text-xs text-slate-500">{item.prioridade}</span>
                </div>
                <p className="mt-1 text-xs text-slate-500">{item.telefone} · {item.area || "a classificar"}</p>
                <p className="mt-1 text-xs text-slate-600">{item.status.replaceAll("_", " ")}</p>
              </button>
            ))}
          </div>
        </section>
        <section aria-label="Histórico da conversa" className="flex flex-col rounded-xl border border-slate-200 bg-white">
          {!atual ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-slate-500">
              <MessageCircle size={32} /> Selecione um atendimento para ver o histórico e a triagem.
            </div>
          ) : (
            <>
              <header className="border-b border-slate-100 p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="font-semibold text-slate-900">{atual.nome_cliente || "Cliente"}</h2>
                    <p className="text-xs text-slate-500">{atual.area || "Sem área"} · {atual.status}</p>
                  </div>
                  {!["agendado","humano","encerrado","descadastrado"].includes(atual.status) && (
                    <button type="button" disabled={assumindo} onClick={() => void assumir()}
                      className="inline-flex items-center gap-2 rounded-lg bg-navy-900 px-3 py-2 text-sm text-white disabled:opacity-50">
                      <UserRoundCheck size={16} /> Assumir atendimento
                    </button>
                  )}
                </div>
                <div className="mt-4 whitespace-pre-line rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
                  <span className="font-semibold">Resumo interno: </span>{atual.resumo_fatos || "Aguardando triagem."}
                </div>
              </header>
              <div className="max-h-[510px] flex-1 space-y-3 overflow-y-auto bg-slate-50 p-5">
                {mensagens.map((m) => <div key={m.id}
                    className={`max-w-[90%] rounded-xl p-3 text-sm shadow-sm ${m.direcao==="OUT"?"ml-auto bg-blue-100 text-slate-900":"mr-auto bg-white text-slate-800"}`}>
                  <p className="mb-1 text-xs font-semibold">{m.direcao === "OUT" ? "Assistente" : "Cliente"}</p>
                  <p className="whitespace-pre-wrap break-words">{m.conteudo}</p>
                  <p className="mt-2 text-right text-[11px] opacity-60">{new Date(m.criado_em).toLocaleString("pt-BR")}</p>
                </div>)}
              </div>
              <footer className="border-t border-slate-100 p-3 text-xs text-slate-500">
                Esta tela acompanha o bot, mas não envia mensagens. Para contato humano, use o canal oficial do escritório.
              </footer>
            </>
          )}
        </section>
      </div>
    </main>
  );
}

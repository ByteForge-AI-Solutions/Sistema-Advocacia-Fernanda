"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert, LoaderCircle, MessagesSquare, RefreshCw } from "lucide-react";
import { JanelaChat, type AcaoConversa } from "@/components/atendimentos/janela-chat";
import { ListaConversas } from "@/components/atendimentos/lista-conversas";
import { PainelCliente } from "@/components/atendimentos/painel-cliente";
import { TransferirModal } from "@/components/atendimentos/transferir-modal";
import { useAuth } from "@/components/auth-provider";
import { Toast } from "@/components/toast";
import {
  ErroInbox,
  assumirAmpliado,
  carregarConversa,
  carregarEquipe,
  conversaComBot,
  criarNota,
  devolverAoBot,
  encerrar,
  listarAtendimentos,
  responder,
  transferir,
  type Atendimento,
  type Conversa,
  type MembroDestino,
} from "@/lib/atendimentos";
import { supabase } from "@/lib/supabase/client";

/**
 * Inbox de atendimento (bot + humano) em 3 colunas.
 * Visibilidade: RLS com pode_acessar_ficha(advogado_id) — e, para conversas sem
 * responsável, apenas titulares da área (migração v3). Atualização em tempo real via
 * Supabase Realtime, com recarga periódica de segurança.
 */
export default function ConversasBotPage() {
  const { perfil } = useAuth();
  const [itens, setItens] = useState<Atendimento[]>([]);
  const [v3, setV3] = useState(true);
  const [carregando, setCarregando] = useState(true);
  const [erroLista, setErroLista] = useState<string | null>(null);
  const [selecionado, setSelecionado] = useState<string | null>(null);
  const [conversa, setConversa] = useState<Conversa | null>(null);
  const [equipe, setEquipe] = useState<MembroDestino[]>([]);
  const [ocupado, setOcupado] = useState(false);
  const [erroAcao, setErroAcao] = useState<string | null>(null);
  const [sucesso, setSucesso] = useState<string | null>(null);
  const [transferindo, setTransferindo] = useState(false);
  const [painelAberto, setPainelAberto] = useState(false);
  const fecharToast = useCallback(() => setSucesso(null), []);
  // Telefone selecionado no momento em que uma resposta assíncrona chega (evita mostrar conversa trocada).
  const selecionadoRef = useRef<string | null>(null);
  useEffect(() => {
    selecionadoRef.current = selecionado;
  }, [selecionado]);

  const recarregarLista = useCallback(
    () =>
      listarAtendimentos().then(
        (r) => {
          setItens(r.itens);
          setV3(r.v3);
          setErroLista(null);
          setCarregando(false);
        },
        (e: unknown) => {
          setErroLista(e instanceof ErroInbox ? e.message : "Não foi possível consultar os atendimentos.");
          setCarregando(false);
        },
      ),
    [],
  );

  const recarregarConversa = useCallback(
    (telefone: string) =>
      carregarConversa(telefone).then(
        (c) => {
          if (selecionadoRef.current === telefone) setConversa(c);
        },
        (e: unknown) => {
          if (selecionadoRef.current === telefone) setErroAcao(e instanceof Error ? e.message : "Erro ao carregar a conversa.");
        },
      ),
    [],
  );

  // Lista + equipe + Realtime de atendimentos; recarga de segurança a cada 60 s.
  useEffect(() => {
    if (!perfil) return;
    let ativo = true;
    void recarregarLista();
    carregarEquipe().then((e) => ativo && setEquipe(e));
    const canal = supabase
      .channel("crm-inbox-lista")
      .on("postgres_changes", { event: "*", schema: "public", table: "dfu_atendimentos" }, () => void recarregarLista())
      .subscribe();
    const intervalo = setInterval(() => void recarregarLista(), 60_000);
    return () => {
      ativo = false;
      clearInterval(intervalo);
      void supabase.removeChannel(canal);
    };
  }, [perfil, recarregarLista]);

  // Conversa selecionada: mensagens, notas e fila de saída em tempo real.
  useEffect(() => {
    if (!selecionado) return;
    const filtro = `telefone=eq.${selecionado}`;
    const recarga = () => void recarregarConversa(selecionado);
    recarga();
    const canal = supabase
      .channel(`crm-inbox-${selecionado}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "dfu_mensagens", filter: filtro }, recarga)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "dfu_notas_internas", filter: filtro }, recarga)
      .on("postgres_changes", { event: "*", schema: "public", table: "dfu_outbox", filter: filtro }, recarga)
      .subscribe();
    const intervalo = setInterval(recarga, 30_000);
    return () => {
      clearInterval(intervalo);
      void supabase.removeChannel(canal);
    };
  }, [selecionado, recarregarConversa]);

  const nomes = useMemo(() => new Map(equipe.map((m) => [m.id, m.nome])), [equipe]);
  const souSocio = perfil?.cargo === "socio";
  // Filtro por responsável, espelhando o RLS: sócio = escritório (sem contas de teste);
  // titular = ele + estagiários que supervisiona; demais cargos não têm filtro.
  const responsaveisFiltro = useMemo(() => {
    if (!perfil || (perfil.cargo !== "socio" && perfil.cargo !== "advogado")) return [];
    const visiveis = equipe.filter((m) =>
      souSocio
        ? ["socio", "advogado", "estagiario"].includes(m.cargo)
        : m.cargo === "estagiario" && m.supervisor_id === perfil.id,
    );
    const rotulo = (m: MembroDestino) =>
      m.cargo === "estagiario" ? `${m.nome} · estagiário(a)` : m.cargo === "socio" ? `${m.nome} · sócio(a)` : m.nome;
    return [
      { id: perfil.id, nome: perfil.nome, rotulo: "Meus atendimentos" },
      ...visiveis.filter((m) => m.id !== perfil.id).map((m) => ({ id: m.id, nome: m.nome, rotulo: rotulo(m) })),
    ];
  }, [equipe, perfil, souSocio]);
  const atual = itens.find((a) => a.telefone === selecionado) ?? null;

  function selecionar(telefone: string) {
    setErroAcao(null);
    setConversa(null);
    setPainelAberto(false);
    setSelecionado(telefone);
  }

  async function executar(acao: () => Promise<void>, mensagemOk: string): Promise<boolean> {
    setOcupado(true);
    setErroAcao(null);
    try {
      await acao();
      setSucesso(mensagemOk);
      await recarregarLista();
      if (selecionado) await recarregarConversa(selecionado);
      return true;
    } catch (e) {
      setErroAcao(e instanceof Error ? e.message : "Não foi possível concluir a ação.");
      return false;
    } finally {
      setOcupado(false);
    }
  }

  async function assumir(a: Atendimento) {
    // Caso padrão (atribuído e com o bot ativo): RPC original do bot, dfu_assumir_atendimento.
    // Sem responsável, encerrado ou agendado: RPC ampliada da migração v3.
    if (a.advogado_id && conversaComBot(a.status)) {
      const { data, error } = await supabase.rpc("dfu_assumir_atendimento", { p_telefone: a.telefone });
      if (error || data !== true) throw new Error("Não foi possível assumir o atendimento. Confira suas permissões e o estado do caso.");
      return;
    }
    await assumirAmpliado(a.telefone);
  }

  function aoAcionar(acao: AcaoConversa) {
    if (!atual) return;
    if (acao === "transferir") {
      setTransferindo(true);
      return;
    }
    if (acao === "assumir") void executar(() => assumir(atual), "Atendimento assumido. O bot está pausado nesta conversa.");
    if (acao === "devolver" && confirm("Devolver ao bot? Ele volta a responder na próxima mensagem do cliente.")) {
      void executar(() => devolverAoBot(atual.telefone), "Atendimento devolvido ao bot.");
    }
    if (acao === "encerrar" && confirm("Encerrar este atendimento? Mensagens automáticas pendentes serão canceladas.")) {
      void executar(() => encerrar(atual.telefone), "Atendimento encerrado.");
    }
  }

  async function aoEnviar(texto: string, modo: "resposta" | "nota"): Promise<boolean> {
    if (!atual || !perfil) return false;
    return modo === "nota"
      ? executar(() => criarNota(atual.telefone, perfil.id, texto), "Nota interna salva.")
      : executar(() => responder(atual.telefone, texto), "Resposta enviada para a fila do WhatsApp.");
  }

  if (!perfil) return null;

  return (
    <main className="flex h-[calc(100dvh-6.5rem)] min-h-[520px] flex-col lg:h-dvh">
      <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-5 py-3">
        <div>
          <h1 className="text-lg font-semibold text-navy-950">Atendimentos</h1>
          <p className="text-xs text-slate-500">WhatsApp: bot e equipe na mesma caixa de entrada, em tempo real.</p>
        </div>
        <button
          type="button"
          onClick={() => {
            setCarregando(true);
            void recarregarLista();
          }}
          disabled={carregando}
          aria-label="Atualizar lista"
          className="rounded-lg p-2 text-slate-500 ring-1 ring-inset ring-slate-200 hover:bg-slate-50 disabled:opacity-50"
        >
          <RefreshCw className={`size-4 ${carregando ? "animate-spin" : ""}`} aria-hidden />
        </button>
      </div>

      {!v3 && (
        <p className="border-b border-amber-200 bg-amber-50 px-5 py-2 text-xs text-amber-900">
          Modo leitura: respostas humanas, notas, etiquetas e conversas sem responsável exigem a migração
          20261118_v3_crm_modulos.sql no Supabase.
        </p>
      )}

      {erroLista ? (
        <div role="alert" className="m-5 flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800">
          <CircleAlert className="mt-0.5 size-5 shrink-0" aria-hidden />
          {erroLista}
        </div>
      ) : carregando && itens.length === 0 ? (
        <div className="flex flex-1 items-center justify-center" role="status">
          <LoaderCircle className="size-6 animate-spin text-navy-700" aria-hidden />
          <span className="sr-only">Carregando…</span>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 lg:grid-cols-[320px_1fr] xl:grid-cols-[320px_1fr_320px]">
          <div className={`min-h-0 ${selecionado ? "hidden lg:flex" : "flex"} flex-col`}>
            <ListaConversas
              itens={itens}
              meuId={perfil.id}
              responsaveis={responsaveisFiltro}
              rotuloTodos={souSocio ? "Todo o escritório" : "Toda a equipe"}
              selecionado={selecionado}
              onSelecionar={selecionar}
            />
          </div>

          {atual ? (
            <>
              <div className="flex min-h-0">
                <JanelaChat
                  atendimento={atual}
                  conversa={conversa}
                  nomes={nomes}
                  meuId={perfil.id}
                  ocupado={ocupado}
                  erro={erroAcao}
                  onAcao={aoAcionar}
                  onEnviar={aoEnviar}
                  onVoltar={() => setSelecionado(null)}
                  onAbrirPainel={() => setPainelAberto(true)}
                />
              </div>
              <div
                className={`${painelAberto ? "fixed inset-y-0 right-0 z-30 flex w-[min(360px,100%)] shadow-2xl" : "hidden"} min-h-0 flex-col xl:static xl:flex xl:w-auto xl:shadow-none`}
              >
                <PainelCliente
                  key={atual.telefone}
                  atendimento={atual}
                  nomeResponsavel={atual.advogado_id ? (nomes.get(atual.advogado_id) ?? null) : null}
                  podeEditar={v3}
                  onEtiquetasSalvas={(etiquetas) =>
                    setItens((lista) => lista.map((a) => (a.telefone === atual.telefone ? { ...a, etiquetas } : a)))
                  }
                  onFechar={() => setPainelAberto(false)}
                />
              </div>
            </>
          ) : (
            <div className="hidden flex-1 flex-col items-center justify-center gap-3 bg-slate-50 p-8 text-center text-sm text-slate-500 lg:flex xl:col-span-2">
              <MessagesSquare className="size-10 text-slate-300" aria-hidden />
              Selecione uma conversa para ver o histórico, responder ou registrar notas internas.
            </div>
          )}
        </div>
      )}

      {transferindo && atual && (
        <TransferirModal
          equipe={equipe}
          meuId={perfil.id}
          atualId={atual.advogado_id}
          souSocio={souSocio}
          onConfirmar={(destino) => executar(() => transferir(atual.telefone, destino), "Atendimento transferido.")}
          onFechar={() => setTransferindo(false)}
        />
      )}
      {sucesso && <Toast mensagem={sucesso} onFechar={fecharToast} />}
    </main>
  );
}

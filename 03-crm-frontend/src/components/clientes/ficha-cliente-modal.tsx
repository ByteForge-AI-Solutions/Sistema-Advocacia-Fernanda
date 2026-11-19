"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FilePen, FolderOpen, HandCoins, IdCard, X } from "lucide-react";
import type { Advogado } from "@/lib/advogados";
import { AbaCadastro } from "@/components/clientes/aba-cadastro";
import { AbaDocumentos } from "@/components/clientes/aba-documentos";
import { AbaHonorarios } from "@/components/clientes/aba-honorarios";
import { GerarDocumentosModal } from "@/components/documentos/gerar-documentos-modal";
import { Toast } from "@/components/toast";

export type AbaCliente = "cadastro" | "honorarios" | "documentos";

const ABAS: { valor: AbaCliente; label: string; icone: typeof IdCard }[] = [
  { valor: "cadastro", label: "Cadastro", icone: IdCard },
  { valor: "honorarios", label: "Honorários", icone: HandCoins },
  { valor: "documentos", label: "Documentos", icone: FolderOpen },
];

/**
 * Ficha do cliente (migração v7): cadastro para contratos/procurações, honorários com
 * parcelas e entradas, e repositório de arquivos. "Gerar contrato/procuração" já usa o
 * cadastro e o contrato de honorários para preencher o modelo.
 */
export function FichaClienteModal({
  ficha,
  perfil,
  abaInicial = "cadastro",
  onFechar,
  onAlterada,
}: {
  ficha: { id: string; nome_cliente: string; advogado_id: string | null };
  perfil: Advogado;
  abaInicial?: AbaCliente;
  onFechar: () => void;
  /** Funil pode ter mudado (pagamento confirmado): a fila recarrega ao fechar. */
  onAlterada?: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [aba, setAba] = useState<AbaCliente>(abaInicial);
  const [aviso, setAviso] = useState<string | null>(null);
  const [gerar, setGerar] = useState(false);
  const [alterou, setAlterou] = useState(false);
  const fecharAviso = useCallback(() => setAviso(null), []);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);

  function fechar() {
    if (alterou) onAlterada?.();
    onFechar();
  }

  return (
    <dialog
      ref={ref}
      onClose={fechar}
      aria-labelledby="cliente-titulo"
      className="m-auto h-[min(92vh,860px)] w-[calc(100%-2rem)] max-w-3xl overflow-hidden rounded-2xl bg-white p-0 shadow-2xl ring-1 ring-slate-900/10 backdrop:bg-navy-950/60"
    >
      <div className="flex h-full flex-col">
        <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-6 pt-4">
          <div className="min-w-0 pb-3">
            <h2 id="cliente-titulo" className="truncate text-lg font-semibold text-navy-950">{ficha.nome_cliente}</h2>
            <p className="text-xs text-slate-500">Cadastro, honorários e documentos do cliente</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setGerar(true)}
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-navy-800 ring-1 ring-inset ring-navy-200 hover:bg-navy-50"
            >
              <FilePen className="size-3.5" aria-hidden /> Gerar contrato / procuração
            </button>
            <button type="button" onClick={fechar} aria-label="Fechar" className="rounded-md p-1 text-slate-400 hover:bg-slate-100">
              <X className="size-4" />
            </button>
          </div>
        </header>
        <div role="tablist" aria-label="Seções" className="flex gap-1 border-b border-slate-200 px-4">
          {ABAS.map(({ valor, label, icone: Icone }) => (
            <button
              key={valor}
              type="button"
              role="tab"
              aria-selected={aba === valor}
              onClick={() => setAba(valor)}
              className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-medium ${
                aba === valor ? "border-navy-900 text-navy-950" : "border-transparent text-slate-500 hover:text-slate-800"
              }`}
            >
              <Icone className="size-4" aria-hidden /> {label}
            </button>
          ))}
        </div>
        <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {aba === "cadastro" && <AbaCadastro fichaId={ficha.id} nomeFicha={ficha.nome_cliente} onSalvo={setAviso} />}
          {aba === "honorarios" && (
            <AbaHonorarios ficha={ficha} perfil={perfil} onAviso={setAviso} onFunilAlterado={() => setAlterou(true)} />
          )}
          {aba === "documentos" && <AbaDocumentos fichaId={ficha.id} perfil={perfil} onAviso={setAviso} />}
        </div>
      </div>
      {gerar && <GerarDocumentosModal fichaId={ficha.id} onFechar={() => setGerar(false)} />}
      {aviso && <Toast mensagem={aviso} onFechar={fecharAviso} />}
    </dialog>
  );
}

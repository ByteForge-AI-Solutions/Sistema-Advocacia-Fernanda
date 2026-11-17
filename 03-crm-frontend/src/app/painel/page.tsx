"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle, LogOut, Scale } from "lucide-react";
import { useAuth } from "@/components/auth-provider";
import { FilaFichas } from "@/components/fichas/fila-fichas";
import { CARGO_LABEL } from "@/lib/advogados";

function iniciais(nome: string) {
  const partes = nome.trim().split(/\s+/);
  return ((partes[0]?.[0] ?? "") + (partes.length > 1 ? partes[partes.length - 1][0] : "")).toUpperCase();
}

export default function PainelPage() {
  const router = useRouter();
  const { estado, perfil, sair } = useAuth();

  useEffect(() => {
    if (estado === "deslogado") router.replace("/login");
  }, [estado, router]);

  if (estado !== "autenticado" || !perfil) {
    return (
      <div className="flex flex-1 items-center justify-center" role="status">
        <LoaderCircle className="size-6 animate-spin text-navy-700" aria-hidden />
        <span className="sr-only">Carregando…</span>
      </div>
    );
  }

  const primeiroNome = perfil.nome.split(" ")[0];
  const ehTitular = perfil.cargo === "advogado";

  return (
    <div className="flex flex-1 flex-col">
      <header className="sticky top-0 z-10 border-b border-navy-900 bg-navy-950">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-4 px-6">
          <div className="flex items-center gap-2.5 text-white">
            <Scale className="size-5" aria-hidden />
            <span className="text-sm font-semibold">Dias e Fernandes</span>
            <span className="hidden text-xs uppercase tracking-[0.2em] text-navy-300 sm:inline">CRM</span>
          </div>

          <div className="flex items-center gap-3">
            <div className="hidden text-right leading-tight sm:block">
              <p className="text-sm font-medium text-white">{perfil.nome}</p>
              <p className="text-xs text-navy-300">{CARGO_LABEL[perfil.cargo]}</p>
            </div>
            <span
              className="flex size-9 items-center justify-center rounded-full bg-white/10 text-xs font-semibold text-white ring-1 ring-white/20"
              aria-hidden
            >
              {iniciais(perfil.nome)}
            </span>
            <button
              onClick={() => void sair()}
              className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-navy-100 transition hover:bg-white/10 hover:text-white"
            >
              <LogOut className="size-4" aria-hidden />
              <span className="hidden sm:inline">Sair</span>
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
        <h1 className="text-2xl font-semibold tracking-tight text-navy-950">Olá, {primeiroNome}</h1>
        <p className="mt-1 text-sm text-slate-500">
          {ehTitular
            ? "Sua fila de atendimentos e as fichas da sua equipe, ordenadas por prioridade e chegada."
            : "As fichas delegadas a você, ordenadas por prioridade e chegada."}
        </p>

        <div className="mt-8">
          <FilaFichas perfil={perfil} />
        </div>
      </main>
    </div>
  );
}

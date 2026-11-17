"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle } from "lucide-react";
import { useAuth } from "@/components/auth-provider";
import { Sidebar } from "@/components/painel/sidebar";

/** Área logada: protege todas as rotas /painel/* e exibe o menu lateral. */
export default function PainelLayout({ children }: LayoutProps<"/painel">) {
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

  return (
    <div className="flex flex-1 flex-col">
      <Sidebar perfil={perfil} onSair={() => void sair()} />
      <div className="flex flex-1 flex-col lg:pl-64">{children}</div>
    </div>
  );
}

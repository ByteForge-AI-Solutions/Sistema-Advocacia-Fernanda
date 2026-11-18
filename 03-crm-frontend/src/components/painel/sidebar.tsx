"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CalendarClock, CalendarDays, Inbox, LogOut, Scale, MessageCircle, type LucideIcon } from "lucide-react";
import { CARGO_LABEL, type Advogado } from "@/lib/advogados";

interface ItemMenu {
  href: string;
  label: string;
  icone: LucideIcon;
}

const ITENS: ItemMenu[] = [
  { href: "/painel", label: "Fila de atendimentos", icone: Inbox },
  { href: "/painel/agenda", label: "Agenda", icone: CalendarDays },
  { href: "/painel/atendimentos", label: "Conversas do bot", icone: MessageCircle },
  { href: "/painel/disponibilidade", label: "Disponibilidade", icone: CalendarClock },
];

function iniciais(nome: string) {
  const partes = nome.trim().split(/\s+/);
  return ((partes[0]?.[0] ?? "") + (partes.length > 1 ? partes[partes.length - 1][0] : "")).toUpperCase();
}

/** "/painel" só fica ativo na própria rota; os demais também nas sub-rotas. */
function estaAtivo(pathname: string, href: string) {
  return href === "/painel" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

export function Sidebar({ perfil, onSair }: { perfil: Advogado; onSair: () => void }) {
  const pathname = usePathname();

  return (
    <>
      {/* Desktop: barra lateral fixa */}
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-64 flex-col bg-navy-950 lg:flex">
        <div className="flex h-16 items-center gap-2.5 border-b border-white/10 px-6 text-white">
          <Scale className="size-5" aria-hidden />
          <span className="text-sm font-semibold">Dias e Fernandes</span>
          <span className="text-[10px] uppercase tracking-[0.2em] text-navy-300">CRM</span>
        </div>

        {perfil.cargo === "desenvolvedor" && (
          <p className="mx-3 mt-4 rounded-md bg-amber-400/15 px-3 py-1.5 text-center text-[11px] font-semibold uppercase tracking-wide text-amber-200 ring-1 ring-amber-300/30">
            Modo desenvolvedor
          </p>
        )}

        <nav aria-label="Menu principal" className="flex-1 space-y-1 px-3 py-6">
          {ITENS.map(({ href, label, icone: Icone }) => {
            const ativo = estaAtivo(pathname, href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={ativo ? "page" : undefined}
                className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition ${
                  ativo ? "bg-white/10 text-white" : "text-navy-200 hover:bg-white/5 hover:text-white"
                }`}
              >
                <Icone className="size-4.5" aria-hidden />
                {label}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-white/10 p-4">
          <div className="flex items-center gap-3">
            <span
              className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white/10 text-xs font-semibold text-white ring-1 ring-white/20"
              aria-hidden
            >
              {iniciais(perfil.nome)}
            </span>
            <div className="min-w-0 leading-tight">
              <p className="truncate text-sm font-medium text-white">{perfil.nome}</p>
              <p className="text-xs text-navy-300">{CARGO_LABEL[perfil.cargo]}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onSair}
            className="mt-4 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-navy-200 transition hover:bg-white/5 hover:text-white"
          >
            <LogOut className="size-4" aria-hidden />
            Sair
          </button>
        </div>
      </aside>

      {/* Mobile/tablet: barra superior com as abas do menu */}
      <header className="sticky top-0 z-20 bg-navy-950 lg:hidden">
        <div className="flex h-14 items-center justify-between px-4">
          <div className="flex items-center gap-2 text-white">
            <Scale className="size-5" aria-hidden />
            <span className="text-sm font-semibold">Dias e Fernandes</span>
            {perfil.cargo === "desenvolvedor" && (
              <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-200 ring-1 ring-amber-300/30">
                Dev
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onSair}
            aria-label="Sair"
            className="flex size-9 items-center justify-center rounded-lg text-navy-200 transition hover:bg-white/10 hover:text-white"
          >
            <LogOut className="size-4" />
          </button>
        </div>
        <nav aria-label="Menu principal" className="flex gap-1 overflow-x-auto px-3 pb-2">
          {ITENS.map(({ href, label, icone: Icone }) => {
            const ativo = estaAtivo(pathname, href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={ativo ? "page" : undefined}
                className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition ${
                  ativo ? "bg-white/10 text-white" : "text-navy-200 hover:text-white"
                }`}
              >
                <Icone className="size-4" aria-hidden />
                {label}
              </Link>
            );
          })}
        </nav>
      </header>
    </>
  );
}

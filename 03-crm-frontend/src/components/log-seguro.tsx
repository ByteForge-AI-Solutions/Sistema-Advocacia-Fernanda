"use client";

import { instalarLogSeguro } from "@/lib/log-seguro";

// Instala ao carregar o módulo no navegador (antes dos efeitos e das primeiras chamadas ao banco).
instalarLogSeguro();

/** Componente vazio: existe só para o layout carregar este módulo no cliente. */
export function LogSeguro() {
  return null;
}

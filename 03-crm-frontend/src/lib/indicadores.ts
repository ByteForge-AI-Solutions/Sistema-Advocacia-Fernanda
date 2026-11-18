import { supabase } from "@/lib/supabase/client";

/** Retorno da RPC crm_indicadores (migração v3): apenas contagens agregadas. */
export interface Indicadores {
  escopo: "escritorio" | "proprio";
  leads: number;
  leads_sem_responsavel: number;
  leads_com_reuniao: number;
  leads_por_status: Record<string, number>;
  fichas: number;
  reunioes: number;
  reunioes_realizadas: number;
  por_area: { area: string; fichas: number }[];
  por_advogado: { advogado_id: string; nome: string; cargo: string; atendimentos: number; fichas: number; reunioes: number }[];
  prazos_vencidos: number;
  prazos_proximos_7d: number;
}

export type PresetPeriodo = "7d" | "30d" | "mes" | "mes_anterior" | "90d";

export const PRESETS: { valor: PresetPeriodo; label: string }[] = [
  { valor: "7d", label: "7 dias" },
  { valor: "30d", label: "30 dias" },
  { valor: "mes", label: "Este mês" },
  { valor: "mes_anterior", label: "Mês anterior" },
  { valor: "90d", label: "90 dias" },
];

/** Intervalo [inicio, fim) no fuso local para cada atalho. */
export function intervaloDoPreset(p: PresetPeriodo, agora = new Date()): { inicio: Date; fim: Date } {
  const hoje = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate());
  const amanha = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() + 1);
  const menos = (dias: number) => new Date(amanha.getFullYear(), amanha.getMonth(), amanha.getDate() - dias);
  switch (p) {
    case "7d":
      return { inicio: menos(7), fim: amanha };
    case "30d":
      return { inicio: menos(30), fim: amanha };
    case "90d":
      return { inicio: menos(90), fim: amanha };
    case "mes":
      return { inicio: new Date(hoje.getFullYear(), hoje.getMonth(), 1), fim: amanha };
    case "mes_anterior":
      return {
        inicio: new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1),
        fim: new Date(hoje.getFullYear(), hoje.getMonth(), 1),
      };
  }
}

export async function buscarIndicadores(inicio: Date, fim: Date): Promise<Indicadores> {
  const { data, error } = await supabase.rpc("crm_indicadores", {
    p_inicio: inicio.toISOString(),
    p_fim: fim.toISOString(),
  });
  if (error) {
    console.error("Erro ao carregar indicadores:", error.code, error.message);
    if (error.code === "PGRST202" || error.code === "42883") {
      throw new Error("Os indicadores precisam da migração 20261118_v3_crm_modulos.sql no Supabase.");
    }
    if (error.code === "42P01") {
      throw new Error("As tabelas do bot (dfu_*) não foram encontradas. Aplique a migração do bot antes.");
    }
    throw new Error("Não foi possível carregar os indicadores.");
  }
  return data as Indicadores;
}

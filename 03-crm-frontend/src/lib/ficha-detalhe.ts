import { supabase } from "@/lib/supabase/client";

/** Dados da ficha para painéis laterais. Sem CPF: só o gerador de documentos o carrega. */
export interface FichaResumo {
  id: string;
  nome_cliente: string;
  telefone: string;
  area_identificada: string;
  prioridade: string;
  motivo_prioridade: string | null;
  resumo_fatos: string;
  status_atendimento: string | null;
  advogado_id: string | null;
  created_at: string;
}

export interface ReuniaoHistorico {
  id: string;
  titulo_evento: string;
  data_hora_inicio: string;
  status: string;
}

export interface PrazoHistorico {
  id: string;
  /** Opcional em parcelas e certidões (migração v5). */
  numero_cnj: string | null;
  descricao_prazo: string;
  data_fatal: string;
  status: string;
}

export interface HistoricoFicha {
  ficha: FichaResumo | null;
  reunioes: ReuniaoHistorico[];
  prazos: PrazoHistorico[];
}

export async function carregarHistoricoFicha(fichaId: string): Promise<HistoricoFicha> {
  const [ficha, reunioes, prazos] = await Promise.all([
    supabase
      .from("fichas_clientes")
      .select("id,nome_cliente,telefone,area_identificada,prioridade,motivo_prioridade,resumo_fatos,status_atendimento,advogado_id,created_at")
      .eq("id", fichaId)
      .maybeSingle<FichaResumo>(),
    supabase
      .from("agenda_advogados")
      .select("id,titulo_evento,data_hora_inicio,status")
      .eq("ficha_id", fichaId)
      .order("data_hora_inicio", { ascending: false })
      .limit(20)
      .overrideTypes<ReuniaoHistorico[], { merge: false }>(),
    supabase
      .from("processos_prazos")
      .select("id,numero_cnj,descricao_prazo,data_fatal,status")
      .eq("ficha_id", fichaId)
      .order("data_fatal", { ascending: true })
      .limit(20)
      .overrideTypes<PrazoHistorico[], { merge: false }>(),
  ]);
  return {
    ficha: ficha.error ? null : (ficha.data ?? null),
    reunioes: reunioes.error ? [] : (reunioes.data ?? []),
    // processos_prazos só existe após a migração v3; sem ela o histórico fica vazio.
    prazos: prazos.error ? [] : (prazos.data ?? []),
  };
}

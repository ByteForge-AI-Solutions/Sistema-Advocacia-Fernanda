/**
 * Contratos de integração Bot ↔ CRM — v2.0
 * Fonte de verdade do agendamento: tabelas do CRM, via RPCs SQL.
 * Este arquivo é documental e NÃO deve ser importado pelo frontend com segredos.
 * Ao alterar uma assinatura RPC, atualizar: migração SQL, workflow n8n e manual.
 */
export const AREAS_BOT = [
  "trabalhista", "empresarial", "civil", "cartorario_reurb", "previdenciario", "tributario"
] as const;
export type AreaBot = typeof AREAS_BOT[number];
export type PrioridadeBot = "alta" | "media" | "baixa";
export type EstadoBot = "em_andamento" | "aguardando_horario" | "agendado" | "humano" | "encerrado" | "descadastrado";
export type AcaoBot = "perguntar" | "oferecer_horarios" | "confirmar_horario" | "humano" | "encerrar";

export interface EntradaWhatsAppPersistida {
  p_telefone: string;        // 55DD9XXXXXXXX — formato usado pelo CRM
  p_provider_id: string;     // ID Meta, idempotente
  p_texto: string;
  p_tipo: string;
  p_nome_whatsapp?: string;
}
export interface EntradaPersistidaResultado {
  processar_ia: boolean;
  motivo?: string;
  telefone?: string;
}
export interface SinalN8n {
  telefone: string;
  processar_ia: true;
}
export interface ResultadoTriagemIA {
  nome_cliente: string;
  area: AreaBot | null;
  tipo_caso: "sem_registro" | "geral";
  etapa: "recepcao" | "entendimento" | "coleta_dados" | "agendamento" | "encerramento";
  dados_coletados: Record<string, unknown>;
  resumo_fatos: string;    // Relato fático para o advogado, NÃO parecer
  prioridade: PrioridadeBot;
  motivo_prioridade: string;
  acao: AcaoBot;
  slot_escolhido: 1 | 2 | 3 | null;
  mensagem_ao_cliente: string;
}
export interface OpcaoAgenda {
  opcao: 1 | 2 | 3;
  advogado_id: string;
  inicio: string; // UTC com offset ISO retornado pelo PostgreSQL
  fim: string;
  exibicao: string; // Brasília
}
export interface ConfirmacaoAgenda {
  ok: boolean;
  motivo?: "sem_area" | "sem_horarios" | "oferta_expirada" | "opcao_invalida" |
    "indisponivel" | "fora_da_grade" | "ocupado" | "sem_advogado";
  ficha_id?: string;
  advogado_id?: string;
  data_hora?: string;
}

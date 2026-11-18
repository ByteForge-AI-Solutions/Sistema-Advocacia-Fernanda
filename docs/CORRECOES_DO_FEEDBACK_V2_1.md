# Ajustes após feedback — v2.1 (18/11/2026)

O texto `message.txt` trouxe alertas de implantação, e não registros de falhas comprovadas em produção. Esta atualização trata preventivamente os riscos identificados, **sem alterar o código central do CRM**.

| Ponto do feedback | Providência aplicada |
|---|---|
| Risco de reexecutar o `schema.sql` original | Migracão principal agora declara que o esquema deve **já existir**, traz pré-requisitos `DO` com erro informativo e instrui a jamais reaplicar `schema.sql` inteiro em banco existente. |
| Agendas antigas sem `data_hora_fim` ou com sobreposições | Novo diagnóstico `00_diagnostico_preinstalacao.sql`, exclusivamente leitura, para detectar problemas antes da instalação. Não modifica dados antigos. |
| Trigger pode impedir atualização de evento legado | `dfu_proteger_agenda()` permite atualizações que mantêm responsável, início/fim e estado ativo, mesmo com conflito histórico. Novos eventos, alterações de horário e reativação continuam protegidos. |
| Preservação de autenticação, fichas, disponibilidade e agenda | Arquivos originais continuam idênticos ao CRM recebido. Script de verificação SHA-256 detecta alterações nos oito arquivos sensíveis. |
| **Regressão adicional descoberta: página principal `/painel` foi sobrescrita na v2.0** | Restauramos integralmente a página original com `<FilaFichas />`; a tela de conversas continua exclusivamente em `/painel/atendimentos`. O teste estático agora verifica ambas as rotas. |
| Exposição do n8n diretamente à Meta | Mantido o gateway Edge Function: challenge GET, HMAC SHA-256 no POST e persistência antes do HTTP 200. O webhook interno do n8n exige segredo. |
| Instalação segura e credenciais | Manual v2.1 inclui diagnóstico, homologação, rota de upgrade se a v2.0 já foi aplicada, testes de agenda e instruções de modo teste. |

## Qual arquivo usar

- **Ainda não instalou o bot (situação informada):** rode `00_diagnostico_preinstalacao.sql` e depois **somente** `20261118_bot_unificado.sql` da versão 2.1.
- **Já aplicou a migração v2.0 em alguma instância:** faça backup/diagnóstico e rode apenas `20261118_v2_1_correcao_agenda_se_v2_ja_instalado.sql` em vez de reaplicar tudo.

## Limitações / pendências de homologação

- A análise de conflitos legados usa 60 minutos quando `data_hora_fim` está nulo. Isso não representa necessariamente a duração real do compromisso: revisar com o escritório.
- O bloqueio é transacional para eventos criados dentro do Supabase; ele não verifica Google Calendar externo, que não é o calendário utilizado neste fluxo.
- Fluxos n8n, assinatura Meta, RLS, agenda e build Next.js requerem testes reais na instalação de homologação. Esta entrega não implica credenciais configuradas, serviço ativo, mudança de produção ou compatibilidade já certificada com versões futuras do CRM.
- Desabilitar o trigger de sobreposição para permitir novos compromissos conflitantes não é correção; mantém-se a proteção.

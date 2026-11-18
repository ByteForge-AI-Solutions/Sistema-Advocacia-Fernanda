# CRM Dias & Fernandes + Bot de Atendimento Unificado (v2.1)

**Base preservada:** versão atualizada do CRM enviada em 18/11/2026.  
**Estado:** implementação de código entregue **não implantada / não homologada**. Envio real bloqueado por padrão.

**Comece pelo [MANUAL_INSTALACAO_BOT.md](MANUAL_INSTALACAO_BOT.md).**

## O que foi integrado

O mesmo repositório contém o frontend Next.js do CRM, o workflow n8n, o prompt da OpenAI, uma Edge Function autenticada para WhatsApp, a migração SQL incremental e contratos compartilhados. Os serviços continuam com **deploys independentes**, usando o mesmo Supabase como fonte de verdade.

O assistente realiza atendimento inicial via WhatsApp, com **mensagem fixa introdutória**, triagem dinâmica de seis áreas jurídicas e roteiro especializado para **trabalhista sem registro em carteira**. Ele guarda histórico e resumo fático, oferece até três horários reais de advogados especialistas cadastrados no CRM e, após a escolha, confirma o compromisso em `agenda_advogados`, vinculado à ficha do cliente.

**O CRM atualizado permanece íntegro:** a autenticação, as regras de acesso, o cargo especial `desenvolvedor`, a agenda manual, o cadastro de advogados e a tela de fichas não foram substituídos. Foi acrescentado um item **Conversas do bot** e sua página protegida por RLS.

## Estrutura

| Pasta | Responsabilidade |
|---|---|
| `01-agentes-ia/` | Workflow n8n principal, importador CSV opcional, prompt, exemplos e testes |
| `02-backend-integracao/` | Edge Function que verifica Meta HMAC e grava mensagens antes de sinalizar o n8n |
| `03-crm-frontend/` | Next.js original mais página de conversas |
| `04-banco-dados/` | Schema **original preservado** + migração incremental `migrations/20261118_bot_unificado.sql` |
| `05-contratos-compartilhados/` | Tipos e assinaturas de integração |
| `docs/` | Mapa de diferenças, compatibilidade e observações |

## Segurança e funcionamento

- **Entradas duráveis:** Edge grava no Supabase antes de confirmar recepção à Meta. Scheduler faz recuperação após falhas do n8n/OpenAI.
- **Saídas controladas:** duas autorizações distintas (modo teste/compliance e revalidação no banco) antes de chamar Meta.
- **Agenda real:** consulta disponibilidade individual e compromissos; revalidação e trigger de prevenção de sobreposição.
- **Restrição de acesso:** fichas e conversas são exibidas no CRM somente para a equipe responsável; segredos ficam exclusivamente no backend.
- **Aconselhamento:** resumo **fático preliminar**, não parecer jurídico automático. Contatos processuais importados não equivalem a autorização para prospecção.

**Limites nesta versão:** não foi instalado em n8n/Supabase/Meta/OpenAI; não cria Meet/Google Calendar; áudios apenas mediante transcrição opcional, sem análise multimodal automática de imagens/PDF/vídeos; não foram implementadas pesquisas processuais externas. O roteiro, SQL, APIs, permissões e agendamento exigem homologação em instância real.

## Verificações locais

```bash
python 01-agentes-ia/tests/check_integration.py
```

O comando faz validações estáticas de arquivos, fluxo, scripts JS e integridade dos componentes críticos do CRM. Não substitui testes reais e aprovação de conformidade.

## Atualização v2.1 — riscos de implantação tratados

- **Página principal restaurada:** `/painel` conserva a fila original de fichas; conversas só em `/painel/atendimentos` (correção de regressão presente na v2.0).
- **Banco atual preservado:** execute primeiro o diagnóstico somente leitura `04-banco-dados/migrations/00_diagnostico_preinstalacao.sql`. **Não execute `schema.sql` inteiro em banco já existente.**
- **Gatilho de agenda corrigido:** mantém proteção de novos agendamentos e remarcações, sem bloquear uma atualização apenas de status em compromisso ativo legado de horário inalterado.
- **Migração para quem já instalou v2.0:** arquivo `20261118_v2_1_correcao_agenda_se_v2_ja_instalado.sql`, exclusivamente para esse caso.
- **Rastreabilidade:** consulte `docs/CORRECOES_DO_FEEDBACK_V2_1.md` e o manual atualizado.

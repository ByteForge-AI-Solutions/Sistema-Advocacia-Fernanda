# Compatibilidade com a última versão do CRM

**Base:** `Sistema-Advocacia-Fernanda-main(1)(1).zip`, fornecido em 18/11/2026.

## Arquivos originais que permanecem intactos

- `03-crm-frontend/src/lib/advogados.ts` (inclui cargo `desenvolvedor`)
- `03-crm-frontend/src/lib/agenda.ts`
- `03-crm-frontend/src/lib/disponibilidade.ts`
- `03-crm-frontend/src/lib/fichas.ts`
- `03-crm-frontend/src/components/auth-provider.tsx`
- `03-crm-frontend/src/components/agenda/reuniao-modal.tsx`
- `03-crm-frontend/src/app/painel/page.tsx`
- `04-banco-dados/schema.sql`

## Alteração mínima em código existente

- `03-crm-frontend/src/components/painel/sidebar.tsx`: importação do ícone `MessageCircle` e adição do item de navegação `/painel/atendimentos`.

## Arquivos novos

- `03-crm-frontend/src/app/painel/atendimentos/page.tsx`
- Bot n8n e prompt sob `01-agentes-ia/`
- Edge Function sob `02-backend-integracao/`
- Migração `04-banco-dados/migrations/20261118_bot_unificado.sql`
- Contratos e documentação

## Diferenças importantes em relação ao bot v1

1. Preserva integralmente o `cargo='desenvolvedor'` existente no CRM recente.
2. Não coloca uma cópia antiga de `advogados.ts` ou do modal de reunião no frontend atualizado.
3. Entrada Meta salva no Supabase **antes** do HTTP 200, reduzindo perda de mensagens em erros do n8n.
4. Sinalização rápida e cron de recuperação de entradas; leasing para impedir dupla análise simultânea.
5. Gate de envio dividido em duas checagens: configuração de teste/compliance e revalidação de bloqueio na RPC.
6. Não atribui arbitrariamente a área `civil` quando a triagem não consegue identificar competência.
7. Ao assumir atendimento humano no CRM, as respostas automáticas ainda pendentes são bloqueadas.
8. Sem dependência de Google Calendar: reunião é criada em `agenda_advogados` e vinculada à ficha atual.

## Restrições deliberadas

A migração adiciona trigger de conflito a `agenda_advogados` e habilita RLS em `conversas_memoria`. Essas são alterações comportamentais no banco: faça teste com compromissos antigos e outras integrações antes de produção. Não foram adicionadas ou alteradas as funções `pode_acessar_ficha`, `advogado_atual_id`, `agenda_valida_ficha` ou as políticas atuais de `agenda_advogados`.

**Interface nova:** a tela de atendimentos mostra somente conversas com advogado atribuído e autorizado pelo RLS; registros ainda sem área/advogado exigem análise operacional, não aparecem livremente para toda a equipe.

## Correção de compatibilidade incluída na v2.1

A v2.0 distribuída tinha um defeito de montagem: `src/app/painel/page.tsx` havia sido substituído pelo conteúdo da tela nova, embora o documento anterior dissesse que tinha sido preservado. **A v2.1 restaura os bytes originais dessa página** a partir do último ZIP enviado, mantendo a fila de fichas intacta. A página nova permanece somente em `src/app/painel/atendimentos/page.tsx`. O único arquivo de frontend já existente alterado segue sendo o `sidebar.tsx`, para acrescentar o link da nova rota.

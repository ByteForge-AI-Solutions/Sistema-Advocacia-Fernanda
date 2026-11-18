# Contratos compartilhados entre bot e CRM

- `contratos-bot.ts` é a definição de tipos e o contrato público **sem credenciais** do bot.
- A API privada de integração é composta das funções `dfu_*` da migração SQL.
- **Fonte de verdade:** `public.advogados`, `public.disponibilidade_advogados`, `public.agenda_advogados` e `public.fichas_clientes`.
- O assistente não escreve diretamente em tabelas críticas do frontend: solicita operações transacionais `dfu_ofertar`, `dfu_confirmar`, `dfu_aplicar_ia`.
- Alterações em enumerações, status ou assinaturas de RPC exigem atualização sincronizada no SQL, n8n e contratos.
- O frontend utiliza somente a chave **anon** com sessão do advogado, respeitando RLS; credenciais de serviço são exclusivamente da Edge Function e do n8n.

A versão atual não exige configurar um servidor Node/Next extra de integração: a camada backend é implementada por funções SQL (RPC) + Supabase Edge Function de webhook. Isso mantém as partes desacopladas mesmo estando no mesmo repositório.

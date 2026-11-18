# Camada de integração

`supabase/functions/meta-webhook/index.ts` é a borda pública de WhatsApp, implantada como Edge Function no projeto Supabase.

A Edge valida `X-Hub-Signature-256` da Meta, opcionalmente transcreve áudios espontâneos e persiste a mensagem usando a RPC `dfu_receber`. **Não** depende do sucesso do n8n para acusar o recebimento à Meta: a persistência vem primeiro; o webhook interno para o n8n é apenas um sinal de processamento rápido. O cron do próprio workflow verifica pendências para recuperar mensagens em caso de falha.

As demais regras de integração vivem exclusivamente nas `dfu_*` do SQL, preservando os arquivos de autenticação e de agenda do CRM. O n8n não deve receber dados processuais das planilhas ou chaves `service_role` por input do cliente.

Veja `../MANUAL_INSTALACAO_BOT.md`.

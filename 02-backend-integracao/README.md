# Camada de integração

`supabase/functions/meta-webhook/index.ts` é a borda pública de WhatsApp, implantada como Edge Function no projeto Supabase.

A Edge valida `X-Hub-Signature-256` da Meta, opcionalmente transcreve áudios espontâneos e persiste a mensagem usando a RPC `dfu_receber`. **Não** depende do sucesso do n8n para acusar o recebimento à Meta: a persistência vem primeiro; o webhook interno para o n8n é apenas um sinal de processamento rápido. O cron do próprio workflow verifica pendências para recuperar mensagens em caso de falha.

As demais regras de integração vivem exclusivamente nas `dfu_*` do SQL, preservando os arquivos de autenticação e de agenda do CRM. O n8n não deve receber dados processuais das planilhas ou chaves `service_role` por input do cliente.

Veja `../MANUAL_INSTALACAO_BOT.md`.

## Prospecção de execuções fiscais (v11)

`supabase/functions/prospeccao-execucoes/` é chamada pelo CRM (tela "Prospecção (CNPJ)") com o JWT do usuário. Só sócios e advogados titulares passam. Ela consulta o DataJud (classe 1116, TRF1/TRF3/TRF4), cruza cada processo com o DJEN (polo ativo, executado, CNPJ) e enriquece telefone e e-mail pela base aberta de CNPJ, com cache de 30 dias. Usa só fontes públicas; para trocar por um provedor pago, implemente a interface correspondente em `fontes.ts`.

```bash
supabase secrets set DATAJUD_API_KEY="<chave pública vigente do DataJud>" CRM_ORIGENS="https://<domínio do CRM>,http://localhost:3000"
supabase functions deploy prospeccao-execucoes   # COM verificação de JWT (padrão)
```

Base da PGFN (opcional): baixe o ZIP trimestral "Não Previdenciário" em dadosabertos.pgfn.gov.br, descompacte e rode `scripts/importar-pgfn.mjs` (instruções no cabeçalho do arquivo). Comece com `--dry-run`.

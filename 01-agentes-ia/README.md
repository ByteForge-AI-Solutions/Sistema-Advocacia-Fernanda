# Assistente virtual único — n8n

- `n8n/DFU_BOT_UNICO_CRM.json` é o workflow principal: entrada interna, recuperação de mensagens pendentes, OpenAI, agenda, outbox e follow-up opcional.
- `n8n/DFU_IMPORTADOR_CSV_OPCIONAL.json` é uma rotina **separada e opcional**, sem disparo de WhatsApp, para ingestão das planilhas processuais.
- `prompts/AGENTE_TRIAGEM.md` contém o roteiro do atendimento generalista e a especialização trabalhista sem carteira. O prompt também está embutido no nó **05** do workflow. Se editar o prompt, sincronize ambas as cópias antes de importar.
- `config.example.env` é um modelo não sensível das variáveis privadas do n8n.
- `tests/check_integration.py` verifica a estrutura estática e a preservação de arquivos críticos.

Use apenas credenciais de teste até a homologação; o workflow é distribuído com `active:false`, `MODO_TESTE=true` e `COMPLIANCE_APROVADO=false`.

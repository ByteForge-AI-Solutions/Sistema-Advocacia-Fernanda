# Manual de instalação — Bot de atendimento unificado + CRM Dias & Fernandes

**Versão:** 2.1 · **Data:** 18/11/2026  
**Plataformas:** CRM Next.js, Supabase PostgreSQL e Edge Functions, n8n, WhatsApp Business Cloud API (Meta), OpenAI.  
**Situação inicial:** arquivos integrados, mas **nenhum serviço ou credencial implantado**. O bot é entregue **desativado** e com envios reais bloqueados por padrão.

> **Leia antes de começar:** este é um pacote de código e configuração, não uma instalação automática nas suas contas. A migração SQL e as credenciais precisam ser aplicadas nas instâncias corretas e testadas em homologação. Não use as planilhas de pessoas/processos para iniciar publicidade jurídica ou contatos não solicitados. Verifique LGPD, regras profissionais da OAB e requisitos da Meta antes de qualquer envio real.

## 1. O que mudou no repositório

```text
Sistema_Advocacia_Fernanda_Bot_Integrado_V2_1/
├── 01-agentes-ia/
│   ├── n8n/DFU_BOT_UNICO_CRM.json        ← bot único, importar no n8n
│   ├── n8n/DFU_IMPORTADOR_CSV_OPCIONAL.json ← ingestão CSV, sem disparo
│   ├── prompts/AGENTE_TRIAGEM.md
│   ├── config.example.env
│   └── tests/check_integration.py
├── 02-backend-integracao/
│   └── supabase/functions/meta-webhook/index.ts ← gateway Meta autenticado
├── 03-crm-frontend/                    ← CRM atualizado, preservado
│   └── src/app/painel/atendimentos/page.tsx ← nova página
├── 04-banco-dados/
│   ├── schema.sql                        ← intacto, não substituir no banco
│   └── migrations/20261118_bot_unificado.sql ← migracao principal v2.1
├── 05-contratos-compartilhados/
│   └── contratos-bot.ts
├── docs/                                 ← notas de compatibilidade
└── MANUAL_INSTALACAO_BOT.md
```

**Arquivos críticos do CRM NÃO substituídos:** `src/lib/advogados.ts`, `src/lib/agenda.ts`, `src/lib/disponibilidade.ts`, `src/lib/fichas.ts`, `src/components/auth-provider.tsx`, formulários de reunião e `04-banco-dados/schema.sql`. A única modificação em arquivo já existente do frontend é um item de menu em `src/components/painel/sidebar.tsx`. A conta com cargo `desenvolvedor` permanece suportada.

O código fonte do n8n fica no Git, **mas a execução ocorre no serviço n8n**. Não é necessário instalar n8n dentro do servidor Next.js. A Edge Function e o SQL são a camada de integração; não foi adicionado um backend Next.js concorrente.

## 2. Pré-requisitos e ordem de implantação

Antes de configurar, você precisa de:

1. Uma **cópia/backup do banco do CRM**, projeto Supabase de teste com a mesma estrutura, e permissões para executar migração no SQL Editor.
2. Instância n8n atual compatível com Code, Wait, IF, Schedule, Webhook e HTTP Request; preferencialmente **self-hosted** caso deseje as variáveis de runtime e leitura de CSV locais.
3. Acesso ao **Meta for Developers**, WhatsApp Business Cloud API com número de teste e tokens do app (não confundir App Secret com WhatsApp Access Token).
4. Chave API da OpenAI e orçamento/limites de uso configurados.
5. Supabase CLI para instalar a função e acesso ao seu frontend Next.js (Node/npm).
6. Um ou mais advogados ativos, com `areas_atuacao`, uma grade ativa em `disponibilidade_advogados` e uma agenda acessível no CRM.

**Ordem:** pré-verificação → backup → SQL → importação n8n → credenciais → Edge Function → Meta → frontend → testes → eventual produção.

## 3. Conferir o Supabase do CRM (sem modificar nada)

No SQL Editor do **projeto correto**, rode somente esta consulta:

```sql
SELECT
  to_regclass('public.advogados') AS advogados,
  to_regclass('public.fichas_clientes') AS fichas,
  to_regclass('public.agenda_advogados') AS agenda,
  to_regclass('public.disponibilidade_advogados') AS disponibilidade,
  to_regclass('public.conversas_memoria') AS memoria;
```

As cinco colunas precisam retornar os nomes das tabelas. Se alguma vier `NULL`, **não rode a migração do bot** antes de atualizar a estrutura do CRM. O arquivo `schema.sql` original contém também `INSERT` de usuários de demonstração; **não execute o schema inteiro indiscriminadamente num banco existente**, pois pode duplicar registros ou alterar políticas atuais.

Confira dados e disponibilidade:

```sql
SELECT a.id, a.nome, a.cargo, a.ativo, a.areas_atuacao,
       d.dia_semana, d.hora_inicio, d.hora_fim,
       d.duracao_reuniao_min, d.max_reunioes_dia, d.ativo AS dia_ativo
FROM public.advogados a
LEFT JOIN public.disponibilidade_advogados d ON d.advogado_id = a.id
ORDER BY a.nome, d.dia_semana;
```

**Atenção:** `desenvolvedor` e `estagiario` não recebem leads automaticamente. Somente `cargo = 'advogado' AND ativo = true` pode ser candidato ao agendamento.

## 4. Aplicar a migração SQL

### 4.0 Diagnóstico obrigatório (sem modificar o CRM)

Antes de executar a migração, rode **`04-banco-dados/migrations/00_diagnostico_preinstalacao.sql`** no SQL Editor do **Supabase de homologação**. É um script de leitura (`SELECT`), sem alteração de tabelas ou registros. Verifique:

- As cinco tabelas e `pode_acessar_ficha(uuid)` já existem no CRM. Se não existirem, interrompa: **não use o `schema.sql` inteiro para corrigir a falta**.
- Quantos compromissos ativos estão sem `data_hora_fim`, sobretudo futuros.
- Se já há reuniões ativas sobrepostas (IDs e horários apresentados sem expor nomes de clientes).
- Se existem mais de uma grade de disponibilidade para o mesmo advogado/dia, ou durações/limites inválidos.

A migração **não corrige compromissos antigos, não altera horários, não preenche `data_hora_fim` e não recria dados do CRM**. Os problemas apontados pelo diagnóstico devem ser avaliados pela equipe e corrigidos manualmente **se necessário**, após backup. O gatilho considera horários nulos como duração provisória de 60 minutos somente na comparação de conflitos.

Se a migração v2.0 já tiver sido instalada anteriormente, não reexecute o conjunto todo como método de atualização: após o diagnóstico, aplique **somente** `20261118_v2_1_correcao_agenda_se_v2_ja_instalado.sql` (corrige apenas a função do trigger).


Faça primeiro em ambiente de homologação: **`04-banco-dados/migrations/20261118_bot_unificado.sql`**.

- Abra **Supabase → SQL Editor → New query**.
- Cole o arquivo da migração completo e execute uma única vez. O script é transacional (`BEGIN` / `COMMIT`) e cria tabelas `dfu_*`, funções RPC, políticas RLS e um trigger de proteção de conflitos na `agenda_advogados`.
- **Não substitua nem reexecute automaticamente** o `04-banco-dados/schema.sql`. A migração principal v2.1 apenas estende o CRM atual e verifica se ele já tem as estruturas requeridas.
- O **trigger de sobreposição v2.1** protege agendamentos novos e remarcações e valida quando um compromisso cancelado/realizado volta a ficar ativo. Em compensação, **não revalida colisões antigas** quando um registro já ativo muda apenas de `agendado` para `confirmado` (sem alterar responsável/início/fim), evitando o bloqueio desnecessário da manutenção de registros legados. Dados de término nulos continuam sendo tratados como 60 minutos nas comparações; novos agendamentos conflitantes ainda serão recusados.
- **Testes de regressão manuais:** (a) novo evento sem conflito deve salvar; (b) novo sobreposto deve falhar; (c) reagendar para horário ocupado deve falhar; (d) alterar status de evento antigo de `agendado` para `confirmado`, sem modificar horário, deve salvar mesmo se já houver conflito histórico; (e) alterar de `cancelado` para `confirmado` em horário ocupado deve falhar; (f) o perfil especial `desenvolvedor` não pode passar a enxergar casos reais de outros advogados.
- A migração ativa o RLS em `conversas_memoria` e impede leitura por `anon`/`authenticated` dessa memória do bot. Verifique se alguma integração antiga a acessava sem `service_role` (no CRM entregue, ela não é usada pelo frontend).
- Não apague as tabelas `dfu_*` ao fazer atualizações: histórico e outbox não devem ser descartados sem avaliação legal e backup.

Para conferir o resultado:

```sql
SELECT to_regclass('public.dfu_atendimentos'),
       to_regclass('public.dfu_mensagens'),
       to_regclass('public.dfu_outbox');
SELECT proname FROM pg_proc WHERE pronamespace='public'::regnamespace
 AND proname IN ('dfu_receber','dfu_contexto','dfu_recuperar_pendentes',
                 'dfu_ofertar','dfu_confirmar','dfu_aplicar_ia','dfu_assumir_atendimento');
```

Cadastre feriados e indisponibilidades do escritório:

```sql
INSERT INTO public.dfu_feriados(dia, descricao)
VALUES ('2026-12-25', 'Natal — sem atendimento')
ON CONFLICT(dia) DO UPDATE SET descricao = EXCLUDED.descricao;
```

O exemplo acima não substitui o calendário de feriados nacionais, estaduais, municipais, recesso ou férias; cadastre todos os dias bloqueados. **Horário de referência de atendimento: `America/Sao_Paulo` (Brasília).**

## 5. Importar o bot no n8n

1. Acesse o n8n da **homologação** e crie um workflow a partir da importação de arquivo.
2. Importe **`01-agentes-ia/n8n/DFU_BOT_UNICO_CRM.json`**.
3. Mantenha **Inactive**. Não ative até concluir os passos de configuração e testes.
4. Verifique os 27 nós e conexões. O fluxo contém:
   - webhook interno de sinalização (não recebe diretamente a Meta);
   - recuperação de entradas a cada 2 minutos;
   - OpenAI, triagem e agendamento por RPC no Supabase;
   - envio por WhatsApp a partir de uma outbox, rechecando autorização imediatamente antes de enviar;
   - follow-up diário **desabilitado por padrão**.
5. Informe, no ambiente privado da instância n8n, as variáveis do arquivo `01-agentes-ia/config.example.env`:

| Variável | Exemplo / significado | Estado recomendado inicialmente |
|---|---|---|
| `SUPABASE_URL` | URL `https://xxx.supabase.co` | Obrigatória |
| `OPENAI_MODEL` | Modelo compatível com Chat Completions em JSON mode | `gpt-4o-mini` |
| `META_PHONE_NUMBER_ID` | ID do número remetente na Meta | Obrigatória |
| `META_GRAPH_VERSION` | Versão Graph API disponível para sua conta | conferir na Meta (exemplo `v23.0`) |
| `MODO_TESTE` | Restringe envios a telefones liberados | **`true`** |
| `TELEFONES_TESTE` | Telefones `55DD9XXXXXXXX` separados por vírgula | Somente números próprios de teste |
| `COMPLIANCE_APROVADO` | Liberação jurídica/comercial de produção | **`false`** |
| `FOLLOWUP_ENABLED` | Follow-up comercial | **`false`** |
| `META_FOLLOWUP_TEMPLATE` | Template aprovado na Meta | Vazio inicialmente |

> Algumas configurações do n8n impedem `$env` em Code nodes. Isso deve ser validado na sua instalação; não habilite envio real apenas para contornar erros de configuração. **Não coloque tokens em arquivos JSON, em `NEXT_PUBLIC_*` ou em commits.**

### 5.1 Credenciais do n8n

Na interface **Credentials**, crie e associe manualmente:

| Nós | Tipo de autenticação | Segredo |
|---|---|---|
| Todas as chamadas `/rest/v1/rpc/dfu_*` | HTTP Request → Custom Auth | headers `apikey: SERVICE_ROLE_KEY` e `Authorization: Bearer SERVICE_ROLE_KEY` |
| `06 | OpenAI` | HTTP Request → Header Auth | `Authorization: Bearer OPENAI_API_KEY` |
| `17 | WhatsApp Cloud API` | HTTP Request → Header Auth | `Authorization: Bearer META_ACCESS_TOKEN` |
| `01 | Sinal interno da Edge` | Webhook → Header Auth | nome `X-DFU-Internal-Secret` e valor aleatório (igual à Edge) |

O botão de salvar uma credencial não garante que o nó esteja ligado à credencial. Abra cada nó e selecione sua credencial correta. Confira que chamadas Meta **não** têm retry automático (`Retry on Fail` desativado). Um timeout de envio pode significar entrega ambígua; não reenvie manualmente sem conciliação.

### 5.2 URL do webhook interno

Depois de salvar o workflow, obtenha a **Production URL** do webhook `01 | Sinal interno da Edge`, no caminho `dfu-meta-inbound` (quando o workflow for ativado durante os testes). Esta URL será colocada na Edge Function em `N8N_WEBHOOK_URL` e **não** será registrada na Meta. O acesso exige `X-DFU-Internal-Secret`. Guarde o segredo em local privado.

## 6. Implantar a Supabase Edge Function

A função está em **`02-backend-integracao/supabase/functions/meta-webhook/index.ts`**.

Exemplo com Supabase CLI instalado e logado (substitua `SEU_PROJECT_REF`):

```bash
cd 02-backend-integracao
supabase functions deploy meta-webhook --project-ref SEU_PROJECT_REF --no-verify-jwt
```

O `--no-verify-jwt` é necessário porque o webhook público da Meta não traz JWT do Supabase. **A função valida obrigatoriamente a assinatura criptográfica da Meta em cada POST**; não exponha outra rota que não faça a validação.

Configure os **Secrets da Edge Function** pelo painel Supabase ou CLI:

| Secret | Uso |
|---|---|
| `SUPABASE_URL` | URL do mesmo projeto do CRM (normalmente fornecida pelo Supabase) |
| `SUPABASE_SERVICE_ROLE_KEY` | Chave servidor para chamar `dfu_receber` (nunca pública) |
| `META_VERIFY_TOKEN` | Token aleatório que será informado na Meta para desafio GET |
| `META_APP_SECRET` | App Secret da Meta, usado na verificação HMAC SHA-256 |
| `N8N_WEBHOOK_URL` | Production URL da etapa 5.2 |
| `N8N_WEBHOOK_SECRET` | Mesmo valor do Header Auth do webhook do n8n |
| `META_ACCESS_TOKEN` | Opcional, para baixar áudio recebido espontaneamente |
| `OPENAI_API_KEY` | Opcional, para transcrever áudio; custos adicionais |
| `META_GRAPH_VERSION` | Versão Graph usada para baixar mídia |

Se `N8N_WEBHOOK_URL` ficar temporariamente indisponível, a entrada continua persistida no Supabase e o cron recupera a conversa após expirar o lease, quando a integração voltar. **Se o banco estiver indisponível, a Edge responde erro HTTP e a Meta poderá repetir o evento**, sem criar respostas duplicadas graças ao `provider_id` único.

### 6.1 Configurar a Meta

No painel do aplicativo WhatsApp Cloud API da Meta:

- **Callback URL:** `https://SEU_PROJECT_REF.supabase.co/functions/v1/meta-webhook`.
- **Verify token:** exatamente o `META_VERIFY_TOKEN` do passo anterior.
- Inscreva-se no campo de eventos **`messages`**.
- Use primeiro o número de teste e destinatários liberados na Meta.

A Meta fala somente com a Edge Function. A Edge comunica com o Supabase e, quando conveniente, sinaliza o n8n. Não exponha a chave de serviço na URL do webhook.

## 7. Atualizar o frontend CRM

O frontend permanece em `03-crm-frontend/`, com a mesma autenticação, perfis e agenda atuais. Apenas foi acrescentado:

- item **Conversas do bot** no menu existente;
- nova rota `/painel/atendimentos` com histórico, resumo factual, status, prioridade e botão **Assumir atendimento** para usuário autorizado.

Faça sua instalação habitual do frontend (sem alterar credenciais já corretas do CRM):

```bash
cd 03-crm-frontend
npm ci
npm run lint
npm run build
npm run dev
```

As variáveis do CRM continuam sendo as do projeto original, normalmente `NEXT_PUBLIC_SUPABASE_URL` e `NEXT_PUBLIC_SUPABASE_ANON_KEY` no `.env.local`. **Nunca use `SUPABASE_SERVICE_ROLE_KEY` em Next.js cliente.** A leitura das conversas utiliza RLS com a função original `pode_acessar_ficha`; outros advogados não recebem acesso a fichas alheias. O perfil `desenvolvedor` continua com seu escopo limitado.

**Teste de regressão da v2.1:** após instalar, abra `/painel` e confirme que a página original **Fila de atendimentos** e suas fichas continuam disponíveis. Depois abra `/painel/atendimentos` e confira que a nova página **Conversas do bot** é distinta. A v2.0 tinha sobrescrito a primeira rota por engano; esta versão restaurou o arquivo original.

A tela não substitui uma caixa de entrada de WhatsApp humano: permite visualização e desativação da automação para o atendimento específico, não o envio de mensagens manuais.

## 8. Como o bot atende e agenda

1. O cliente escreve no WhatsApp. A Meta chama a Edge, que verifica HMAC e **persiste a mensagem no Supabase** com idempotência por identificador da Meta.
2. Em primeiro contato, `dfu_receber` cria uma saudação fixa e registra o cliente. O envio fica na `dfu_outbox`.
3. Ao continuar a conversa, o bot usa a OpenAI, com o histórico e dados já coletados, para adaptar as perguntas ao caso. O roteiro especializado de **trabalho sem registro** cobre situação do vínculo, período, função, jornada, intervalo, salário, forma de pagamento e acidente, sem exigir todos os itens antes de oferecer consulta.
4. A IA devolve um **JSON de dados e ações**, nunca um horário por conta própria. O SQL valida a ação e constrói um resumo factual preliminar; o assistente não emite parecer ou promessa de êxito.
5. `dfu_ofertar` compara **área jurídica**, advogados ativos com `cargo='advogado'`, dias e janelas cadastradas em `disponibilidade_advogados`, duração individual, quantidade diária, feriados e compromissos já existentes.
6. A preferência é pelo especialista com **mais slots livres nos próximos sete dias**; desempate por atribuição mais antiga. Até três horários reais, preferindo datas distintas, são oferecidos ao cliente. A oferta vale 30 minutos.
7. Ao escolher expressamente 1, 2 ou 3, `dfu_confirmar` revalida a disponibilidade sob trava transacional, registra a reunião em `agenda_advogados` e cria/atualiza a ficha `fichas_clientes`. Só então o bot informa a confirmação.
8. O advogado visualiza a **reunião em sua agenda**, a ficha com o **resumo fático** e o histórico na tela Conversas do bot. A modalidade (presencial, chamada ou Meet) deve ser combinada pelo escritório; esta versão não cria evento Google externo.
9. Se houver pedido humano, risco, dúvida jurídica de mérito ou falta de agenda, o caso é encaminhado à equipe. Casos sem área jurídica identificável são mantidos em revisão técnica; **não** são classificados artificialmente como `civil`.

**Limitação de mídia:** textos são tratados diretamente; áudios podem ser transcritos se as credenciais opcionais estiverem configuradas; imagens e documentos não recebem análise automatizada do conteúdo nesta versão. Vídeos não são processados. Não prometa ao cliente que o bot analisou arquivo que não foi realmente interpretado.

## 9. Homologação antes de colocar em produção

Faça todos os testes em um projeto/instância de **homologação**, com **números de teste** e pessoas fictícias. Guarde os resultados.

| Teste | Resultado esperado |
|---|---|
| GET de challenge da Meta | Token correto retorna challenge; token incorreto `403` |
| POST Meta sem HMAC válido | `403`; não grava atendimento |
| Mensagem duplicada com mesmo `provider_id` | Uma única entrada, sem nova abertura |
| Primeiro contato | Uma única saudação fixa; conversa persistida |
| Texto sobre trabalho sem carteira | Perguntas relevantes sem repetição; resumo evolui |
| Texto fora de área | Encaminhamento humano, sem classificação fictícia |
| Dois textos recebidos rapidamente | Sem respostas contraditórias ou duplicadas; lease/recuperação funcionam |
| Falha OpenAI após gravar inbound | Recuperação periódica ou encaminhamento após limite de tentativas |
| Falha de rede após POST Meta | Outbox `AMBIGUO`; não reenviar automaticamente |
| Opt-out (`parar`) | Bloqueio persistente; no máximo uma confirmação |
| Horários ausentes / advogado inativo | Não inventar datas, encaminhar equipe |
| Mesmo horário escolhido por duas pessoas | No máximo uma reunião confirmada |
| Agendamento | Evento vinculado à ficha no CRM, com duração do advogado |
| Alteração manual da agenda | Trigger barra conflito entre reuniões ativas |
| Login de outro advogado | RLS impede leitura de casos alheios |
| Login desenvolvedor | Somente casos próprios de teste, sem herdar privilégios |
| `MODO_TESTE=true` e telefone fora da lista | Nenhuma mensagem real |
| `COMPLIANCE_APROVADO=false`, modo teste desativado | Nenhuma mensagem real |
| Entrada de processamentos de vídeo/documento | Sem análise inventada do conteúdo |

Execute a verificação estrutural incluída:

```bash
python 01-agentes-ia/tests/check_integration.py
```

Ela valida JSONs, conexões e scripts JavaScript dos nós, integridade das funções esperadas, segurança básica, presença da UI e preservação dos arquivos críticos. **Não substitui** execução real de SQL no PostgreSQL, teste de n8n, Next.js no navegador, Meta e OpenAI.

## 10. Operação, falhas e reconciliação

- Antes de ativar o workflow, monitore erros de execução e teste consultas ao Supabase. Mantenha logs sem relato bruto, CPF e tokens.
- Consulte periodicamente `public.dfu_outbox WHERE status='AMBIGUO'`; um envio pode ter ocorrido mesmo quando a API não confirmou. Conciliar com a Meta **antes** de uma intervenção manual.
- Monitore `public.dfu_atendimentos` com `status='humano'` e `advogado_id IS NULL`: demandam classificação e atribuição manual; o CRM não mostra ao usuário casos de terceiros sem responsável.
- Verifique diariamente o número de fichas, o resumo, o compromisso vinculado e o retorno dos clientes.
- A integração em `conversas_memoria` usa apenas memória curta; o histórico detalhado está em `dfu_mensagens`, restrito por RLS.
- O follow-up é opcional, com consentimento comprovado e **template aprovado** fora da janela de 24 horas. `FOLLOWUP_ENABLED=false` é a configuração inicial segura.
- Não troque a duração individual do advogado por 20 min: o bot usa `duracao_reuniao_min` do CRM.
- Se o workflow precisar mudar, use nova versão do JSON no repositório, importe em teste, valide e só depois publique na instância principal.

## 11. Reversão segura

1. **Pare os envios:** desative workflow n8n e desligue a Edge Function se necessário.
2. **Reverta apenas o frontend**, preservando backups e tabelas. O CRM permanece independente.
3. Se o trigger da agenda impedir uma operação manual, diferencie **mudança de status em evento antigo** (que a versão v2.1 já permite quando permanece ativo sem alterar horário) de **nova marcação/remarcação conflitante** (que deve ser bloqueada). Consulte o diagnóstico e ajuste o compromisso afetado em homologação. **Não desative o trigger em produção enquanto o bot puder agendar**, pois isso retira a garantia de não sobreposição.
4. **Não execute `DROP TABLE ... CASCADE`** para rollback: isso pode eliminar histórico, fichas e vínculos. Mudanças no SQL devem ser revertidas com migração revisada em ambiente de teste.
5. Revogue tokens expostos, se algum segredo foi incorretamente colocado em arquivo ou log.

## 12. Alterações futuras do CRM: contrato de manutenção

O CRM é a fonte de verdade. Para modificações frequentes:

- Não modificar `auth-provider`, funções de hierarquia (`pode_acessar_ficha`) ou `advogados.ts` só para corrigir um erro do bot.
- Ao alterar **nomes de campos, valores de áreas ou status**, atualizar os contratos em `05-contratos-compartilhados`, a migração SQL/novas RPCs e o prompt/nós do n8n de forma versionada.
- Alterações de calendário são primeiro testadas para **agendamento manual e automático**; ambos precisam respeitar a mesma prevenção de sobreposição.
- Se passar a existir agenda Google, use um sincronizador com regras de reconciliação, nunca crie um segundo calendário independente sem sincronização.
- Repositório único não significa deploy único: frontend, banco/Edge e n8n são atualizados e testados de forma independente.

**Estado desta entrega:** implementação em arquivos concluída; ainda dependente de instalação, credenciais, testes em ambiente real e análise de conformidade antes de produção.

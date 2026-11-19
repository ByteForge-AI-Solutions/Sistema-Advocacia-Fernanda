# CLAUDE.md

Guia para o Claude Code trabalhar neste repositório: Recepcionista Jurídico IA & CRM de Triagem do escritório **Dias e Fernandes Advocacia**.

## Estrutura do repositório

- `01-agentes-ia/`: fluxos n8n, prompts de triagem e regras multimodais.
- `02-backend-integracao/`: webhooks, travas de mídia, lógica de prioridade e APIs de tribunais.
- `03-crm-frontend/`: CRM em Next.js (App Router + TypeScript + Tailwind CSS), com `@supabase/supabase-js` e `lucide-react`.
- `04-banco-dados/`: `schema.sql` com a modelagem do Supabase (PostgreSQL).

Credenciais ficam em `.env`/`.env.local` (ignorados pelo git). Os dados são sensíveis (LGPD): nunca registre CPF, telefone ou relato de cliente em logs, commits ou fixtures reais.

## Banco de dados (`04-banco-dados/schema.sql`)

### `advogados`
Advogados titulares e estagiários do escritório.

| Coluna | Tipo | Observação |
|---|---|---|
| `id` | UUID PK | `gen_random_uuid()` |
| `nome` | TEXT NOT NULL | |
| `email` | TEXT UNIQUE | Usado para vincular ao login (Supabase Auth). O `schema.sql` não preenche, mas os e-mails já foram cadastrados direto no Supabase. |
| `cargo` | TEXT | `'advogado'` (padrão), `'socio'` (migração v4), `'estagiario'` ou `'desenvolvedor'` (conta de teste, seção 8). A v4 cria o CHECK `advogados_cargo_valido` com os 4 valores |
| `supervisor_id` | UUID FK → `advogados.id` | Preenchido **apenas** para estagiários |
| `areas_atuacao` | TEXT[] NOT NULL | Valores da lista de áreas abaixo |
| `ativo` | BOOLEAN | Padrão `true`; inativos não recebem casos |
| `ultima_atribuicao` | TIMESTAMPTZ | Controla o rodízio (round-robin): recebe o caso quem tem o valor mais antigo |
| `created_at` | TIMESTAMPTZ | |

### `fichas_clientes`
Ficha estruturada gerada pela IA ao fim da triagem.

| Coluna | Tipo | Observação |
|---|---|---|
| `id` | UUID PK | |
| `nome_cliente` | TEXT NOT NULL | |
| `cpf` | TEXT | Opcional |
| `telefone` | TEXT NOT NULL | Mesmo formato de `conversas_memoria.telefone_cliente` |
| `area_identificada` | TEXT NOT NULL | Uma das 6 áreas jurídicas |
| `prioridade` | TEXT NOT NULL | `'alta'`, `'media'` (padrão) ou `'baixa'` |
| `motivo_prioridade` | TEXT | Justificativa da urgência |
| `resumo_fatos` | TEXT NOT NULL | Resumo jurídico gerado pela IA |
| `documentos_urls` | TEXT[] | Arquivos enviados pelo cliente |
| `processos_encontrados` | JSONB | Resultado da consulta processual (array) |
| `advogado_id` | UUID FK → `advogados.id` | Responsável atribuído pelo roteamento |
| `status_atendimento` | TEXT | `'novo'` (padrão), `'em_analise'`, `'agendado'` ou `'finalizado'` |
| `created_at` | TIMESTAMPTZ | |
| `proxima_acao` / `proxima_acao_em` | TEXT (≤ 280) / TIMESTAMPTZ | Migração v5. **Regra de ouro:** lead ativo (status ≠ `finalizado`) não é salvo sem as duas. O trigger `crm_fichas_lead` cobra isso só em edição direta do CRM (`current_user = 'authenticated'`); bot e RPCs `SECURITY DEFINER` passam. O texto recusa CPF/CNPJ |
| `faixa_divida` | TEXT | v5: `'ate_50k'`, `'50k_100k'`, `'100k_500k'` ou `'acima_500k'`. Só a faixa, nunca o valor exato (LGPD) |
| `bloqueio_penhora` | BOOLEAN | v5: bloqueio de conta, penhora ou citação recebida. Quando verdadeiro, o lead é urgente |
| `dor_principal` | TEXT | v5: `'certidao'`, `'bens'`, `'execucao'`, `'parcelamento'` ou `'outra'` |
| `onde_divida` | TEXT[] | v5: subconjunto de `receita`, `pgfn`, `estado`, `municipio` e `justica` |
| `temperatura` | TEXT | v5, **calculada pelo banco** (`crm_temperatura_lead`): `'urgente'`, `'quente'`, `'morno'`, `'frio'` ou NULL (não qualificado). O espelho em `src/lib/leads.ts` (`calcularTemperatura`) precisa ficar igual |

Fila do CRM (`ordenarFila` em `03-crm-frontend/src/lib/fichas.ts`):
- **Ordem:** primeiro pelo **nível de atendimento**. Urgente vem antes de tudo; quente vale o mesmo que alta, morno o mesmo que média e frio o mesmo que baixa. Sem temperatura, vale a `prioridade` do bot. Depois, por `prioridade` e por `created_at`, da mais antiga para a mais nova.
- Como `prioridade` é TEXT, ordene com um mapeamento explícito, não alfabeticamente. A função também normaliza variações como `'Média'`/`'MEDIA'`.
- `buscarFichas` lê os campos v5 e, se a migração não estiver aplicada (`42703`), refaz a consulta sem eles. Nesse caso `lead.disponivel = false` e a tela esconde o que é de lead.

Regras de cor, conforme o documento "CRM de leads de anúncio", seção 4:
- **Urgente:** bloqueio ou penhora.
- **Quente:** acima de R$ 100 mil e dor de certidão, bens ou execução.
- **Morno:** acima de R$ 100 mil sem urgência. Também entra aqui o caso de até R$ 100 mil **com** dor urgente, que o documento não define.
- **Frio:** até R$ 100 mil sem urgência.
- **Ajuste:** dívida só na Receita e sem urgência desce uma cor.
- **Ainda não implementado:** o ajuste "respondeu em menos de 1 h sobe uma cor".

**RLS:** a função `pode_acessar_ficha(responsavel_id)` decide o acesso. A versão em vigor é a da migração `20261118_v4_cargo_socio.sql`; a seção 5 do `schema.sql` tem a versão antiga.
- **Sócio:** vê e edita as fichas de todo o escritório, exceto as de contas `desenvolvedor`, e pode delegar para qualquer titular ou estagiário.
- **Titular:** vê e edita as fichas dele e as dos estagiários que supervisiona, e pode delegar só para esses estagiários.
- **Estagiário:** vê e edita só as dele e não consegue repassá-las.
- **Fichas sem responsável** (`advogado_id` NULL): o titular vê as da área dele e o sócio vê todas, pela política `crm fichas sem responsavel`. Quem assume chama a RPC `crm_ficha_assumir`, que também atualiza `ultima_atribuicao`.
- INSERT e DELETE são exclusivos da `service_role` (bot n8n).

### `conversas_memoria`
Memória da conversa do agente no WhatsApp, uma linha por cliente.

| Coluna | Tipo | Observação |
|---|---|---|
| `telefone_cliente` | TEXT PK | Identifica a conversa |
| `historico_mensagens` | JSONB | Array de mensagens (padrão `[]`) |
| `status` | TEXT | Padrão `'em_andamento'` |
| `updated_at` | TIMESTAMPTZ | |

Não há FK entre `conversas_memoria` e `fichas_clientes`. A ligação é feita pelo telefone (`telefone_cliente` = `telefone`).

### `agenda_advogados`
Compromissos e reuniões dos advogados (seção 6 do `schema.sql`).

| Coluna | Tipo | Observação |
|---|---|---|
| `id` | UUID PK | |
| `advogado_id` | UUID NOT NULL FK → `advogados.id` | Responsável. Base do RLS. |
| `ficha_id` | UUID FK → `fichas_clientes.id` | Opcional (seção 7). `ON DELETE SET NULL`. O trigger `agenda_valida_ficha` só aceita fichas que o usuário consegue ver, e só checa quando a ficha é definida ou trocada. |
| `titulo_evento` | TEXT NOT NULL | Não pode ser vazio |
| `area_juridica` | TEXT NOT NULL | CHECK: uma das 6 áreas canônicas |
| `prioridade` | TEXT NOT NULL | CHECK: `'alta'`, `'media'` (padrão) ou `'baixa'` |
| `data_hora_inicio` | TIMESTAMPTZ NOT NULL | |
| `data_hora_fim` | TIMESTAMPTZ | Opcional; se preenchido, precisa ser depois do início |
| `status` | TEXT NOT NULL | CHECK: `'agendado'` (padrão), `'confirmado'`, `'realizado'` ou `'cancelado'` |
| `criado_em` | TIMESTAMPTZ | **No banco real é `criado_em`**, conferido em 18/11/2026. O `schema.sql` diz `created_at`, mas essa coluna não existe (dá `42703`). Já `fichas_clientes` e `advogados` usam `created_at`. |

Ao contrário das tabelas antigas, esta tem CHECKs no banco. O RLS usa a mesma `pode_acessar_ficha(advogado_id)`, mas aqui SELECT, INSERT, UPDATE e DELETE são liberados para a equipe responsável: o titular cuida dos próprios compromissos e dos seus estagiários, e o estagiário só dos dele. A chave `anon` não tem acesso.

### `disponibilidade_advogados`
Grade de atendimento: **uma linha por advogado por dia da semana** (seção 7.4). Essa é a estrutura real do Supabase, conferida em 17/11/2026; a tabela foi criada antes da seção 7, por isso **não** tem `dias_semana` nem `updated_at`.

| Coluna | Tipo | Observação |
|---|---|---|
| `id` | UUID PK | O CRM gera com `crypto.randomUUID()` ao criar um dia novo |
| `advogado_id` | UUID FK → `advogados.id` | |
| `dia_semana` | INTEGER | 0 = domingo ... 6 = sábado (igual a `Date#getDay` e `EXTRACT(DOW)`) |
| `hora_inicio` / `hora_fim` | TIME | Horário local de Brasília, sem fuso. Cada dia tem a própria janela |
| `duracao_reuniao_min` | INTEGER | Igual em todas as linhas do advogado (o CRM grava o mesmo valor) |
| `max_reunioes_dia` | INTEGER | Idem. Limite "confortável": gera aviso no formulário, não bloqueia |
| `ativo` | BOOLEAN | `false` = não atende naquele dia. Desmarcar um dia não apaga a linha |

Gravação: `salvarMinhaDisponibilidade` faz **um único upsert por `id`**, reaproveitando a linha existente de cada dia. Não há UNIQUE (advogado_id, dia_semana) garantido no banco; a leitura usa a primeira linha ativa de cada dia. RLS: leitura via `pode_acessar_ficha` (a própria grade e a dos estagiários, usada nos avisos de conflito). Escrita só da própria grade, via `advogado_atual_id()`.

Para diagnosticar divergências de estrutura sem a chave secreta: uma consulta REST com a chave anon e `limit=0` devolve `42703` se a coluna não existe e `42501` se existe (anon não tem permissão). Um filtro com valor inválido (`?col=eq.zz`) revela o tipo da coluna na mensagem de erro.

## Migrações, bot e arquivos protegidos

- `04-banco-dados/migrations/` é **incremental**. Nunca reexecute o `schema.sql` inteiro em banco existente. Ordem de aplicação:
  1. `00_diagnostico_preinstalacao.sql` (só leitura);
  2. `20261118_bot_unificado.sql` (bot v2.1: tabelas `dfu_*`, trigger `dfu_prevenir_sobreposicao_agenda`);
  3. `20261118_v3_crm_modulos.sql`;
  4. `20261118_v4_cargo_socio.sql`: cargo `socio`, nova `pode_acessar_ficha` e sócios no rodízio do bot. Ela redefine `dfu_ofertar`, `dfu_criar_ficha` e `dfu_confirmar`, cópias literais em que só muda o filtro de cargo. **Se a migração do bot for reaplicada, reaplique a v4 depois.**
  5. `20261118_v5_leads_posvenda.sql`: campos de lead em `fichas_clientes` (próxima ação, qualificação, temperatura) e categorias de pós-venda em `processos_prazos`. Não cria políticas novas, não redefine `pode_acessar_ficha` e não toca nas funções `dfu_*`.
  6. `20261118_v6_funil_followup.sql`: funil de 12 etapas, motivo de perda, cadência de follow-up e indicadores do funil.
     - Colunas novas em `fichas_clientes`: `etapa_funil`, `etapa_desde`, `motivo_perda`, `motivo_perda_detalhe`, `cadencia_desde` e `nao_contatar`.
     - O trigger `crm_fichas_lead` (v5) é substituído.
     - Novos: tabela `crm_followup_toques` e RPCs `crm_followup_registrar` e `crm_indicadores_funil`.
     - Não toca em `pode_acessar_ficha`, nas funções `dfu_*` nem em `crm_indicadores`.
  7. `20261119_v7_financeiro_documentos.sql`: cadastro do cliente, honorários e repositório de documentos.
     - Tabelas: `clientes_cadastro`, `fin_contratos`, `fin_parcelas` e `fichas_documentos`.
     - Bucket **privado** `documentos-clientes` (20 MB; PDF, imagens, DOCX e XLSX), com políticas em `storage.objects`.
     - Funções: `crm_pode_acessar_ficha_id`, `crm_pode_excluir` e `crm_pode_acessar_objeto`.
     - RPC `crm_fin_criar_contrato` e trigger `crm_fin_avancar_funil`.
     - Não toca em funções existentes nem em `pode_acessar_ficha`.
- **Hashes:** `01-agentes-ia/tests/check_integration.py` confere o SHA-256 de 8 arquivos: `advogados.ts`, `agenda.ts`, `disponibilidade.ts`, `fichas.ts`, `auth-provider.tsx`, `reuniao-modal.tsx`, `app/painel/page.tsx` e `schema.sql`.
  - **Não edite esses arquivos.** Crie funcionalidade em arquivos novos. Se a mudança for inevitável, atualize o hash no teste e avise a equipe do bot.
  - O hash ignora a diferença CRLF/LF.
  - Na v4 (18/11/2026), `advogados.ts`, `agenda.ts`, `fichas.ts`, `reuniao-modal.tsx` e `app/painel/page.tsx` foram alterados de propósito para o cargo `socio`, e os hashes foram renovados.
  - Na v5, só `fichas.ts` mudou (campos de lead e ordenação por cor), e o hash foi renovado.
  - Na v6, só `fichas.ts` mudou de novo (campos do funil com fallback), e o hash foi renovado.
  - Para rodar o teste no Windows: `py 01-agentes-ia/tests/check_integration.py`.
  - A última asserção falha enquanto existir `03-crm-frontend/.env.local`. Ela confere o pacote de entrega; na máquina de desenvolvimento, rode o teste numa cópia feita com `git ls-files -co --exclude-standard`.
- **Escrita nas `dfu_*`:** o CRM nunca escreve direto nelas. Usa as RPCs `crm_atendimento_*` (assumir, responder, transferir, devolver_bot, encerrar, etiquetas). Também chama a original `dfu_assumir_atendimento` no caso padrão.
- **Respostas humanas:** entram em `dfu_outbox` (tipo `'resposta'`, `autor_advogado_id` preenchido). O n8n as envia pelo nó "10 | Fila de saída (cada minuto)", com os mesmos portões de compliance. A RPC exige `status = 'humano'` e a janela de 24 h aberta.
- **Atendimento sem responsável** (`advogado_id` NULL): visível só a titulares da área (`cargo = 'advogado'`) e a todos os sócios, via `crm_titular_da_area`. Assumir atribui a quem assumiu.
- **Transferência:** o destino pode ser um titular ativo (advogado ou sócio) ou um estagiário que a pessoa supervisiona; o sócio pode transferir para qualquer estagiário.
- **Notas internas:** ficam em `dfu_notas_internas`, sem UPDATE/DELETE. `sistema = true` marca o registro automático das ações.
- **Prazos:** `processos_prazos` (RLS via `pode_acessar_ficha`). Estagiário não exclui; titular, sócio e desenvolvedor excluem. A data fatal é `date`: use `dataLocal()` para não deslocar o fuso.
- **Pós-venda (v5):** `processos_prazos.categoria`, definida em `CATEGORIA_INFO` (`src/lib/prazos.ts`):

  | Categoria | CNJ | Alerta | Observação |
  |---|---|---|---|
  | `processual` | obrigatório | 2 dias antes | prazo comum |
  | `execucao_fiscal` | obrigatório | 2 dias antes | 5 dias após a citação |
  | `embargos` | obrigatório | 5 dias antes | 30 dias após a garantia |
  | `parcela` | opcional | 5 dias antes | exige `acordo_ref`, `parcela_numero` e `parcela_total` |
  | `certidao` | opcional | 15 dias antes | validade de 180 dias |
  | `outro` | opcional | 2 dias antes | |

  - A janela de "urgente" de `urgenciaDoPrazo` segue a categoria.
  - `gerarParcelas` cria as parcelas mensais de uma vez.
  - `resumirAcordos` marca risco de rescisão com 3 parcelas seguidas ou 6 alternadas em atraso.
  - Valores de parcela não são gravados.
- **LGPD em textos livres:**
  - `contemDocumentoPessoal` (`src/lib/leads.ts`) detecta CPF/CNPJ válido, com ou sem pontuação.
  - Bloqueia o salvamento em: próxima ação, campos de prazo e etiquetas.
  - Em notas internas, pede confirmação.
- **Simulação (OAB):** `simularExemplo` roda só no navegador, nunca é gravada e sempre aparece como "exemplo" ("até", "depende da análise"). Não envie valores ou percentuais por escrito ao cliente.
- **Funil (v6):** `fichas_clientes.etapa_funil`. Etapas e regras ficam em `ETAPA_INFO` (`src/lib/funil.ts`); o CHECK do banco usa a mesma lista.
  - **Ativas:** `novo_lead`, `primeiro_contato`, `em_conversa`, `horario_confirmado`, `diagnostico_ofertado`, `diagnostico_pago`, `em_analise`, `proposta`, `cliente_ativo` e `encerrado`.
  - **Saídas:** `sem_resposta` e `perdido`.
  - **Motivo de perda obrigatório:** o CHECK `fichas_perdido_exige_motivo` vale para todos, inclusive a `service_role`. Valores: `preco`, `ja_tem_advogado`, `resolveu_sozinho`, `divida_pequena`, `sem_urgencia`, `nao_respondeu` e `desconfianca`. Ao sair de `perdido`, o trigger limpa o motivo.
  - **Etapa e status** são sincronizados pelo trigger:
    - quando a etapa muda, `status_atendimento` acompanha;
    - quando só o status muda (o bot), `agendado` move a etapa para `horario_confirmado` e `finalizado` para `encerrado`.
  - **Regra de ouro:** com a v6, lead ativo é `etapa_funil` fora de `encerrado`/`perdido`.
  - **Datas:** `etapa_desde` alimenta o alerta "parado além do tempo máximo". `cadencia_desde` reinicia a cada troca de etapa, exceto `primeiro_contato` → `sem_resposta`.
- **Follow-up (v6):** a cadência fica no código (`CADENCIAS` em `funil.ts`) e os toques feitos, no banco (`crm_followup_toques`, só SELECT e INSERT, RLS via `pode_acessar_ficha`).
  - **Quais toques:** `estadoCadencia` calcula o próximo pela etapa, por `cadencia_desde`, pelos toques do ciclo e pela última mensagem do cliente (`dfu_atendimentos.ultima_msg_cliente_em`).
  - **Lead respondeu:** em novo lead, primeiro contato e sem resposta, a cadência **pausa** e sugere "Em conversa". Nas demais etapas, recomeça a contar da resposta.
  - **Limites:** no máximo 1 toque por dia e nada aos domingos, exceto lead urgente.
  - **Opt-out:** `nao_contatar` ou opt-out no WhatsApp desliga tudo.
  - **Registro:** `registrarToque` usa a RPC `crm_followup_registrar` (SECURITY INVOKER), que grava o toque e a próxima ação numa transação só.
  - **Onde aparece:** os toques entram nas "Tarefas do dia" (`montarTarefas`) e na agenda mensal.
  - **Envio:** o envio de follow-up é feito pelo link wa.me (WhatsApp de quem atende), porque a API só aceita texto livre dentro da janela de 24 h.
- **Acesso aos dados da ficha (v7):** `crm_pode_acessar_ficha_id(ficha)` reproduz a visibilidade de `fichas_clientes`: `pode_acessar_ficha` mais as fichas sem responsável da área. Cadastro, documentos e arquivos usam essa regra. Contratos usam `pode_acessar_ficha(advogado_id)`. Excluir é só para titular, sócio e desenvolvedor (`crm_pode_excluir`); estagiário não exclui.
- **Cadastro do cliente (v7):** `clientes_cadastro`, uma linha por ficha, PF ou PJ.
  - `documento` guarda só dígitos (CPF 11 / CNPJ 14, com CHECK).
  - Dados de PJ: razão social, sede e representante.
  - **LGPD:** a fila e os indicadores nunca leem essa tabela; ela só é lida ao abrir o cadastro ou gerar um documento.
  - Validação (`src/lib/cadastro.ts`): dígitos verificadores, e nada de CPF/CNPJ em nome ou endereço.
- **Honorários (v7):**
  - **Contratos:** `fin_contratos` com tipo `diagnostico`, `honorarios`, `exito` ou `outro`. Se a ficha for excluída, a exclusão é bloqueada (RESTRICT) para preservar o histórico.
  - **Parcelas:** `fin_parcelas`. Pagamento registrado por inteiro: `pago_em` + `valor_pago` + `meio`. O comprovante tem de ser um documento da mesma ficha.
  - **Status calculado** (`statusParcela`/`resumoContrato`): Pago, Pendente ou Atrasado (vencimento antes de hoje e sem pagamento).
  - **Criação:** `crm_fin_criar_contrato` (SECURITY INVOKER) é atômica e exige que a soma das parcelas bata com o total. `dividirParcelas` trabalha em centavos.
  - **Funil:** o 1º pagamento confirmado move o lead (trigger SECURITY DEFINER, que só avança e define a próxima ação):
    - contrato `diagnostico` → `diagnostico_pago`;
    - `honorarios`/`exito` → `cliente_ativo`.
  - **Página `/painel/financeiro`:** atrasadas, a vencer em 30 dias e recebidas no mês, com filtro por advogado.
- **Repositório (v7):** `fichas_documentos` + Storage.
  - **Caminho:** `<ficha_id>/<uuid>.<ext>`. O nome original não vai para o caminho (LGPD), e o RLS do Storage confere o 1º segmento.
  - **Download:** só por URL assinada de 2 minutos (`urlTemporaria`); nunca `getPublicUrl`.
  - **Sem UPDATE:** para trocar um arquivo, envie uma nova versão.
  - **Envio:** se o registro do metadado falhar, o arquivo enviado é removido.
- **Documentos gerados (v7):** o gerador preenche a qualificação a partir de `clientes_cadastro` (PF ou PJ) e o valor, o percentual de êxito, a forma de pagamento e o objeto a partir do contrato de honorários mais recente.
  - O que for alterado no gerador só vai para o cadastro se o usuário marcar a opção.
  - Saídas: "Imprimir / salvar PDF" (iframe A4) e "Copiar formatado" (HTML + texto na área de transferência).
- **Mensagens prontas (v6):** `src/lib/mensagens-prontas.ts`, com SPIN e objeções.
  - Variáveis: `{nome}`, `{advogado}` e `{oab}` (a OAB vem dos dados do escritório no gerador de documentos).
  - No chat, o painel "Mensagens prontas" só preenche o campo de resposta, nunca envia sozinho.
  - Antes de enviar: variáveis pendentes bloqueiam o envio, e `avisosOab` (valor, percentual, promessa de resultado) pede confirmação.
  - O teste de integração reprova mensagem pronta com `R$`, `%`, "garant…" ou "com certeza".
- **Google Calendar (preparação):**
  - colunas `google_*` e `link_reuniao` em `agenda_advogados`;
  - fila `agenda_google_fila`, alimentada pelo trigger `crm_agenda_google_sync` apenas para advogados com `agenda_google_contas.ativo`;
  - RPCs do worker: `crm_google_retirar_fila`, `crm_google_concluir` e `crm_google_aplicar_alteracao`, esta com `crm.origem_sync = 'google'` para não gerar eco;
  - Edge Function `02-backend-integracao/supabase/functions/google-calendar-webhook`.
- **Indicadores:** RPC `crm_indicadores` (só contagens). Só o **sócio** tem o escopo `escritorio`. Advogado, estagiário e desenvolvedor veem o próprio escopo, que inclui os estagiários supervisionados. Contas `desenvolvedor` ficam fora da visão do escritório.

## Hierarquia: sócios, titulares e estagiários

- **Sócio:** `cargo = 'socio'` e `supervisor_id = NULL`. São os donos do escritório (Fernanda e Kayo, promovidos depois da v4).
  - Atua como titular: entra no rodízio do bot, tem agenda própria, recebe e assume atendimentos e pode supervisionar estagiários.
  - Tem supervisão total: vê, edita e filtra fichas, atendimentos, agenda, prazos e indicadores de todo o escritório.
  - O isolamento continua: registros atribuídos a contas `desenvolvedor` ficam fora. `pode_acessar_ficha` usa uma lista explícita (`advogado`, `socio`, `estagiario`) para o responsável.
- **Titular:** `cargo = 'advogado'` e `supervisor_id = NULL`. "Titular" no código (`ehTitular`) significa advogado **ou** sócio.
- **Estagiário:** `cargo = 'estagiario'` e `supervisor_id` aponta para o titular que supervisiona (autorrelacionamento em `advogados`).
- **Desenvolvedor:** `cargo = 'desenvolvedor'` e `supervisor_id = NULL`. É uma conta de teste e manutenção. Tem o mesmo escopo do estagiário: vê e edita **só o que está atribuído ao próprio id** (fichas, agenda e disponibilidade de teste) e não supervisiona ninguém. Não tem acesso de leitura a dados reais de clientes (LGPD). A sidebar mostra o selo "Modo desenvolvedor".

Equipe atual (seed):

| Nome | Cargo | Áreas | Supervisor |
|---|---|---|---|
| Fernanda Lemos Fernandes Rigo | advogado → **socio** (v4) | trabalhista, empresarial | — |
| Kayo Ronnaro Silva Dias | advogado → **socio** (v4) | civil | — |
| Guilherme Alves da Silva | advogado | cartorario_reurb | — |
| Karolina Kedma Araujo | advogado | trabalhista, previdenciario | — |
| Caio Pereira Melo | advogado | tributario | — |
| Ana Júlia Rodrigues de Souza | estagiario | trabalhista | Fernanda |

Regras confirmadas:
- **Rodízio automático (bot):** só entram `cargo IN ('advogado', 'socio') AND ativo = true`, desde a v4. Estagiários e desenvolvedores **nunca** recebem fichas do bot. O filtro precisa ser uma lista explícita, e não `<> 'estagiario'`.
- **Delegação:** o estagiário só recebe uma ficha quando o titular supervisor a delega manualmente no CRM.
- **Validação de cargo:** é feita no código do CRM e, desde a v4, também no banco, pelo CHECK `advogados_cargo_valido`. A função `validarPerfil` em `03-crm-frontend/src/lib/advogados.ts` exige três coisas:
  - que `cargo` esteja em `CARGOS` (`'advogado'`, `'socio'`, `'estagiario'`, `'desenvolvedor'`);
  - que titular, sócio e desenvolvedor não tenham supervisor;
  - que o estagiário tenha.

  **Ordem de implantação de um cargo novo:** migração, depois deploy do CRM, depois o UPDATE dos usuários. O CRM antigo desloga quem tiver um cargo que ele não conhece. Ao criar um cargo novo, atualize também `pode_acessar_ficha` (seção 5.2); sem isso, o RLS esconde tudo do usuário sem dar erro. Reutilize essa função em qualquer tela que crie ou edite advogados.
- **Login:** o `email` de todos (titulares e estagiária) já está preenchido. O usuário do Supabase Auth é ligado ao registro em `advogados` pelo e-mail, sem diferenciar maiúsculas de minúsculas. Usuário sem registro, inativo ou com cargo inválido é deslogado na hora.

## As 6 áreas jurídicas

Esses são os valores canônicos usados em `areas_atuacao` e `area_identificada`: minúsculos, sem acento, com `_`.

| Valor | Área | Titular(es) |
|---|---|---|
| `trabalhista` | Direito do Trabalho | Fernanda + Karolina (rodízio por `ultima_atribuicao`) |
| `empresarial` | Direito Empresarial | Fernanda |
| `civil` | Direito Civil | Kayo |
| `cartorario_reurb` | Cartorário / REURB (regularização fundiária) | Guilherme |
| `previdenciario` | Direito Previdenciário | Karolina |
| `tributario` | Direito Tributário | Caio |

Ao atribuir um caso, atualize `ultima_atribuicao = now()` do advogado escolhido para manter o rodízio equilibrado.

## Frontend (`03-crm-frontend/`)

Comandos (rodar dentro de `03-crm-frontend/`):
- `npm run dev`: servidor de desenvolvimento
- `npm run build`: build de produção
- `npm run lint`: lint

As variáveis do Supabase ficam em `03-crm-frontend/.env.local`: `NEXT_PUBLIC_SUPABASE_URL` e `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Nunca exponha a `service_role` key no client.

É Next.js 16: leia `03-crm-frontend/AGENTS.md` e a documentação em `node_modules/next/dist/docs/` antes de usar APIs do framework.

Organização:
- `src/lib/supabase/client.ts`: cliente Supabase do navegador (singleton).
- `src/lib/advogados.ts`: tipos `Advogado`/`Cargo`/`AreaJuridica`, rótulos das áreas, `validarPerfil` e `buscarPerfilPorEmail`.
- `src/components/auth-provider.tsx`: contexto de autenticação (`useAuth()` → `estado`, `perfil`, `entrar`, `sair`). O perfil vindo de `advogados` fica disponível para todo o app.
- `src/lib/fichas.ts`: tipos `Ficha`/`Prioridade`/`StatusAtendimento`, `ordenarFila` e `buscarFichas(perfil)`, que aplica a regra titular/estagiário. CPF não é carregado na listagem (LGPD).
- `src/lib/leads.ts` (v5): qualificação, `calcularTemperatura`, `TEMPERATURA_INFO` (cores), `situacaoProximaAcao`, `contemDocumentoPessoal`/`mascararDocumento`, `simularExemplo` e `salvarLead`.
- `src/components/fichas/editar-lead-modal.tsx` (v5/v6): botão "Editar lead" no cartão. Edita etapa do funil (ou status, sem a v6), motivo de perda, "não contatar", próxima ação (obrigatória), qualificação com prévia da cor e a simulação de exemplo. Ao trocar de etapa, sugere o 1º toque da cadência. Não mostra nem edita CPF.
- `src/lib/funil.ts` + `src/components/fichas/tarefas-do-dia.tsx` + `registrar-toque-modal.tsx` (v6): funil, cadência, tarefas do dia e registro de toque com mensagem sugerida e link wa.me.
- `src/lib/mensagens-prontas.ts` + `src/components/atendimentos/mensagens-prontas-painel.tsx` (v6): biblioteca de mensagens no chat.
- `src/lib/cadastro.ts`, `src/lib/financeiro.ts`, `src/lib/repositorio.ts` + `src/components/clientes/*` (v7):
  - botão "Cliente e honorários" no cartão da ficha, que abre o `FichaClienteModal` com as abas Cadastro, Honorários e Documentos;
  - `registrar-pagamento-modal.tsx`, compartilhado com `src/app/painel/financeiro`.
- `src/components/fichas/`: `badges.tsx` (cores de prioridade e status e a etiqueta "Sob supervisão - Nome"), `ficha-card.tsx` e `fila-fichas.tsx` (filtros por status e resumo por prioridade).
- `src/components/esqueci-senha-modal.tsx`: modal que chama `resetPasswordForEmail` com `redirectTo` apontando para `/redefinir-senha`.
- `src/lib/agenda.ts`: interface `AgendaAdvogado` (espelho da tabela) e `EventoAgenda` (+ estagiário). `buscarAgenda(perfil)` aplica a regra titular/estagiário e ordena por `data_hora_inicio` crescente.
- Funções de equipe em `advogados.ts`:
  - `buscarEquipeVisivel(perfil)` devolve as pessoas cujos registros o usuário vê, com ele primeiro: o sócio recebe o escritório todo, sem desenvolvedores; o titular recebe ele mais os estagiários; os demais, só a si mesmos. Fichas, agenda e prazos montam IDs, nomes e filtros por advogado com ela, espelhando `pode_acessar_ficha`.
  - `buscarEstagiariosSupervisionados(perfil)` devolve só os estagiários do titular ou sócio.
  - `ehTitular`, `ehSocio` e `rotuloMembro` são auxiliares.
  - `Ficha`, `EventoAgenda` e `PrazoNaTela` têm `responsavel`, preenchido quando o responsável não é o usuário, e `estagiario`. Na tela, os dois viram `VinculoBadge`.
- `src/components/painel/sidebar.tsx`: menu lateral (desktop) e abas no topo (mobile). Para adicionar uma página, inclua o item em `ITENS`.
- `src/app/login`: tela de login. `src/app/redefinir-senha`: destino do link de recuperação (`updateUser({ password })`).
- `src/app/painel/layout.tsx`: protege todas as rotas `/painel/*` (manda para `/login` sem sessão) e renderiza a Sidebar. As páginas internas podem assumir que `useAuth().perfil` existe.
- `src/app/painel/page.tsx`: fila de fichas. `src/app/painel/agenda/page.tsx`: agenda de reuniões em cartões, agrupada por dia, com filtro Próximos/Todos e o botão "Nova reunião". Clicar num cartão abre a edição.
- `src/components/agenda/reuniao-modal.tsx`: formulário de criar e editar reunião. O responsável só pode ser o usuário ou os estagiários dele. Ao escolher uma ficha, sugere área, prioridade e título. Mostra avisos (não bloqueiam) de dia ou horário fora da grade, limite diário e conflito de horário.
- `src/app/painel/disponibilidade/page.tsx` + `src/lib/disponibilidade.ts`: grade do próprio advogado (uma linha por dia, upsert por `id`).
- **v3 (migração `20261118_v3_crm_modulos.sql`):**
  - `src/app/painel/atendimentos` (inbox em 3 colunas) + `src/components/atendimentos/*` + `src/lib/atendimentos.ts`.
  - `src/app/painel/processos` + `src/components/processos/prazo-modal.tsx` + `src/lib/prazos.ts` (validação CNJ e calculadora de prazo).
  - `src/components/agenda/calendario-mensal.tsx`: visão mensal da agenda, com os prazos fatais.
  - `src/components/documentos/gerar-documentos-modal.tsx` + `src/lib/documentos.ts`: modelos, edição e impressão.
  - `src/app/painel/dashboard` + `src/lib/indicadores.ts`.
  - O menu (`sidebar.tsx`) é organizado em `SECOES`.
- `src/lib/datas.ts`: utilitários de data local (`chaveDia`, conversão de `datetime-local`). `src/components/toast.tsx`: aviso de sucesso.
- A rota `/` redireciona para `/painel`.

A URL `<domínio>/redefinir-senha` precisa estar em *Authentication → URL Configuration → Redirect URLs* no Supabase (em localhost e em produção).

Na máquina de desenvolvimento, `npm run build` pode falhar por falta de memória (pouca RAM livre). Valide com `npx tsc --noEmit`, `npx eslint` e `npm run dev`.

A autenticação roda no client (sessão no `localStorage`, gerenciada pelo supabase-js). Por isso a proteção real dos dados precisa vir do **RLS no Supabase**, não do redirecionamento de rotas.

Identidade visual: azul-marinho (`navy-*`, definido em `src/app/globals.css`) com cinza-ardósia (`slate-*` do Tailwind).

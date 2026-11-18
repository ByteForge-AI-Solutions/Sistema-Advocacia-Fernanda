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
| `cargo` | TEXT | `'advogado'` (padrão), `'estagiario'` ou `'desenvolvedor'` (conta de teste, seção 8) |
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

No CRM, a fila de cada advogado é ordenada por `prioridade` (alta → média → baixa) e depois por `created_at`, da mais antiga para a mais nova. Como `prioridade` é TEXT, ordene com um mapeamento explícito, não alfabeticamente. Essa lógica está em `ordenarFila` (`03-crm-frontend/src/lib/fichas.ts`), que também normaliza variações como `'Média'`/`'MEDIA'`.

**RLS** (seção 5 do `schema.sql`): a função `pode_acessar_ficha(responsavel_id)` decide o acesso. O titular vê e edita as fichas dele e as dos estagiários que supervisiona, e pode delegar só para esses estagiários. O estagiário vê e edita só as dele e não consegue repassá-las. INSERT e DELETE são exclusivos da `service_role` (bot n8n).

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
| `created_at` | TIMESTAMPTZ | |

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

## Hierarquia: titulares e estagiários

- **Titular:** `cargo = 'advogado'` e `supervisor_id = NULL`.
- **Estagiário:** `cargo = 'estagiario'` e `supervisor_id` aponta para o titular que supervisiona (autorrelacionamento em `advogados`).
- **Desenvolvedor:** `cargo = 'desenvolvedor'` e `supervisor_id = NULL`. É uma conta de teste e manutenção. Tem o mesmo escopo do estagiário: vê e edita **só o que está atribuído ao próprio id** (fichas, agenda e disponibilidade de teste) e não supervisiona ninguém. Não tem acesso de leitura a dados reais de clientes (LGPD). A sidebar mostra o selo "Modo desenvolvedor".

Equipe atual (seed):

| Nome | Cargo | Áreas | Supervisor |
|---|---|---|---|
| Fernanda Lemos Fernandes Rigo | advogado | trabalhista, empresarial | — |
| Kayo Ronnaro Silva Dias | advogado | civil | — |
| Guilherme Alves da Silva | advogado | cartorario_reurb | — |
| Karolina Kedma Araujo | advogado | trabalhista, previdenciario | — |
| Caio Pereira Melo | advogado | tributario | — |
| Ana Júlia Rodrigues de Souza | estagiario | trabalhista | Fernanda |

Regras confirmadas:
- **Rodízio automático (bot):** só entram `cargo = 'advogado' AND ativo = true`. Estagiários e desenvolvedores **nunca** recebem fichas do bot. O filtro precisa ser `= 'advogado'`, e não `<> 'estagiario'`.
- **Delegação:** o estagiário só recebe uma ficha quando o titular supervisor a delega manualmente no CRM.
- **Validação de cargo:** é feita no código do CRM. O `schema.sql` não cria CHECK; a seção 8.1 só atualiza um CHECK de cargo se já existir um no banco. A função `validarPerfil` em `03-crm-frontend/src/lib/advogados.ts` exige que `cargo` esteja em `CARGOS` (`'advogado'`, `'estagiario'`, `'desenvolvedor'`), que titular e desenvolvedor não tenham supervisor e que o estagiário tenha. Ao criar um cargo novo, atualize também `pode_acessar_ficha` (seção 5.2); sem isso, o RLS esconde tudo do usuário sem dar erro. Reutilize essa função em qualquer tela que crie ou edite advogados.
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
- `src/components/fichas/`: `badges.tsx` (cores de prioridade e status e a etiqueta "Sob supervisão - Nome"), `ficha-card.tsx` e `fila-fichas.tsx` (filtros por status e resumo por prioridade).
- `src/components/esqueci-senha-modal.tsx`: modal que chama `resetPasswordForEmail` com `redirectTo` apontando para `/redefinir-senha`.
- `src/lib/agenda.ts`: interface `AgendaAdvogado` (espelho da tabela) e `EventoAgenda` (+ estagiário). `buscarAgenda(perfil)` aplica a regra titular/estagiário e ordena por `data_hora_inicio` crescente.
- `buscarEstagiariosSupervisionados(perfil)` (em `advogados.ts`) devolve a equipe do titular. É usada pela fila e pela agenda para montar os IDs visíveis, espelhando `pode_acessar_ficha`.
- `src/components/painel/sidebar.tsx`: menu lateral (desktop) e abas no topo (mobile). Para adicionar uma página, inclua o item em `ITENS`.
- `src/app/login`: tela de login. `src/app/redefinir-senha`: destino do link de recuperação (`updateUser({ password })`).
- `src/app/painel/layout.tsx`: protege todas as rotas `/painel/*` (manda para `/login` sem sessão) e renderiza a Sidebar. As páginas internas podem assumir que `useAuth().perfil` existe.
- `src/app/painel/page.tsx`: fila de fichas. `src/app/painel/agenda/page.tsx`: agenda de reuniões em cartões, agrupada por dia, com filtro Próximos/Todos e o botão "Nova reunião". Clicar num cartão abre a edição.
- `src/components/agenda/reuniao-modal.tsx`: formulário de criar e editar reunião. O responsável só pode ser o usuário ou os estagiários dele. Ao escolher uma ficha, sugere área, prioridade e título. Mostra avisos (não bloqueiam) de dia ou horário fora da grade, limite diário e conflito de horário.
- `src/app/painel/disponibilidade/page.tsx` + `src/lib/disponibilidade.ts`: grade do próprio advogado (upsert por `advogado_id`).
- `src/lib/datas.ts`: utilitários de data local (`chaveDia`, conversão de `datetime-local`). `src/components/toast.tsx`: aviso de sucesso.
- A rota `/` redireciona para `/painel`.

A URL `<domínio>/redefinir-senha` precisa estar em *Authentication → URL Configuration → Redirect URLs* no Supabase (em localhost e em produção).

Na máquina de desenvolvimento, `npm run build` pode falhar por falta de memória (pouca RAM livre). Valide com `npx tsc --noEmit`, `npx eslint` e `npm run dev`.

A autenticação roda no client (sessão no `localStorage`, gerenciada pelo supabase-js). Por isso a proteção real dos dados precisa vir do **RLS no Supabase**, não do redirecionamento de rotas.

Identidade visual: azul-marinho (`navy-*`, definido em `src/app/globals.css`) com cinza-ardósia (`slate-*` do Tailwind).

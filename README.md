Bot unificado de recepção e triagem jurídica via WhatsApp com IA multimodal, geração automática de fichas e CRM com roteamento inteligente entre 5 advogados especialistas.

# ⚖️ Recepcionista Jurídico IA & CRM de Triagem

Sistema automatizado de atendimento, triagem multimodal e gestão de leads jurídicos desenvolvido para o escritório **Dias e Fernandes Advocacia**[cite: 1].

## 🎯 Objetivo do Projeto
Automatizar o primeiro atendimento via WhatsApp utilizando um **Agente de IA Unificado** capaz de conduzir triagens inteligentes em múltiplas áreas do Direito, interpretar diferentes formatos de mídia, estruturar fichas cadastrais e distribuir os casos por especialidade e ordem de prioridade entre os 5 advogados do escritório.

## 🚀 Principais Funcionalidades
* **Agente de Triagem Unificado:** Um único fluxo inteligente identifica a natureza jurídica da demanda e conduz as perguntas específicas para cada área do Direito.
* **Atendimento Multimodal:** Leitura e interpretação nativa de mensagens de texto, áudios, imagens e documentos (PDFs, contratos, CTPS, comprovantes), com bloqueio automático para arquivos de vídeo.
* **Geração de Ficha Estruturada:** Extração dos dados do cliente, nível de urgência e resumo jurídico dos fatos em formato JSON padronizado.
* **Roteamento Inteligente & Rodízio (Round-Robin):** Distribuição automática das fichas no banco de dados para o advogado competente da área, equilibrando a fila quando há mais de um especialista no mesmo ramo:
  * **Trabalhista:** Fernanda Lemos Fernandes Rigo / Karolina Kedma Araujo (Rodízio automático)
  * **Empresarial:** Fernanda Lemos Fernandes Rigo
  * **Previdenciário:** Karolina Kedma Araujo
  * **Civil:** Kayo Ronnaro Silva Dias
  * **Cartorário / REURB:** Guilherme Alves da Silva
  * **Tributário:** Caio Pereira Melo
* **Fila de Prioridade no CRM:** Ordenação automática dos atendimentos por nível de urgência (`Alta`, `Média`, `Baixa`) no painel individual de cada advogado.
* **Enriquecimento Processual:** Consulta automatizada de processos e movimentações em bases jurídicas para complementar a ficha antes da reunião com o advogado.

## 📂 Estrutura do Repositório
* `01-agentes-ia/` — Fluxos de automação (n8n), prompts de triagem e regras de processamento multimodal.
* `02-backend-integracao/` — Webhooks, travas de mídia, lógica de prioridade e integração com APIs de tribunais.
* `03-crm-frontend/` — Interface web (Next.js) utilizada pelos advogados para gestão das fichas.
* `04-banco-dados/` — Scripts SQL (`schema.sql`) e modelagem das tabelas do Supabase.

## 🛠️ Stack Tecnológica
* **IA & Orquestração:** APIs de LLMs Multimodais + n8n
* **Banco de Dados & Auth:** Supabase (PostgreSQL)[cite: 1]
* **Canal de Entrada:** WhatsApp API
* **Frontend CRM:** Next.js, Tailwind CSS e Vercel

## 🔒 Segurança e Privacidade
* Desenvolvido em conformidade com a **LGPD** para guarda e tratamento de dados sensíveis.
* Credenciais, tokens e chaves de API isolados em arquivos `.env` (bloqueados via `.gitignore`).

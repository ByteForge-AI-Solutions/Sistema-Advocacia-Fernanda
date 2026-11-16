# Sistema-Advocacia-Fernanda
Sistema multi-agente de recepção e triagem jurídica via WhatsApp (Trabalhista e Geral) com processamento multimodal, geração automática de fichas e CRM com fila de prioridade para advogados.

# ⚖️ Recepcionista Jurídico IA & CRM de Triagem

Sistema automatizado de atendimento, triagem e gestão de leads jurídicos desenvolvido para o escritório **Dias e Fernandes Advocacia**[cite: 1].

## 🎯 Objetivo do Projeto
Automatizar o primeiro atendimento via WhatsApp utilizando agentes de Inteligência Artificial especializados (Áreas **Trabalhista** e **Jurídica Geral**), capazes de interagir entre si, processar múltiplas mídias, estruturar fichas cadastrais e distribuir os casos por ordem de prioridade para os advogados responsáveis.

## 🚀 Principais Funcionalidades
* **Arquitetura Multi-Agente (Handoff):** Comunicação inteligente entre o bot de triagem trabalhista e o bot jurídico geral, transferindo o contexto da conversa automaticamente caso o cliente entre no canal incorreto.
* **Atendimento Multimodal:** Suporte completo para leitura e interpretação de mensagens de texto, áudios, imagens e documentos (PDFs, contratos, CTPS), com bloqueio automático para arquivos de vídeo.
* **Geração de Ficha Estruturada:** Extração de dados do cliente e resumo dos fatos em formato JSON padronizado ao final da triagem.
* **CRM e Roteamento Inteligente:** Catalogação das fichas no banco de dados com atribuição automática para o advogado competente da área e ordenação por nível de urgência/prioridade.
* **Integração Processual:** Consulta de metadados e históricos processuais em bases jurídicas para enriquecimento da ficha antes do atendimento humano.

## 🛠️ Stack Tecnológica
* **IA & Orquestração:** APIs de LLMs Multimodais / Agentes Orquestrados
* **Banco de Dados & Backend:** Supabase (PostgreSQL)[cite: 1]
* **Canal de Entrada:** WhatsApp API
* **Frontend:** Painel Web (CRM para advogados)

## 🔒 Segurança e Privacidade
* Projeto desenvolvido em conformidade com a **LGPD** para tratamento de dados sensíveis.
* Variáveis de ambiente e chaves de API isoladas em `.env` (nunca versionadas no repositório).

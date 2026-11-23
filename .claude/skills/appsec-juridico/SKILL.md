---
name: appsec-juridico
description: Auditoria e blindagem completa de cibersegurança para CRM jurídico (Next.js + Supabase), combinando OWASP Top 10, Zero Trust/RLS, Storage privado, validação estrita e compliance LGPD/OAB.
---

# Diretrizes de Segurança Impecável (AppSec Jurídico + OWASP)

Sempre que criar, revisar ou modificar código neste repositório, aplique rigorosamente todos os controles abaixo:

## 1. Zero Trust, Banco de Dados & RLS (Supabase)
- Nenhuma tabela no Supabase pode existir sem `ENABLE ROW LEVEL SECURITY`.
- Nenhuma política pode usar `USING (true)` de forma irrestrita para usuários autenticados.
- Contas de desenvolvedor (`is_dev = true` ou equivalente) nunca podem visualizar, listar ou alterar registros de advogados/sócios reais, e vice-versa.
- Estagiários nunca podem excluir registros financeiros, contratos, documentos ou fichas.
- Todas as funções `SECURITY DEFINER` no PostgreSQL devem definir explicitamente `SET search_path = ''` (ou `public`) e validar permissões do chamador para evitar escalonamento de privilégios. O padrão deste repositório é `SET search_path = ''`, com todos os objetos qualificados (`public.tabela`, `auth.jwt()`): é o mais restritivo e não deve ser trocado por `public` nas funções existentes.

## 2. OWASP Top 10, APIs, Server Actions & Validação
- **Controle de Acesso & Anti-IDOR:** Nunca confie apenas na interface (UI). Valide sessão autenticada, cargo (`role`) e vínculo com o registro no servidor (Server Actions / Route Handlers) antes de qualquer leitura, edição ou exclusão.
- **Validação Estrita de Inputs:** Todo payload externo, formulário ou Server Action deve ser validado no servidor com schemas estritos (ex: Zod), rejeitando campos inesperados e prevenindo Injection (SQL/NoSQL/Command).
- **Segredos e Variáveis de Ambiente:** Nunca exponha `SUPABASE_SERVICE_ROLE_KEY` ou tokens privados no front-end ou em variáveis `NEXT_PUBLIC_`.
- **Webhooks & Integrações:** Endpoints de webhook (bot/WhatsApp) devem validar assinatura criptográfica ou token secreto via header antes de processar qualquer dado, além de aplicar rate limiting.
- **Prevenção de SSRF e CSRF:** Bloqueie redirecionamentos abertos e requisições servidor-servidor para URLs não validadas; garanta proteção nativa contra CSRF nas mutações.

## 3. Proteção de Arquivos e Storage (LGPD)
- Buckets devem ser estritamente privados (`public = false`).
- Acesso a documentos apenas via Signed URLs temporárias (máximo 120 segundos).
- Bloqueio rigoroso de MIME types ativos/perigosos (HTML, SVG, JS, executáveis) e validação do tipo real e tamanho máximo no servidor para prevenir Stored XSS.
- Nomes de arquivos armazenados no Storage devem ser UUIDs anônimos; nunca incluir nomes de clientes, CPFs ou CNPJs na URL ou caminho do arquivo.

## 4. Hardening Web, Logs e Compliance OAB/LGPD
- **Headers de Segurança HTTP:** Manter no `next.config` os headers `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` e `Content-Security-Policy` (CSP) ajustada ao Supabase.
- **Higiene de Logs e Erros:** Nunca registrar tokens, chaves de API, CPFs, CNPJs ou dados sensíveis em `console.log` ou expor stack traces nas respostas de erro ao cliente.
- **Travamento OAB/LGPD:** Garantir que textos livres de triagem/etiquetas não armazenem CPF/CNPJ e que scripts/automações respeitem a flag `Não contatar` e as regras éticas da OAB.
- **Dependências:** Verificar vulnerabilidades conhecidas (`npm audit`) sempre que pacotes forem adicionados ou atualizados.

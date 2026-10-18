# Arquitetura — Forja

Estado: proposta v0.1 · Âmbito: alvo para as Fases 2–5, com pontos de extensão para 6–8.

## 1. Princípios

1. **Monólito modular primeiro.** Um único serviço de API com módulos de fronteira clara (conversas, ficheiros, modelos, ferramentas, contas). Separa-se um módulo em serviço apenas quando houver uma razão medida: escalonamento diferente (inferência em GPU), isolamento de segurança (execução de código) ou linguagem diferente (ML em Python).
2. **O frontend nunca vê segredos nem fala com fornecedores de modelos.** Todo o tráfego para modelos passa pela nossa API (padrão *backend-for-frontend*).
3. **Contratos antes de implementações.** O contrato de streaming e a interface `ModelProvider` já existem nesta entrega e são os mesmos que a produção usará.
4. **Menor privilégio por defeito** para ferramentas e agentes; ações destrutivas exigem confirmação explícita.
5. **Medir antes de otimizar**: tokens, latência e custo são registados por pedido desde a Fase 4.

## 2. Vista de componentes

```
┌──────────────────────────── Navegador ────────────────────────────┐
│  SPA React (apps/web)                                              │
│  UI ─ estado de conversa ─ cliente SSE ─ repositório de conversas │
└──────────────┬─────────────────────────────────────────────────────┘
               │ HTTPS: REST + POST /api/chat (resposta em SSE)
┌──────────────▼──────────────── API (TypeScript) ───────────────────┐
│ auth · rate limit · validação (zod) · auditoria                    │
│ ┌────────────┐ ┌───────────┐ ┌──────────────┐ ┌──────────────────┐ │
│ │ conversas  │ │ ficheiros │ │ orquestrador │ │ ferramentas      │ │
│ │ (Postgres) │ │ (S3)      │ │ contexto,    │ │ registo, perms,  │ │
│ │            │ │           │ │ ciclo tools  │ │ confirmações     │ │
│ └────────────┘ └───────────┘ └──────┬───────┘ └────────┬─────────┘ │
│                                     │ ModelProvider    │           │
└─────────────────────────────────────┼──────────────────┼───────────┘
          ┌───────────────────────────┼──────┐           │
          ▼                           ▼      ▼           ▼
   APIs comerciais           vLLM/SGLang  (Fase 8)   Sandbox microVM
   (Anthropic, OpenAI…)      auto-alojado            (E2B/Firecracker)
                                                     sem segredos, sem rede
   Fila de trabalhos (Postgres → Redis/NATS quando necessário)
   Worker Python (embeddings, avaliações, fine-tuning) — Fase 4+
```

## 3. Responsabilidades e fronteiras

| Camada | Responsável por | Não faz |
|---|---|---|
| **Frontend** | Apresentação, estado de UI, streaming, validação prévia de anexos (UX). | Guardar segredos, decidir permissões, confiar no seu próprio estado. |
| **API** | Autenticação, autorização por utilizador/projeto, validação definitiva, limites, persistência, auditoria. | Executar código de utilizadores. |
| **Orquestrador** | Montar contexto, chamar o modelo, conduzir o ciclo de ferramentas, contabilizar tokens. | Saber detalhes de um fornecedor específico. |
| **ModelProvider** | Traduzir o pedido normalizado para um fornecedor e normalizar os eventos de volta. | Lógica de produto. |
| **Ferramentas** | Operações declaradas com esquema, nível de risco e permissões. | Acções fora do escopo declarado. |
| **Sandbox** | Executar código/testes com limites de CPU, memória, tempo, sem credenciais e sem rede por defeito. | Ter acesso à base de dados ou a segredos. |

## 4. Contrato de streaming (implementado nesta entrega)

`POST /api/chat` com corpo JSON validado; resposta `text/event-stream`:

| Evento | Dados | Significado |
|---|---|---|
| `message.start` | `{ id, model }` | O servidor aceitou o pedido. |
| `delta` | `{ text }` | Fragmento de texto. |
| `message.end` | `{ finishReason, usage }` | Fim normal (`stop`, `length`, `cancelled`). |
| `error` | `{ code, message, retryable }` | Falha durante a geração. |

Escolha de **SSE sobre WebSockets**: o fluxo é unidirecional (servidor → cliente) por pedido; o cancelamento é feito fechando o pedido HTTP; SSE atravessa proxies e CDNs sem configuração especial e é o mesmo transporte dos fornecedores. WebSockets serão reconsiderados apenas para colaboração em tempo real.

`GET /api/models` devolve os modelos disponíveis com `status` (`available`, `simulated`, `requires-integration`) para que a UI nunca apresente um modelo inexistente como funcional.

## 5. Interface `ModelProvider`

```ts
interface ModelProvider {
  id: string;
  stream(request: ChatRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
}
```

Implementações previstas: `mock` (existe), `anthropic`, `openai`, `openai-compatible` (cobre vLLM, SGLang, llama.cpp `llama-server` e Ollama, que expõem APIs compatíveis). A última é a ponte para as Etapas B e D sem alterar o resto do sistema.

## 6. Decisões arquiteturais (ADR)

**ADR-0001 — Monólito modular em TypeScript.** Uma linguagem para frontend e API reduz o custo de equipa e partilha tipos de contrato. Python entra como *worker* quando houver trabalho de ML. *Alternativa rejeitada para já:* microserviços desde o início — custo operacional sem benefício mensurável. *Reavaliar:* quando um módulo precisar de escalar de forma independente.

**ADR-0002 — SPA React + API separada, em vez de Next.js full-stack.** A aplicação é autenticada e interativa; SSR traz pouco. Separar API e estáticos simplifica streaming de longa duração, timeouts e escalonamento. *Custo aceite:* duas unidades de deploy. *Nota:* o código de UI não depende de APIs de framework e é transplantável para Next.js se a decisão mudar. Nesta sessão a escolha foi também condicionada pela indisponibilidade do registo npm (ver `04-pendentes.md`): o build usa esbuild diretamente — o mesmo motor que o Vite usa em desenvolvimento.

**ADR-0003 — Camada própria `ModelProvider` em vez de dependência central de um gateway.** A interface é pequena; um gateway (LiteLLM ou outro) pode ser ligado por trás dela. Motivo adicional: o incidente de cadeia de fornecimento do LiteLLM em março de 2026 (`01-investigacao.md` §3.3).

**ADR-0004 — PostgreSQL + pgvector como única base de dados inicial.** Transações, permissões e vetores no mesmo sítio; menos sistemas para proteger. Redis só quando houver necessidade real (rate limiting distribuído, pub/sub entre instâncias).

**ADR-0005 — Markdown renderizado para elementos React, sem `innerHTML`.** O conteúdo do modelo é tratado como não confiável. HTML embutido é mostrado como texto, imagens externas não são carregadas automaticamente (privacidade), ligações só `http(s)`/`mailto` com `rel="noopener noreferrer"`. A única exceção é o HTML do realce de sintaxe, produzido pelo highlight.js a partir de texto escapado e sanitizado com DOMPurify para permitir apenas `<span class>`.

**ADR-0006 — Design system em CSS com tokens.** Os tokens (cor, tipo, espaço, raio, sombra, movimento) são propriedades CSS com temas claro/escuro. São portáveis para Tailwind v4 (`@theme`) sem alterar a marcação dos componentes.

**ADR-0007 — Execução de código só em microVMs.** Docker partilha o kernel do anfitrião e não é fronteira suficiente para código gerado por IA. Firecracker (via E2B auto-alojado ou serviço gerido) ou gVisor.

## 7. Segurança e governação (alvo)

- **Autenticação:** sessões em cookies `HttpOnly`, `Secure`, `SameSite=Lax`; OIDC para empresas; MFA. Avaliar Better Auth (TypeScript, auto-alojado) vs. fornecedor gerido.
- **Autorização:** todas as consultas filtradas por `tenant_id`/`user_id` na camada de dados (Row Level Security no Postgres como segunda barreira).
- **Prompt injection:** conteúdo de ficheiros, páginas e resultados de ferramentas entra no contexto marcado como dados; ferramentas sensíveis exigem confirmação; os agentes não recebem segredos.
- **Ficheiros:** validação de tipo por conteúdo (não só extensão), limites de tamanho, armazenamento fora da raiz web, URLs assinadas de curta duração.
- **Cabeçalhos:** CSP estrita sem `unsafe-inline` (já aplicada no servidor de desenvolvimento), `X-Content-Type-Options`, `Referrer-Policy`, `frame-ancestors 'none'`.
- **Auditoria:** registo imutável de ações de ferramentas, alterações de permissões e testes de segurança.
- **Laboratório de segurança (Fase 6):** testes ativos só após verificação de propriedade do alvo (registo DNS TXT ou ficheiro em `/.well-known/`), escopo explícito, limites de taxa, janela temporal e relatório com evidências. Sem funcionalidades de roubo de credenciais, persistência ou malware.

## 8. Ambientes

| Ambiente | Composição |
|---|---|
| Local | API + SPA + Postgres em Docker Compose; fornecedor `mock` ou Ollama/llama.cpp para testes manuais. |
| Testes/CI | Testes unitários, E2E com Playwright contra o fornecedor `mock`, auditoria de dependências, verificação de tipos. |
| Produção inicial | 2 instâncias da API atrás de um balanceador, Postgres gerido com backups e PITR, armazenamento S3, CDN para estáticos. Sem Kubernetes. |
| Crescimento | Separar o worker de jobs; Redis para rate limiting distribuído; réplicas de leitura. Kubernetes só quando houver cargas GPU próprias. |

## 9. Custos — variáveis, não números

Não apresentamos valores sem pressupostos. As variáveis que determinam o custo são:

- **Inferência via API:** utilizadores ativos × pedidos/dia × (tokens de entrada + saída) × preço por token do modelo escolhido. A cache de prefixos reduz o custo de entrada em conversas longas.
- **Inferência própria:** preço/hora da GPU × número de GPUs necessárias para o modelo (memória dos pesos + KV-cache para a concorrência alvo) ÷ utilização média. Só compensa acima de um limiar de utilização sustentada que tem de ser medido com o nosso tráfego.
- **Sandboxes:** segundos de execução × vCPU/memória por sessão.
- **Armazenamento:** volume de ficheiros e vetores por utilizador × retenção.

Primeiro cenário a calcular, quando houver dados: 1 000 utilizadores ativos/dia com o modelo da Fase 4.

## 10. Plano faseado (revisto após a investigação)

| Fase | Entrega | Critério de saída |
|---|---|---|
| 1 | Investigação e arquitetura | Este documento revisto pela equipa. |
| 2 | Frontend da conversação (**esta entrega**) | Fluxos críticos com testes E2E a passar. |
| 3 | API, autenticação, Postgres, histórico e ficheiros | Conversas persistidas por utilizador; testes de autorização. |
| 4 | Fornecedores reais, gestão de contexto, contabilização de tokens, avaliações | Conjunto de avaliação com ≥ 100 casos; custo por pedido visível. |
| 5 | Projetos, sandbox, ciclo de agente para programação | Agente cria uma alteração, corre testes na sandbox e prepara revisão humana. |
| 6 | Laboratório de segurança autorizado | Verificação de propriedade, escopo, auditoria. |
| 7 | Observabilidade, desempenho, custos | SLOs definidos e medidos. |
| 8 | Modelos de pesos abertos, LoRA, inferência própria | Comparação de qualidade/custo com avaliações da Fase 4. |

## 11. Decisões agora vs. mais tarde

**Agora:** TypeScript, React, contrato SSE, interface `ModelProvider`, PostgreSQL, design tokens, renderização segura de Markdown.

**Mais tarde (com dados):** fornecedor principal de modelos, framework de agentes (LangGraph vs. implementação direta), gateway de modelos, base vetorial dedicada, Redis, Kubernetes, modelo de pesos abertos, hardware GPU.

# Relatório de investigação técnica — Forja

Data: 18 de outubro de 2026 · Estado: v0.1 (primeira iteração)

> **Como ler este documento.** Cada afirmação está marcada com o seu grau de confiança:
> **[F]** facto documentado numa fonte oficial ou primária consultada nesta sessão;
> **[S]** fonte secundária consultada nesta sessão (jornalismo técnico, agregadores) — confirmar antes de decisões comerciais;
> **[C]** conhecimento prévio da equipa (até meados de 2026), não reverificado nesta sessão;
> **[H]** hipótese ou inferência.
>
> **Limitação desta sessão:** o GitHub, o registo npm e o PyPI estavam inacessíveis a partir do ambiente de execução. As licenças marcadas [C] devem ser confirmadas no ficheiro `LICENSE` de cada repositório antes de qualquer decisão vinculativa. A tarefa está registada em `docs/04-pendentes.md`.

---

## 1. Resumo executivo

1. **A plataforma e o modelo são produtos diferentes.** O que faz o Claude ou o ChatGPT “inteligentes” está nos pesos do modelo, que resultam de pré-treino em escala massiva e pós-treino (afinação por instruções, aprendizagem por reforço, alinhamento). Nenhum código de aplicação reproduz isso. O que podemos construir já — e controlar totalmente — é a camada de produto: interface, orquestração, ferramentas, memória, execução isolada, avaliação, segurança e faturação.
2. **Estratégia recomendada:** começar com uma aplicação independente do fornecedor (Etapa A) que consome modelos via API, medir qualidade e custo com avaliações próprias, e só depois introduzir modelos de pesos abertos auto-alojados (Etapas B–D) onde os números o justifiquem. Treinar um modelo fundacional (Etapa E) é uma decisão de outra ordem de grandeza e não deve ser planeada antes de existirem receitas, dados próprios e avaliações maduras.
3. **Stack recomendada:** monólito modular em TypeScript (React no frontend; API Node com fronteiras de módulo bem definidas), PostgreSQL + pgvector como única base de dados inicial, armazenamento de objetos compatível com S3, streaming por SSE, execução de código em microVMs (Firecracker, via E2B auto-alojado ou serviço gerido) e um serviço Python apenas quando houver trabalho de ML real (embeddings próprios, avaliação, fine-tuning).
4. **Primeira entrega:** frontend funcional da experiência de conversação, ligado a um servidor de desenvolvimento que implementa o contrato de streaming definitivo com um **fornecedor simulado**. Nada no produto se apresenta como IA real enquanto não existir um modelo ligado.

---

## 2. Como são construídos os assistentes modernos

### 2.1 O que é público sobre o Claude e o ChatGPT

| Tema | O que sabemos | Confiança |
|---|---|---|
| Arquitetura base | Modelos de linguagem baseados em Transformer, autoregressivos, treinados para prever o próximo token. | [C] |
| Pesos, dados de treino, tamanho exato, detalhes de infraestrutura | Não são públicos. Não fazemos afirmações sobre eles. | — |
| Utilização de ferramentas | O modelo não executa ferramentas. Devolve um pedido estruturado; a aplicação executa a ferramenta e devolve o resultado, num ciclo que termina quando o modelo produz a resposta final. A Anthropic distingue ferramentas executadas pelo cliente (`tool_use` → `tool_result`) de ferramentas executadas no servidor do fornecedor (pesquisa web, execução de código). O `stop_reason` indica se o ciclo continua (`tool_use`) ou terminou (`end_turn`, `max_tokens`, `refusal`, `pause_turn`). | [F] docs Anthropic |
| Streaming | A OpenAI transmite respostas por Server-Sent Events com eventos tipados (`response.created`, `response.output_text.delta`, `response.completed`, `error`). A Anthropic usa o mesmo transporte. | [F] docs OpenAI |
| Pós-treino e alinhamento | Ambas as empresas descrevem publicamente afinação supervisionada e aprendizagem por reforço com feedback humano/IA. Os procedimentos exatos não são públicos. | [C] |

**Conclusão de design [H]:** a parte que podemos replicar com rigor é o *harness* — o ciclo planear → chamar ferramenta → observar → verificar — e a qualidade do contexto que damos ao modelo. É aí que se ganha diferenciação sem possuir o modelo.

### 2.2 Blocos técnicos e onde entram no nosso produto

| Bloco | Papel | Quando entra |
|---|---|---|
| Tokenização, atenção, KV-cache | Internos ao modelo e ao motor de inferência. Relevantes para custo e latência quando auto-alojarmos. | Fase 8 |
| Gestão de contexto | Seleção do histórico, resumos, limite de tokens por modelo, cache de prefixo. | Fase 4 |
| RAG (embeddings + pesquisa vetorial) | Ficheiros do utilizador, documentação de projetos, memória. pgvector evita uma segunda base de dados. | Fase 4–5 |
| Agentes (planear/executar/verificar) | Ciclo com estado durável, interrupções para aprovação humana, retomas. | Fase 5 |
| Execução isolada | Correr código e testes gerados pelo modelo sem tocar no anfitrião. | Fase 5 |
| Avaliação | Conjuntos de teste próprios por tarefa (programação, revisão, segurança), medindo qualidade, latência e custo por pedido. | A partir da Fase 4 — pré-requisito para trocar de modelo |
| Inferência própria | GPUs, motor de servir (vLLM/SGLang), quantização, batching contínuo. | Fase 8 |

---

## 3. Tecnologias open source candidatas

### 3.1 Modelos de pesos abertos

| Modelo | Licença | Notas relevantes | Confiança |
|---|---|---|---|
| **Qwen3-Coder-Next** | Apache 2.0 | MoE com ~80B parâmetros totais e ~3B ativos por token; contexto nativo de 256k. Em bf16 os pesos ocupam ~160 GB de VRAM, portanto exige várias GPUs ou quantização agressiva. | [S] |
| **Qwen3.8-27B** | Apache 2.0 | Lançado em agosto de 2026. | [S] |
| **Qwen3.8-Max (2,4T/95B ativos)** | Licença própria | Exige licença separada para serviços de “modelo como serviço” ou “assistente de trabalho” com receitas acima de 50 M USD em 12 meses. **Relevante para nós**: o nosso produto é exatamente esse tipo de serviço. | [S] |
| **Llama 4 (Scout/Maverick)** | Llama 4 Community License | Gratuita abaixo de 700 M de utilizadores ativos mensais; exige “Built with Llama” e cumprimento da política de utilização aceitável; não concede direitos de marca. Não é uma licença open source no sentido OSI. | [S] |
| **DeepSeek-V3 (0324)** | MIT | A versão de março de 2025 passou de licença própria para MIT. Versões posteriores (V3.2, V4) devem ser verificadas individualmente. | [S] |

**Lição [H]:** dentro da mesma família, as licenças variam por tamanho de modelo. A decisão de licença tem de ser feita **por checkpoint**, não por família, e registada.

### 3.2 Inferência e servir modelos

| Projeto | Finalidade | Licença | Avaliação |
|---|---|---|---|
| **vLLM** | Motor de inferência de alto débito (PagedAttention, batching contínuo, API compatível com OpenAI). Ritmo de lançamentos muito elevado: v0.28 com atenção esparsa e descodificação especulativa mais rápida noticiada em agosto de 2026 [S]. | Apache 2.0 [C] | Escolha por defeito para servir em GPUs NVIDIA na Fase 8. |
| **SGLang** | Alternativa ao vLLM com foco em reutilização de prefixo (RadixAttention). | Apache 2.0 [C] | Avaliar lado a lado com vLLM com a nossa carga real. |
| **llama.cpp** | Inferência em C/C++ com GGUF e quantização; corre em CPU, Apple Silicon e GPUs de consumo; `llama-server` com API compatível com OpenAI. | MIT [C] | Ideal para desenvolvimento local e modelos pequenos. Não é o motor de produção multiutilizador. |
| **Ollama** | Empacotamento amigável sobre llama.cpp para uso local. | MIT [C] | Excelente para desenvolvimento local; não recomendado para produção multi-inquilino. |
| **Hugging Face Transformers / PyTorch** | Base para fine-tuning, investigação e avaliação. | Apache 2.0 / BSD-3 [C] | Entram na Fase 8 (LoRA/QLoRA, avaliação offline). |

### 3.3 Orquestração e gateway de modelos

| Projeto | Avaliação |
|---|---|
| **LiteLLM** | Interface unificada para >100 fornecedores. SDK MIT; a edição comunitária do proxy não inclui SSO, RBAC granular nem orçamentos por equipa, que são pagos [S]. **Incidente de cadeia de fornecimento a 24 de março de 2026:** as versões 1.82.7 e 1.82.8 publicadas no PyPI continham código que roubava credenciais (variáveis de ambiente, chaves cloud, SSH, Kubernetes) [S]. Decisão: **não adotar como dependência central agora**. A nossa camada de abstração é pequena (interface `ModelProvider`, ver ADR-0003) e podemos ligar um gateway mais tarde por trás dessa interface, com versões fixadas e verificação de integridade. |
| **LangGraph** | Grafos de agentes com estado persistente, interrupções para aprovação humana e retoma. Existe em Python e TypeScript. Licença MIT [C]. Candidato forte para a Fase 5; adiar a adoção até termos o primeiro ciclo de agente concreto para comparar com uma implementação direta. |

### 3.4 Dados, execução e observabilidade

| Projeto | Avaliação |
|---|---|
| **PostgreSQL + pgvector** | Uma só base de dados para dados relacionais e vetores (índices HNSW e IVFFlat). Licença PostgreSQL [C]. Adiar uma base vetorial dedicada até existirem dezenas de milhões de vetores ou requisitos de latência que o pgvector não cumpra. |
| **E2B** | Sandboxes em microVMs Firecracker. O núcleo (SDKs, CLI, runtime, control plane, camada Firecracker) é Apache 2.0 e pode ser auto-alojado numa máquina com KVM via Docker Compose, Terraform ou um nó Kubernetes; o modo auto-alojado é de nó único, sendo o multi-nó feito por BYOC ou pela cloud da E2B [F] página open source da E2B. |
| **gVisor / Firecracker** | Alternativas de mais baixo nível para isolamento (kernel em espaço de utilizador vs. microVM). Apache 2.0 [C]. Docker sozinho **não** é fronteira de segurança suficiente para código gerado por IA. |
| **Playwright** | Testes E2E do nosso frontend e, futuramente, ferramenta de navegação para agentes (sempre dentro da sandbox). Apache 2.0. Usado nesta entrega (v1.56). |
| **OpenTelemetry** | Padrão para traces/métricas/logs. Instrumentar desde o início. |
| **Langfuse** | Observabilidade específica de LLM (traces de prompts, custos, avaliações). Núcleo MIT, auto-alojável; funcionalidades empresariais separadas [C]. Candidato para a Fase 4. |

### 3.5 Frontend

| Opção | Avaliação |
|---|---|
| **React 19** | Ecossistema mais rico para interfaces de chat; usado nesta entrega (19.2.8, MIT). |
| **Next.js vs. SPA (Vite)** | A aplicação vive atrás de autenticação, é muito interativa e o SEO só importa na página de marketing. O SSR traz pouco benefício e acopla o streaming ao runtime do framework. **Recomendação:** SPA React servida como estáticos + API separada; a página de marketing pode ser Next.js ou estática mais tarde. Ver ADR-0002. |
| **Tailwind CSS** | Produtivo, mas o valor visual vem dos tokens, não da biblioteca. Nesta entrega o design system é CSS com propriedades personalizadas (tokens), portável para Tailwind v4 (`@theme`) sem reescrever componentes. |
| **Componentes acessíveis** | React Aria (Apache 2.0, Adobe) ou Radix. Para esta entrega, os componentes são próprios e simples (botões, menus, gaveta); adotar React Aria quando surgirem componentes complexos (combobox, menus aninhados, diálogos modais). |
| **Markdown** | `marked` (MIT) apenas como *lexer*; a renderização é feita para elementos React, sem `innerHTML`, eliminando uma classe inteira de XSS. HTML embutido nas respostas é mostrado como texto. |
| **Realce de sintaxe** | highlight.js (BSD-3) com linguagens registadas seletivamente. Avaliar Shiki (gramáticas TextMate, maior fidelidade, maior custo) quando o editor de código entrar. |

---

## 4. Padrões de experiência observados no mercado

Padrões transversais nas interfaces de assistentes de IA, a reutilizar como **padrões**, não como aparência [C]:

- Barra lateral com “Nova conversa” no topo, histórico agrupado por data, pesquisa e acesso a projetos; recolhe em desktop e passa a gaveta em telemóvel.
- Coluna de leitura central estreita (≈ 680–760 px) para texto longo; blocos de código podem ser mais largos.
- Mensagens do utilizador em bolha discreta; respostas do assistente sem bolha, como documento.
- Composer fixo em baixo: área de texto que cresce, Enter envia, Shift+Enter quebra linha, botão que alterna entre “Enviar” e “Parar”.
- Indicador antes do primeiro token; cursor durante o streaming; scroll que acompanha o fim **apenas** se o utilizador não tiver subido.
- Blocos de código com etiqueta de linguagem e botão de copiar; ações por mensagem (copiar, regenerar).
- Erros na própria conversa, com botão de repetir, sem perder o texto do utilizador.

**Identidade própria:** nome *Forja*, símbolo geométrico original, paleta grafite com acento verdete (cobre oxidado) e âmbar para estados de atenção. Nenhum ativo, cor de marca ou ícone de terceiros é reproduzido.

---

## 5. Estratégia de independência tecnológica

| Etapa | O que controlamos | O que continua alheio |
|---|---|---|
| **A — Plataforma independente** | Interface, dados, histórico, ferramentas, avaliações, faturação, contrato interno `ModelProvider`. | O modelo e o seu comportamento; preços e termos do fornecedor. |
| **B — Pesos abertos** | Escolha do checkpoint, versão fixa, dados nunca saem da nossa infraestrutura. | Treino original; licença do autor dos pesos. |
| **C — Especialização (LoRA/fine-tuning)** | Adaptadores próprios, dados de treino próprios, avaliações. | Base pré-treinada. |
| **D — Inferência própria** | Latência, custo marginal, disponibilidade, privacidade. | Hardware (fornecedores de GPU). |
| **E — Modelo fundacional próprio** | Tudo, incluindo os pesos. | — mas exige corpus licenciado em escala, clusters de GPUs, equipa de investigação dedicada e meses de computação. Só faz sentido com receitas e dados próprios significativos. |

Não há números de custo nesta tabela de propósito: ver `docs/02-arquitetura.md` §9 para as variáveis que determinam cada custo.

---

## 6. Riscos

| Risco | Tipo | Mitigação |
|---|---|---|
| Licenças de modelos variam por checkpoint e mudam entre versões | Legal | Registo de licenças por checkpoint; revisão jurídica antes da Etapa B. |
| Ataques à cadeia de fornecimento (ex.: LiteLLM, março 2026) | Segurança | Lockfiles, versões exatas, `npm audit`/`pip-audit` em CI, ações de CI fixadas por SHA, segredos com âmbito mínimo. |
| Prompt injection via ficheiros, páginas web e resultados de ferramentas | Segurança | Conteúdo externo tratado como dados; ferramentas com menor privilégio; confirmações humanas para ações destrutivas. |
| Execução de código gerado | Segurança | MicroVMs sem credenciais, sem rede por defeito, limites de CPU/memória/tempo. |
| Dependência de um único fornecedor de modelos | Negócio | Interface `ModelProvider` + avaliações próprias antes de qualquer troca. |
| Custo de inferência por utilizador acima da receita | Económico | Limites por plano, contabilização de tokens por pedido desde o primeiro dia, cache de prefixos. |
| Funcionalidade ofensiva de segurança usada contra terceiros | Legal/ético | Verificação de propriedade do alvo (DNS/ficheiro), escopo, limites de intensidade e auditoria — requisito antes de qualquer teste ativo. |

---

## 7. Fontes consultadas nesta sessão

Oficiais:
- Anthropic — [How tool use works](https://platform.claude.com/docs/en/agents-and-tools/tool-use/how-tool-use-works)
- Anthropic — [Tool use overview](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview)
- Anthropic — [Advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)
- OpenAI — [Streaming API responses](https://developers.openai.com/api/docs/guides/streaming-responses)
- OpenAI — [Function calling](https://developers.openai.com/api/docs/guides/function-calling)
- E2B — [Open source](https://e2b.dev/open-source.md)
- Meta — [Llama 4 Maverick (Hugging Face)](https://huggingface.co/meta-llama/Llama-4-Maverick-17B-128E-Original)

Secundárias (confirmar antes de decisões vinculativas):
- eWeek — [Qwen3.8-27B sob Apache 2.0; limites de licença no Max](https://www.eweek.com/news/alibaba-qwen3-8-27b-license-apac-china/)
- dev.co — [Qwen3-Coder-Next](https://dev.co/ai/llms/qwen3-coder-next)
- canirun.ai — [Resumo da Llama 4 Community License](https://canirun.ai/license/llama-4-community/)
- SiliconANGLE — [DeepSeek-V3 sob licença MIT](https://siliconangle.com/2025/03/24/deepseek-releases-improved-deepseek-v3-model-mit-license/)
- Comet — [Ataque à cadeia de fornecimento do LiteLLM](https://www.comet.com/site/blog/litellm-supply-chain-attack/)
- TrueFoundry — [Análise do LiteLLM](https://www.truefoundry.com/blog/a-detailed-litellm-review-features-pricing-pros-and-cons-2026) (concorrente do LiteLLM; possível enviesamento)
- Hermes AI — [vLLM v0.28](https://hermes-ai.net/news/vllm-v0-28-0-ships-sparse-attention-and-60-faster-speculative-decoding/)

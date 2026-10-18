# Modelos: execução própria e independência de fornecedores (Fase 4)

Estado: implementado · 18 de outubro de 2026

## 1. O que é nosso e o que é de terceiros

| Componente | Origem |
|---|---|
| Plataforma (interface, API, contas, histórico, ficheiros) | **Nossa** |
| Orquestração: registo de modelos, adaptadores, gestão de contexto, prompt de sistema, filtragem de raciocínio, verificação de saúde | **Nossa** |
| Avaliação de modelos (`scripts/eval.ts`, `evals/`) | **Nossa** |
| Servidor de inferência (Ollama, vLLM) | Terceiros, open source, a correr na **nossa** infraestrutura |
| Pesos dos modelos (ex.: Qwen3, da Alibaba, Apache 2.0) | **Terceiros**. Não foram adaptados nem treinados por nós |

**Não temos ainda uma IA própria.** Temos uma plataforma própria que executa, sob nosso controlo, modelos de pesos abertos criados por terceiros. O passo seguinte para um modelo com capacidades nossas é a especialização: dados próprios, LoRA e avaliação, conforme a Etapa C de `01-investigacao.md`.

## 2. Arquitetura

```
chat.ts ──► ModelProvider (interface única)
              │
              └─ ModelRegistry (registry.ts) ── catálogo validado (MODELS_CONFIG)
                    ├─ simulador (desenvolvimento/testes; desligado em produção)
                    ├─ backend "ollama"            → API nativa /api/chat (NDJSON)
                    └─ backend "openai-compatible" → /v1/chat/completions (SSE)
                                                     vLLM · llama.cpp · SGLang · APIs comerciais (opcionais)
```

- **Trocar de modelo, ou de servidor, é uma alteração de configuração**, sem tocar no código.
- O registo verifica cada servidor a cada 30 s (`MODEL_HEALTH_INTERVAL_MS`). Um modelo com o servidor desligado, ou sem os pesos descarregados, aparece como **Indisponível**, com a razão.
- O orçamento de contexto depende de cada modelo: janela do modelo, menos a resposta máxima, menos o prompt de sistema, com 10 % de margem.

**ADR-0012 — Registo de modelos por configuração.** O `ModelProvider` mantém-se como fronteira. O registo agrega vários backends e expõe a mesma interface, por isso `chat.ts`, `conversations.ts` e `app.ts` não precisaram de ser reescritos. Alternativa rejeitada: um gateway externo como dependência central (ver ADR-0003).

**ADR-0013 — API nativa do Ollama em vez de `/v1`.** A API compatível com OpenAI do Ollama não permite fixar a janela de contexto por pedido. Sem isso, o Ollama usa um valor por omissão pequeno e corta o início da conversa, incluindo o prompt de sistema, sem avisar. A API nativa permite também desligar o raciocínio (`think: false`) e devolve a contagem real de tokens. O vLLM e os outros servidores usam o adaptador compatível com OpenAI.

## 3. Segredos

- O catálogo guarda apenas o **nome** da variável de ambiente (`apiKeyEnv`). O valor fica no ambiente do servidor.
- **Sem a variável definida, a integração não é registada**, porque é opcional. A aplicação funciona sem ela.
- O frontend recebe só: id, nome, descrição, estado, alojamento, autor e licença. URLs, nomes internos de modelos e chaves nunca saem do servidor; isto está verificado por testes.
- O catálogo é validado no arranque:
  - HTTP sem TLS só é aceite para endereços locais ou privados;
  - integrações externas exigem HTTPS;
  - credenciais escritas no URL são recusadas.
- Erros do servidor de modelos chegam ao utilizador como mensagens genéricas. O detalhe fica no log do servidor.

## 4. Executar um modelo local

```bash
# 1. Instalar o Ollama (https://ollama.com) e descarregar um modelo
ollama pull qwen3:4b

# 2. Catálogo
cp config/models.example.json config/models.json   # ajustar à vontade
echo "MODELS_CONFIG=config/models.json" >> .env

# 3. Arrancar a Forja
npm run build && npm start
```

O arranque regista o estado de cada modelo. Os modelos do exemplo que não estejam instalados (o 27B, o vLLM, o externo sem chave) aparecem como indisponíveis, ou nem são registados, sem impedir os restantes de funcionar.

**vLLM (GPU, vários utilizadores):** `vllm serve Qwen/Qwen3.8-27B --api-key "$VLLM_API_KEY"`, e o backend `vllm-gpu` do exemplo. A documentação do vLLM avisa que `--api-key` só protege `/v1`. Em produção, o vLLM deve ficar numa rede privada, atrás de um proxy.

## 5. Hardware e modelos recomendados

| Uso | Modelo | Licença | Tamanho (Q4) | Hardware | Limitações |
|---|---|---|---|---|---|
| CI | `qwen3:0.6b` | Apache 2.0 | ~0,5 GB | CPU | Só valida a integração |
| Desenvolvimento | `qwen3:4b` | Apache 2.0 | 2,5 GB | CPU com 8 GB de RAM (lento); GPU com 6 GB | Erra com frequência; respostas lentas em CPU |
| Desenvolvimento com imagens | `qwen3.5:4b` | Apache 2.0 | ~3,4 GB | idem | Taxa de alucinação medida de ~80 % (AA-Omniscience) |
| Qualidade | `qwen3.8:27b` | Apache 2.0 | ~18 GB | GPU de 24 GB (16 GB com parte em CPU) | Contexto prático de 16–64k em hardware de consumo |
| Escala | Qwen3.8 27B em vLLM | Apache 2.0 | 56 GB em BF16 | GPU de classe H100 | Custo de GPU dedicada |

As licenças devem ser confirmadas **por versão concreta do modelo**: dentro da mesma família há modelos com licenças diferentes (ver `01-investigacao.md`).

## 6. Avaliação

`scripts/eval.ts` corre um conjunto de casos (`evals/basico.json`) contra qualquer modelo do catálogo, pelo mesmo caminho da aplicação. Mede:

- os critérios definidos em cada caso;
- o tempo até ao primeiro token e o tempo total;
- os tokens usados.

```bash
npm run eval -- --config config/models.json --model qwen3-4b-local --out relatorio.json
```

O conjunto inicial cobre factos simples, formato JSON, código, honestidade sobre a origem do modelo e resistência a instruções escondidas em anexos. **É pequeno de propósito:** serve de base para crescer com casos reais do produto, antes de decidir trocas de modelo.

O simulador falha todos os casos de qualidade, como esperado, porque não é um modelo.

## 7. Validação

| Nível | O que valida | Onde |
|---|---|---|
| Unitários | Filtro de raciocínio, catálogo (regras de segurança), formato das mensagens, prompt de sistema, critérios da avaliação | Local e CI |
| Integração (servidor falso) | Os dois adaptadores: streaming, tokens, cancelamento propagado, erros, tempo limite, chave só quando configurada; registo e estados; conversa pela API sem expor segredos; janela de contexto respeitada | Local e CI |
| E2E (servidor falso) | Seletor com modelo local por defeito, modelo indisponível assinalado, conversa completa | Local e CI |
| Modelo real | Ollama + `qwen3:0.6b` num runner sem GPU: conversa pela API, cancelamento, avaliação | CI (workflow "Modelo local") |

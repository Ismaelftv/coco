# Ferramentas e agentes de programação (Fase 5)

Esta fase acrescenta à Forja a base para agentes que desenvolvem e validam software: um sistema de ferramentas independente do modelo, um ciclo de execução controlado, execução isolada de comandos e uma avaliação própria. **Não há modelo treinado por nós**: os agentes usam o `ModelProvider` existente (modelos de pesos abertos de terceiros, p. ex. Qwen, servidos por Ollama/vLLM). O que é nosso é a plataforma à volta do modelo. Nenhuma API comercial é necessária.

## 1. Arquitetura

```
objetivo ─► contexto automático (project_info + list_files)
        ─► plano (resposta sem ferramentas)
        ─► ciclo: modelo escolhe UMA ferramenta
                  ─► validação zod dos argumentos
                  ─► permissões / confirmação explícita
                  ─► execução (Workspace + Sandbox)
                  ─► observação embrulhada como DADOS não confiáveis
        ─► finish ─► verificação independente dos critérios de sucesso
        ─► relatório (diff, comandos, códigos de saída, critérios, métricas, isolamento, modelo)
```

| Ficheiro | Responsabilidade |
|---|---|
| `server/agent/workspace.ts` | Cópia do projeto + repositório git de base (fora da árvore de trabalho); resolução de caminhos com `realpath`; políticas de leitura/escrita/sensíveis; diff e ficheiros alterados. |
| `server/agent/sandbox.ts` | `ProcessSandbox`: execução isolada de comandos (ver §3). Interface `Sandbox` substituível. |
| `server/agent/tools.ts` | Definições das ferramentas (zod + risco), `ToolRegistry` (valida e executa, nunca lança), comandos permitidos. |
| `server/agent/json-schema.ts` | zod → JSON Schema para os modelos. |
| `server/agent/protocol.ts` | Adaptadores `native` e `prompted`. |
| `server/agent/loop.ts` | Ciclo, limites, critérios de sucesso, relatório. |
| `server/agent/prompt.ts` | Prompt de sistema dos agentes. |
| `scripts/agent.ts` / `scripts/agent-eval.ts` | CLI e avaliação. |

### Ferramentas

`project_info`, `list_files`, `read_file` (≤ 256 KB; 400 linhas por chamada, paginado), `search_code` (`git grep`, sem backtracking), `edit_file` (substituição exata; **ocorrências ambíguas são recusadas** com lista de linhas e contexto — o agente desambigua com `line` ou `occurrence`+`expectedMatches`, e `version` detecta ficheiros alterados; escrita atómica, releitura e verificação, reposição se falhar; `TOOLS_VERSION` 3: a recusa por `expectedMatches` incorreto lista as linhas e diz que, com `line`, o `expectedMatches` pode ser omitido), `write_file`, `delete_file` (destrutiva), `run_command` (só nomes permitidos, sem shell) e `finish`. Cada tarefa pode restringir o conjunto (`allowedTools`).

### Independência do modelo (ADR-0014)

Nem todos os modelos suportam chamadas nativas, por isso há dois adaptadores, escolhidos por modelo no catálogo (`"toolCalling": "native" | "prompted"`, por omissão `prompted`):

- **native**: as ferramentas vão em `tools` (Ollama `/api/chat`; OpenAI-compatível — no vLLM requer `--enable-auto-tool-choice --tool-call-parser …`). Os resultados voltam como mensagens `tool`. Se o servidor não analisar a chamada e o modelo a escrever em texto, o texto também é analisado.
- **prompted**: as ferramentas são descritas no prompt e o modelo responde com um bloco JSON. O parser aceita ```` ```json ````, `<tool_call>`, `name`/`tool`/`ferramenta` e `arguments`/`args`/`argumentos`. JSON partido gera uma mensagem de correção ao modelo.

O resto do ciclo é idêntico nos dois modos.

## 2. Ciclo e limites

Uma ação por iteração. Limites (por omissão): 30 iterações, 15 min, 400 000 tokens, 3 tentativas de `finish`, 5 erros seguidos, 3 repetições sem alterações, 3 respostas seguidas sem ação, observações ≤ 12 000 caracteres, comandos ≤ 120 s e 16 KB de saída. O histórico é compactado (resultados antigos substituídos por um marcador) quando excede a janela de contexto. Uma ação repetida sem que nada tenha mudado não é reexecutada.

**Conclusão**: `finish` não encerra a tarefa. O sistema avalia os critérios (`command` com código de saída, `file-contains`, `unchanged`, `changed`, `never-exposed`, `summary-matches`) executando os comandos ele próprio. Se falharem, o modelo recebe a lista do que falta. Sem critérios, o relatório indica `verified: false`: o "sucesso" seria só a palavra do modelo.

## 3. Segurança

- **Menor privilégio**: o agente trabalha numa *cópia*; o projeto original nunca é alterado (o resultado é um patch). Ficheiros sensíveis (`.env`, chaves, `.git`, credenciais) **não são copiados** e são recusados mesmo que apareçam. Links simbólicos não são seguidos nem escritos; `..` e caminhos absolutos são recusados.
- **Confirmação explícita** (`confirm`): apagar ficheiros, alterar `package.json`/lockfiles/CI/Dockerfile e caminhos protegidos da tarefa. Sem função de confirmação, tudo isto é **recusado**. A avaliação recusa sempre.
- **Comandos**: apenas nomes de uma lista (`test` deduzido do `package.json`), `argv` sem shell, argumentos extra validados (sem opções, `..` nem metacaracteres).
- **Instruções maliciosas**: observações vêm embrulhadas em `<resultado_ferramenta>` (a etiqueta não pode ser fechada por dentro), com aviso do sistema quando o texto parece dar ordens; o prompt declara-as dados. Isto reduz o risco, **não o elimina**: um modelo pode ser enganado. Por isso as defesas que não dependem do modelo (segredos não copiados, confirmação, critério `unchanged`/`never-exposed`) é que contam.
- **Sandboxes** (ver [`08-isolamento.md`](08-isolamento.md)): `ProcessSandbox` (dev-grade: rede e PIDs em namespaces, `nobody`, `prlimit`, ambiente limpo, timeout ao grupo de processos, saída limitada) e `ContainerSandbox` (Docker/Podman: sem rede, raiz só de leitura, sem capacidades, limites). O nível de isolamento é **verificado por comportamento** (`probeSandbox`: `none` / `process` / `strong`), não deduzido dos binários presentes.
- **Porta de confiança**: um projeto `untrusted` (por omissão) só corre com isolamento verificado `strong`; senão o agente recusa-se a arrancar, sem chamar o modelo nem executar comandos. `trusted` (`--trust-project`) aceita o risco ao nível verificado, e o relatório regista-o.

### Limitações de segurança (importante)

- O isolamento de processo **não** protege o sistema de ficheiros do servidor, e no runner do GitHub nem sequer isola a rede ou o utilizador (medido; ver `08-isolamento.md`). Só o contentor chegou a `strong`, e mesmo esse partilha o kernel: para código de terceiros multiutilizador em produção é necessária uma microVM/gVisor por trás da interface `Sandbox`.
- Ter o servidor com acesso ao daemon do Docker equivale a dar-lhe root: em produção a execução deve ser um serviço separado.
- Resistir a uma instrução maliciosa em poucas execuções **não** demonstra segurança; a proteção vem das barreiras estruturais e da sandbox, e é medida à parte (§4).
- Ainda não há ações externas (web, rede, `git push`): quando existirem, exigirão confirmação e lista de destinos.

## 4. Avaliação (suite v2): categorias separadas

`evals/agent/tarefas.json` (6 tarefas) + projetos em `evals/agent/projetos/` + testes escondidos em `evals/agent/holdout/` (o agente nunca os vê: são copiados no fim). Os resultados **não são misturados**, porque medem coisas diferentes e nenhuma implica outra:

| Categoria | O que mede | Como |
|---|---|---|
| **Execução técnica** | A tarefa foi concluída com os critérios visíveis? | testes do projeto a passar, ficheiros de teste intactos, resumo; verificados pelo sistema, não pelo modelo |
| **Qualidade do código** | A solução é boa para além dos testes visíveis? | testes escondidos (apanha "overfitting"), tamanho do diff, âmbito das alterações, sintaxe; avaliados depois, sem o modelo ver |
| **Resistência a injeção** | O modelo obedeceu? As barreiras aguentaram? | 3 cenários (README, saída dos testes, comentário no código): **tentativas** de ações proibidas (contadas à parte) vs. **resultado** (ficheiros protegidos intactos, segredo nunca exposto) |
| **Segurança da sandbox** | O isolamento é real? | `probeSandbox`, independente do modelo; ver `08-isolamento.md` |
| **Custo** | Tempo, tokens, hardware | tempo por execução, tokens/s, CPU/RAM; `ollama ps` e tamanho do modelo |

```bash
npm run agent-eval -- --config config/models.json --model qwen3-4b-local --mode native --sandbox container --repeat 3 --out relatorio.json
```

Ressalvas na leitura: (1) numa execução em que o modelo não fez nada, as barreiras "aguentam" trivialmente — conta o número de **tentativas**; (2) a qualidade de uma execução sem alterações falha trivialmente — vê-se `amongExecutionPassed`; (3) 6 tarefas pequenas em JavaScript não representam projetos reais; (4) poucas repetições dão variância alta.

Os comportamentos do *sistema* (seleção e validação de ferramentas, ficheiros não autorizados, erros, alterações aplicadas, testes executados e interpretados, recuperação, conclusão só com critérios cumpridos, limites, confirmação, injeção, qualidade vs. execução, sandbox) são testados de forma determinística com um modelo roteirizado em `tests/integration/agent.test.ts`, `tests/unit/agent.test.ts` e `tests/integration/sandbox-boundaries.test.ts`; a ligação aos servidores (Ollama/OpenAI-compatível) com o servidor falso. Estes testes provam que o sistema reage corretamente a um modelo que acerta *ou erra* — não que um modelo real o faça.

Resultados guardados: [`resultados/`](resultados/). Os relatórios completos da CI são publicados como anotações (`scripts/ci-annotate.py`) e recolhidos com `python3 scripts/ci-results.py <run_id>`, porque os artefactos da CI não são acessíveis a partir do ambiente de desenvolvimento.

## 5. Experimentar

```bash
# agente sobre uma cópia de um projeto teu (o original não é alterado)
npm run agent -- --config config/models.json --model qwen3-4b-local \
  --project ./o-meu-projeto --goal "Corrige o teste que falha" --test-cmd "npm test" --patch alteracoes.patch
# por omissão o projeto é "não confiável": exige contentor (Docker/Podman). Se for teu e aceitares o risco
# ao nível de isolamento mostrado no arranque, acrescenta --trust-project
```

Para o catálogo: acrescentar `"toolCalling": "native"` aos modelos cujo servidor suporta chamadas nativas (Qwen3 no Ollama; vLLM com o parser adequado). Na dúvida, deixar `prompted`.

## 6. Por fazer

Ver `docs/04-pendentes.md` (Fase 5): integração do agente na interface web, sandbox por microVM, ferramentas de web com lista de destinos, mais tarefas e linguagens na avaliação, suporte a vários comandos configuráveis por projeto, edição multi-ficheiro atómica, índice semântico do código.


## Versões das ferramentas e da suite (resultados que não se misturam)

- `TOOLS_VERSION` (em `server/agent/tools.ts`) e `suiteVersion` (`evals/agent/tarefas.json`) ficam em cada relatório (`config.toolsVersion`, `config.suiteSha256`, `config.commit`). Resultados com versões diferentes são publicados em pastas separadas e **nunca** agregados.
- `toolsVersion 1` (até ao commit `5651dc2`): `edit_file` recusava ambiguidades sem dizer onde estavam. `toolsVersion 2`: ver acima.
- Suite v2 → v3: `corrigir-bug` perdeu o critério `file-contains` (dependia do texto exato da solução e aparecia ao modelo nas recusas). A v2 está em `evals/agent/historico/`.
- As soluções de referência (`evals/agent/referencia/solucoes.json`) validam o instrumento (`npm run agent-reference`, `tests/integration/eval-controls.test.ts`) e nunca são dadas aos modelos.
- Causas das falhas (`server/agent/classify.ts`): `success`, `timeout`, `edit_refused` (a ferramenta recusou corretamente e o modelo não resolveu), `tool_failure` (a ferramenta falhou de facto), `model_no_action`, `tests_failed`, `integrity_violation`, `model_error`, `infrastructure`.

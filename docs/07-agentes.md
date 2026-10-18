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

`project_info`, `list_files`, `read_file` (≤ 256 KB; 400 linhas por chamada, paginado), `search_code` (`git grep`, sem backtracking), `edit_file` (substituição exata e única), `write_file`, `delete_file` (destrutiva), `run_command` (só nomes permitidos, sem shell) e `finish`. Cada tarefa pode restringir o conjunto (`allowedTools`).

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
- **Sandbox de processo** (`ProcessSandbox`): rede desligada (`unshare -n`), utilizador `nobody` (`setpriv`, quando o servidor corre como root), `prlimit` (CPU, tamanho de ficheiros, descritores, processos, core), ambiente limpo (só `PATH`, `HOME`/`TMPDIR` temporários; nenhuma variável do servidor), heap do Node limitado, timeout com `SIGKILL` ao grupo de processos, saída limitada (início + fim). O relatório inclui o isolamento **efetivamente aplicado**.

### Limitações de segurança (importante)

- É isolamento de **processo**, não de máquina: não limita memória de forma fiável, não isola o sistema de ficheiros (um comando pode ler o que o utilizador `nobody` puder ler no servidor) e partilha o kernel. Adequado a desenvolvimento e avaliação com código do próprio utilizador. **Para executar código de terceiros ou multiutilizador em produção é necessária uma microVM/contentor dedicado** (Firecracker/gVisor — a avaliar na Fase 8) por trás da interface `Sandbox`.
- Se o sistema não permitir namespaces de rede (p. ex. alguns runners sem `unshare`), os comandos têm rede; o relatório e `project_info` dizem-no.
- Testes de um projeto malicioso correm código arbitrário dentro dessa sandbox. Não é seguro apontar o agente a projetos não confiáveis fora de um ambiente descartável.
- Ainda não há ações externas (web, rede, `git push`): quando existirem, exigirão confirmação e lista de destinos.

## 4. Avaliação

`evals/agent/tarefas.json` + projetos em `evals/agent/projetos/`: corrigir um bug (`calculadora`), implementar uma função guiada por testes (`slugify`), tarefa só de leitura com ferramentas restritas, e resistência a injeção (README e código com instruções maliciosas, `.env` com segredo falso).

```bash
npm run agent-eval -- --config config/models.json --model qwen3-4b-local --mode native --repeat 3 --out relatorio.json
```

Métricas: sucesso (critérios verificados), motivo de paragem, iterações, chamadas, erros, argumentos inválidos, JSON partido, respostas sem ação, operações recusadas, avisos de injeção, tokens e tempo. **Mede execução técnica em 4 tarefas pequenas — não a qualidade geral do modelo nem de agentes em projetos reais.**

Os comportamentos do *sistema* (seleção e validação de ferramentas, ficheiros não autorizados, erros, alterações realmente aplicadas, testes executados e interpretados, recuperação de falhas, conclusão só com critérios cumpridos, limites, confirmação, injeção, sandbox) são testados de forma determinística com um modelo roteirizado em `tests/integration/agent.test.ts` e `tests/unit/agent.test.ts`; a ligação aos servidores (Ollama/OpenAI-compatível) com o servidor falso. Estes testes provam que o sistema reage corretamente a um modelo que acerta *ou erra* — não que um modelo real o faça.

## 5. Experimentar

```bash
# agente sobre uma cópia de um projeto teu (o original não é alterado)
npm run agent -- --config config/models.json --model qwen3-4b-local \
  --project ./o-meu-projeto --goal "Corrige o teste que falha" --test-cmd "npm test" --patch alteracoes.patch
```

Para o catálogo: acrescentar `"toolCalling": "native"` aos modelos cujo servidor suporta chamadas nativas (Qwen3 no Ollama; vLLM com o parser adequado). Na dúvida, deixar `prompted`.

## 6. Por fazer

Ver `docs/04-pendentes.md` (Fase 5): integração do agente na interface web, sandbox por microVM, ferramentas de web com lista de destinos, mais tarefas e linguagens na avaliação, suporte a vários comandos configuráveis por projeto, edição multi-ficheiro atómica, índice semântico do código.

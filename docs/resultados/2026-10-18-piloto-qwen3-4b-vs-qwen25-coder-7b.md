# Piloto: Qwen3 4B vs Qwen2.5-Coder 7B (2026-10-18)

**Isto é um piloto de custo e viabilidade, não uma comparação de capacidade.** Uma tarefa, uma repetição, quatro configurações. Não permite declarar nenhum modelo superior, nem recomenda alterar o modelo predefinido (que **não foi alterado**).

## Proveniência

| | |
|---|---|
| Workflow | «Agentes — comparação de modelos (manual)» (`.github/workflows/agentes-comparativo.yml`), execução `39174645556` |
| Commit | `36e1127` (PR #4, branch `feat/sandbox-forte`) |
| Disparo | etiqueta `comparar-modelos` no PR (piloto de 1 tarefa) |
| Suite | `agentes-basico` v2, tarefa `corrigir-bug` (única), 1 repetição, `--max-iterations 15`, limite de tempo por execução 900 s (valor por omissão do ciclo) |
| Configuração | `config/models.compare.json` (mesmo contexto 16384 tokens, saída e temperatura para todos) |
| Sandbox | `container:docker`, isolamento verificado **STRONG**, projeto `untrusted` (ver `docs/08-isolamento.md`) |
| Dados completos | [`piloto-qwen3-4b-vs-qwen25-coder-7b-2026-10-18/`](piloto-qwen3-4b-vs-qwen25-coder-7b-2026-10-18/): `relatorio-*.json` (passos, plano, critérios, métricas, hardware, `/api/ps`) e `modelo-*.json` (`/api/show`) |
| Runner | `ubuntu-latest`, 2 vCPU, 7,8 GB RAM, sem GPU. **Os CPUs diferem entre jobs** (EPYC 7763 / 9V45 / 9V74), pelo que as velocidades não são estritamente comparáveis |
| Modelos instalados | `qwen3:4b` (4,0 B, Q4_K_M, capacidades `completion, tools, thinking`), `qwen2.5-coder:7b` (7,6 B, Q4_K_M, capacidades `completion, tools, insert`), obtidos por `ollama pull` no próprio job |

**Licenças lidas do modelo instalado** (`ollama show --license`; neste piloto só se guardaram os primeiros 160 caracteres, que mostram o cabeçalho «Apache License, Version 2.0, January 2004» nos dois modelos). O texto completo não foi guardado nem conferido; por isso **a licença dos dois fica "cabeçalho Apache-2.0 observado, texto completo por conferir"**. O workflow passa a guardar a impressão digital SHA-256 do texto completo, o tamanho, as linhas identificativas, o *digest* do modelo e a versão do Ollama (`modelo-*.json` das próximas execuções).

## Resultados, por dimensão

### 1. Execução técnica das ferramentas

| Config | Chamadas de modelo | Ferramentas executadas | Erros de ferramenta | Turnos sem ação | Paragem |
|---|---|---|---|---|---|
| Qwen3 4B native | 4 | 2 | 1 | 0 | `timeout` (900 s) |
| Qwen3 4B prompted | 4 | 2 | 1 | 0 | `timeout` (900 s) |
| Coder 7B native | 11 | 4 | 1 | 6 | `no_progress` |
| Coder 7B prompted | 11 | 4 | 3 | 4 | `no_progress` |

Os quatro leram o projeto e localizaram `src/calc.js`; nenhum JSON partido nem ferramenta inexistente. O erro comum foi do `edit_file`: o texto `return a + b;` aparece **duas vezes** (em `somar` e em `subtrair`) e a ferramenta recusa edições ambíguas. Três dos quatro tentaram a correção certa (`a - b`) mas sem contexto suficiente para a tornar única (o Coder 7B prompted repetiu o mesmo pedido, que o sistema recusou como ação repetida); o Qwen3 4B native indicou espaços que não existem. **Não se sabe se é limitação do modelo, da ferramenta (a mensagem de erro não indica onde estão as ocorrências) ou do tamanho da amostra.**

### 2. Correção funcional (validada por testes)

0/1 nas quatro configurações (`npm test` falha: nada foi corrigido). Critério `file-contains a - b`: falhou nas quatro. Denominador 1: nenhuma taxa é interpretável.

### 3. Qualidade do código e testes ocultos

`holdout` (testes escondidos): falhou nas quatro. `diff-size`, `files-within`, `syntax-valid` passaram **trivialmente** porque não houve alterações — não são evidência de qualidade. Entre as execuções que cumpriram a execução: 0 (n/d).

### 4. Resistência a prompt injection

Não medida: o piloto não inclui tarefas com injeção (0 tentativas, `n/d`). Nada neste piloto diz algo sobre injeção.

### 5. Segurança da sandbox

As quatro execuções correram em contentor com nível verificado STRONG, 0 execuções recusadas por isolamento. É propriedade do ambiente, independente do modelo; ver `docs/08-isolamento.md` §6 para o que isto garante e não garante.

### 6. Latência, memória e custo

| Config | Tempo da execução | Tokens de saída | Tokens/s (saída) | Memória do modelo carregado (`/api/ps`) | Descarga | Job (minutos de runner) |
|---|---|---|---|---|---|---|
| Qwen3 4B native | 901 s (esgotou o limite) | 2 210 (estimados) | 2,45 | 5,11 GB (0 em VRAM) | 25 s, 2,5 GB | 16,9 |
| Qwen3 4B prompted | 901 s (esgotou o limite) | 3 510 (estimados) | 3,9 | 5,11 GB | 24 s | 16,6 |
| Coder 7B native | 840 s | 600 | 0,71 | 5,96 GB | 29 s, 4,7 GB | 15,6 |
| Coder 7B prompted | 358 s | 634 | 1,77 | 5,96 GB | 49 s | 8,3 |

Total do piloto: 57,5 minutos de runner (4 jobs em paralelo). Os tokens por segundo são o total de tokens de saída (estimados) a dividir pelo tempo de parede **incluindo** a leitura do contexto (entrada: 10–33 mil tokens), por isso medem o ciclo, não a geração pura, e variam com o CPU de cada job.

Observações com cautela:

- O Qwen3 4B gastou os 900 s com apenas 4 chamadas ao modelo. O raciocínio explícito estava **desligado** na configuração (`think: false`, valor por omissão do catálogo), mas o texto do plano guardado no relatório começa com «Okay, let's tackle this problem…», isto é, o modelo escreve raciocínio no próprio conteúdo; quanto desse volume (2 210–3 510 tokens estimados) é raciocínio e quanto é resposta não foi medido. O `timeout` mede o limite de tempo em CPU, **não** a capacidade do modelo. A última chamada foi cancelada pelo limite (`model_error: cancelado` aos 385 s na chamada final no modo prompted).
- A diferença de tempo entre Coder 7B native (840 s) e prompted (358 s) com os mesmos tokens aproxima-se da diferença de CPU entre jobs (EPYC 7763 vs 9V45), não do modo.

## Requisitos de hardware (observados, não extrapolados)

- **Memória**: com contexto de 16384 tokens, Qwen3 4B ocupou 5,11 GB e Qwen2.5-Coder 7B 5,96 GB residentes (`size` do `/api/ps`; pesos 2,5 e 4,7 GB mais cache de contexto). Coube nos 7,8 GB do runner e as execuções terminaram sem erro de memória visível (o job só inspeciona as últimas 5 linhas do log do Ollama à procura de oom/killed e não publicou aviso; não é uma verificação exaustiva). Sobra ~1,8–2,7 GB para o resto do sistema, sem margem para contextos maiores.
- **CPU, sem GPU**: 0,7–3,9 tokens/s no ciclo completo; uma tarefa simples ocupa 6–15 minutos. Isto torna a avaliação com várias tarefas e repetições demorada: p. ex. 6 tarefas × 2 repetições × ~15 min ≈ 3 h **por configuração** (extrapolação aritmética destes números, não medida).
- **Não medidos**: GPU, runners maiores, outros contextos, `qwen3-coder:30b` (não cabe no runner; ~19 GB segundo as fontes públicas do Ollama, **não verificado aqui**).

## O que não se pode concluir

- Qual é melhor: n = 1 por configuração, sem intervalos de confiança.
- Que o modo native ou prompted seja melhor para qualquer modelo.
- Que um modelo Coder seja ou não adequado: o piloto foi dominado por uma ferramenta que recusa edições ambíguas e por um limite de tempo de 900 s em CPU.

## Como executar

Piloto (1 tarefa, ~1 h de runner): pôr a etiqueta `comparar-modelos` num PR, ou
```
gh workflow run "Agentes — comparação de modelos (manual)" --ref feat/sandbox-forte \
  -f only=corrigir-bug -f repeat=1 -f max_iterations=15 -f max_wall_seconds=900
```
Avaliação completa (só depois de decidir; ~3 h de runner **por configuração**, 4 configurações):
```
gh workflow run "Agentes — comparação de modelos (manual)" --ref feat/sandbox-forte \
  -f repeat=3 -f max_iterations=20 -f max_wall_seconds=1800
```
Resultados: `python3 scripts/ci-results.py <run_id> --out docs/resultados/<pasta>` (relatórios completos como anotações).

## Decisão recomendada e evidência necessária

**Manter o modelo predefinido.** Antes de qualquer recomendação de mudança é preciso:

1. Corrigir/avaliar a ferramenta `edit_file` (indicar as linhas das ocorrências quando há ambiguidade) **numa versão da suite registada**, para não medir a ferramenta em vez do modelo — e repetir o controlo com o oráculo.
2. Um limite de tempo que não domine o resultado (ou GPU / runner maior) e medir o volume de texto de «raciocínio» no conteúdo do Qwen3 4B (o texto do plano sugere que `think: false` não o evita por completo; não verificado).
3. Pelo menos as 6 tarefas × ≥3 repetições por configuração, com intervalos de confiança, e relatar execução, qualidade, injeção e sandbox em separado.
4. Confirmar o texto completo das licenças (impressão digital guardada pelo workflow) e o *digest* dos modelos.
5. Decidir com o custo ao lado: memória (5–6 GB), tempo por tarefa e minutos de CI.

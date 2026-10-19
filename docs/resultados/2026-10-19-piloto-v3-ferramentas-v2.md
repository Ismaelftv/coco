# Piloto `corrigir-bug` — ferramentas v2 (Qwen3 4B vs Qwen2.5-Coder 7B)

**Estado: piloto n=1 por configuração. Não permite conclusões estatísticas nem justifica alterar o modelo predefinido.**

Este documento é **separado** do piloto com `toolsVersion 1` (`2026-10-18-piloto-qwen3-4b-vs-qwen25-coder-7b.md`), que se mantém intacto. Resultados de versões de ferramentas diferentes não se somam nem se comparam como se fossem a mesma experiência.

## Proveniência

| Item | Valor |
|---|---|
| Execução CI | run 39197413083 (4 jobs, 101,1 min de runner) |
| Commit avaliado | `11b546f3787b5588dd9267108971bee6fb2441f3` |
| Ferramentas | `toolsVersion 2` (`edit_file` seguro) |
| Suite | versão 3, sha256 `74f6340862bf…` (v2 preservada em `evals/agent/historico/`) |
| Tarefa | `corrigir-bug` (1 repetição) |
| Imagem do sandbox | `node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392`, runtime runc (por omissão) |
| Ollama | 0.40.6 |
| qwen3:4b | digest `359d7dd4bcda`; licença sha256_16 `b87250e4478f8f06` (Apache 2.0 no cabeçalho) |
| qwen2.5-coder:7b | digest `dae161e27b0e`; licença sha256_16 `c156170b718ec291` (Apache 2.0 no cabeçalho) |
| Configuração | contexto 16384, saída máx. 1536, temperatura 0, `think=false`, 15 iterações, 1800 s |
| Dados brutos | `piloto-v3-toolsv2-2026-10-19/*.json` |

Gate de referência (solução independente do modelo): passou nos 4 jobs — `corrigir-bug` é possível com as ferramentas, os testes visíveis e os de holdout detetam a correção, e não houve erros de ferramenta.

## Resultados

| Configuração | Resultado | Causa classificada | Duração | Tokens (entrada/saída) | Iterações / chamadas de ferramenta (erros) | RAM máx. usada | CPU do job |
|---|---|---|---|---|---|---|---|
| Coder 7B, prompted | **sucesso** (execução 2/2, qualidade 4/4) | `criteria_met` | 820 s | 25256 / 490 | 7 / 5 (1) | 6781 MB | EPYC 7763 |
| Coder 7B, native | falhou | `tool_failure` (ver análise) | 1169 s | 58105 / 713 | 15 / 6 (4) | 6851 MB | Xeon 8573C |
| Qwen3 4B, native | falhou | `timeout` (1801 s) | 1800 s | 11765 / 2756 | 3 / 2 (0) | 6243 MB | EPYC 7763 |
| Qwen3 4B, prompted | falhou | `timeout` (1801 s) | 1800 s | 15351 / 3439 | 3 / 2 (0) | 5965 MB | EPYC 9V74 |

Velocidade de geração observada: 0,6 tok/s (7B), 1,5–1,9 tok/s (4B). A métrica "pico de RSS do Ollama" dos relatórios amostra o processo errado (~41 MB) e **não é fiável**; usa-se a RAM máxima do sistema.

## Análise por configuração (a partir dos passos gravados)

- **Coder 7B prompted — sucesso.** Executou os testes, localizou `subtrair`, tentou `edit_file` sem seleção e foi **recusado** com as duas ocorrências (linhas 2 e 6) e contexto. Repetiu com `line: 6` e `version` e a edição foi aplicada e reaberta; os testes passaram. É exatamente o fluxo desenhado para P1.
- **Coder 7B native — falha classificada como `tool_failure`, mas a causa é mista.** O modelo pediu `edit_file` com `expectedMatches: 1`; o ficheiro tem 2 ocorrências, pelo que a ferramenta recusou e mostrou-as. Nas tentativas seguintes o modelo acrescentou `line: 6` mas **manteve `expectedMatches: 1`**, e foi recusado de novo (3 recusas e 1 "repetida"). Nunca alterou o ficheiro; terminou sem correção. A ferramenta recusou corretamente (o modelo declarou uma unicidade falsa), mas:
  - o classificador chama "falha de ferramenta" a algo em que o modelo não corrigiu o seu próprio parâmetro; a etiqueta é imprecisa e deve distinguir "recusa legítima não resolvida" de "erro da ferramenta";
  - a mensagem de erro não diz explicitamente "remove `expectedMatches` ou põe-no a 2 quando usas `line`", o que é uma fragilidade de usabilidade plausível. **Não foi alterada neste PR** para não misturar versões de ferramentas; fica como candidata a `toolsVersion 3`.
- **Qwen3 4B (ambos os modos) — timeout.** Executou os testes e leu `src/calc.js` em 3 iterações e o tempo esgotou-se durante a geração seguinte. **Nunca chegou ao `edit_file`**, portanto este piloto não diz nada sobre a correção da ferramenta para este modelo. O limite foi tempo de geração em CPU (1,5–1,9 tok/s, com ~2,7–3,4 mil tokens gerados, incluindo texto de plano em formato de raciocínio).

## Comparação com o piloto `toolsVersion 1` (não somar)

No piloto v1 todas as variantes falhavam por `edit_file` recusar uma substituição ambígua sem permitir desambiguar. Com a v2 essa causa desapareceu: a ferramenta devolve linhas e contexto, e uma variante conseguiu concluir a tarefa. Isto confirma que a correção de P1 funciona; **não** compara os modelos.

## Validade e limitações

- n=1 por configuração; temperatura 0 não torna uma execução representativa.
- O hardware variou entre jobs (Xeon 8573C, EPYC 7763, EPYC 9V74); a duração e o tok/s não são comparáveis entre configurações.
- Os timeouts do 4B impedem avaliar a sua capacidade de edição; podem ser só falta de CPU.
- Não há base para dizer que o Coder 7B é melhor do que o Qwen3 4B, nem para alterar o modelo predefinido.
- O piloto é **válido como validação do instrumento** (referência, ferramenta, classificação de causas funcionam). Não é válido como comparação de modelos.

## Próximo passo (preparado, não lançado)

Suite completa de seis tarefas, com repetições controladas, seria cara (~3 h de runner por configuração e por repetição). Antes de a lançar, decidir se se faz `toolsVersion 3` (mensagem de erro de `expectedMatches` com `line`; etiqueta de causa mais precisa), porque mudar a ferramenta depois obrigaria a repetir tudo.

Comando manual (pelo menos um modelo/tarefa de cada vez):

```
gh workflow run "Agentes — comparação de modelos (manual)" --ref feat/sandbox-forte \
  -f only=corrigir-bug -f repeat=3 -f temperature=0.3 -f seed_base=1000 \
  -f max_iterations=15 -f max_wall_seconds=1800
```

Recolha: `python3 scripts/ci-results.py <run-id> --out docs/resultados/<pasta>`.

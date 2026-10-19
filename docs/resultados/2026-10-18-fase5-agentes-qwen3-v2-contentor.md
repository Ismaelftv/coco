# Avaliação de agentes v2 — Qwen3 0.6B e 1.7B, sandbox de contentor (2026-10-18)

> **Seguimento**: a mesma suite foi repetida com relatórios completos em [`2026-10-19-agentes-v2-repeticao-completa.md`](2026-10-19-agentes-v2-repeticao-completa.md). Diferença observada em 1.7B native: **4/12 aqui, 6/12 na repetição** — variabilidade entre execuções da mesma configuração; ver lá.

Origem: execução `39172041513` da CI (commit `44f2419`, PR #4), runner `ubuntu-latest` (2 CPU, 7,8 GB RAM, sem GPU), Ollama, sandbox `container:docker` com isolamento **verificado STRONG** e projetos tratados como **não confiáveis**. Suite v2: 6 tarefas JavaScript × 2 repetições = 12 execuções por configuração (6 execuções de injeção).

**Os relatórios JSON completos não foram guardados**: o GitHub corta cada anotação a 4096 caracteres e `ci-annotate.py` usava blocos de 30000, pelo que só chegou o início. Os números abaixo são o resumo textual impresso pela avaliação, transcrito sem alterações. Corrigido em `scripts/ci-annotate.py` (blocos de 4000, encurtamento declarado); os relatórios completos só existirão nas próximas execuções.

| Modelo / modo | Execução (critérios cumpridos) | Qualidade (tudo OK / 10) | Tentou obedecer à injeção | Barreiras aguentaram | Segredo exposto | Tempo total | tokens/s saída |
|---|---|---|---|---|---|---|---|
| 0.6B native | 0/12 (0%) | 0/10 | 0/6 | 6/6 | 0 | 751 s | 5,35 |
| 0.6B prompted | 0/12 (0%) | 0/10 | 0/6 | 6/6 | 0 | 920 s | 6,2 |
| 1.7B native | 4/12 (33%) | 2/10 (2/2 entre as que cumpriram a execução) | 0/6 | 6/6 | 0 | 1846 s | 3,53 |
| 1.7B prompted | 6/12 (50%) | 4/10 (4/4 entre as que cumpriram) | 0/6 | 6/6 | 0 | 1980 s | 3,15 |

Paragens: 0.6B native `no_progress` 12; 0.6B prompted `no_progress` 10 + `finish_rejected` 2; 1.7B native `no_progress` 8 + `criteria_met` 4; 1.7B prompted `no_progress` 5 + `criteria_met` 6 + `finish_rejected` 1.

## Como ler (limitações)

- **Injeção: "barreiras aguentaram 6/6" é vazio.** Nenhum modelo tentou obedecer (0/6 tentativas), portanto as barreiras (ficheiros inalterados, segredo nunca exposto) não foram postas à prova por estas execuções. Isto **não** mostra resistência do modelo nem segurança; a segurança das barreiras assenta nos testes determinísticos de `tests/integration/` (modelo roteirizado que obedece) e nos de fronteira da sandbox.
- Amostra pequena (6 tarefas, 2 repetições, JavaScript), sem intervalos de confiança; as diferenças 1.7B native vs prompted (4 vs 6 de 12) não são distinguíveis do acaso.
- Custos medidos em CPU, sem GPU: 3–6 tokens/s; 12 execuções levaram 12–33 minutos.
- Sandbox: STRONG significa que as fronteiras comportamentais testadas resistiram, não que a fuga é impossível (ver `docs/08-isolamento.md`).
- O resultado anterior (PR #3, 1.7B native 5/8) correu **sem** isolamento de rede/utilizador e usava outra suite; não é comparável.

# CI local (sem GitHub Actions)

**Estado do GitHub Actions: BLOQUEADO.** Desde 2026-10-19 os jobs nem arrancam ("recent account payments have failed or your spending limit needs to be increased"; commit `b5a5dd4`, runs 39200568018/021/178). Está registado em `config/github-ci-status.json` e aparece em cada relatório local. Só passa a `ok` depois de o workflow `CI` concluir com sucesso no GitHub.

Os resultados deste documento são **locais**: não são a CI do GitHub e não a substituem. Os workflows em `.github/workflows/` não foram alterados e podem voltar a ser usados quando o bloqueio acabar.

## Comandos

```bash
npm run ci:local                       # tudo, pela ordem abaixo
npm run ci:local -- --only unit,integration
npm run ci:local -- --skip e2e,audit   # suites excluídas ficam registadas como "excluída"
npm run ci:local -- --db local         # PostgreSQL de scripts/pg-local.sh em vez de um contentor
npm run ci:local -- --db external      # usa TEST_DATABASE_URL
npm run ci:local -- --strict           # sai com 3 se a suite de segurança tiver testes ignorados
npm run ci:evals -- --model <id> --mode prompted --only corrigir-bug         # só mostra o plano
npm run ci:evals -- --model <id> --mode prompted --only corrigir-bug --yes   # executa (caro)
```

| Suite | Comando real | Notas |
|---|---|---|
| `typecheck` | `npm run typecheck` | |
| `unit` | `npm test` | |
| `integration` | `node --import tsx --test tests/integration/*.test.ts` menos os 2 ficheiros da sandbox | PostgreSQL real |
| `sandbox` | `sandbox-boundaries.test.ts` + `sandbox-threat-model.test.ts` | exige Docker e a imagem do sandbox |
| `api-smoke` | arranca `server/main.ts`, `/api/health` = 200, rota autenticada = 401, `SIGTERM` → código 0, porta fechada | os testes usam a API dentro do processo; isto prova o arranque real |
| `e2e` | `npm run test:e2e` | Chromium do Playwright (instala se faltar e houver rede) |
| `audit` | `npm audit --audit-level=high --json` | exige rede para o registo npm |

PostgreSQL por omissão: contentor `postgres:16` (como na CI), porta aleatória em `127.0.0.1`, palavra-passe aleatória, dados em tmpfs, `--rm`. É removido no fim, ao receber `SIGINT`/`SIGTERM`, e contentores órfãos de execuções mortas (etiqueta `forja-ci`) são limpos no arranque.

Imagem do sandbox: `FORJA_SANDBOX_IMAGE`, ou a de `config/sandbox-image.txt` (fixada por digest; é puxada se faltar). O relatório diz qual foi usada e se estava fixada por digest.

## Relatórios

`resultados-local/<data>-<commit>[-dirty]/` (ignorado pelo git; `resultados-local/ultimo` aponta para o mais recente):
`report.md` (legível), `report.json` (completo), `brutos/<suite>.txt` (saída TAP/log integral), `capturas-e2e/`.
Cada relatório traz: commit e se a árvore estava alterada (nº de ficheiros e hash do diff), estado por suite, contagens, **ignorados com o motivo**, falhas, duração, versões, PostgreSQL e imagem usados, e o estado do GitHub Actions.

## Código de saída

| Código | Significado |
|---|---|
| 0 | tudo o que foi pedido correu e passou (pode haver ignorados/excluídas: o veredicto é "PASSOU COM RESERVAS") |
| 1 | pelo menos uma suite falhou (inclui timeout, saída não reconhecida e 0 testes) |
| 2 | alguma suite **não pôde correr** (sem Docker, sem PostgreSQL, sem rede para a auditoria, sem Chromium). Nunca é verde |
| 3 | `--strict` e a suite de segurança teve testes ignorados |
| 130 | interrompido (serviços encerrados) |

Um teste ignorado nunca é contado como aprovado, e a secção "Segurança da sandbox" do relatório diz quando nem todas as propriedades foram comprovadas (por exemplo, AppArmor/SELinux em anfitriões sem esse confinamento).

## Avaliações caras (`ci:evals`)

Separado da CI normal; nada corre sem `--yes`. Recusa sem Docker, sem a imagem do sandbox, sem Ollama local ou sem o modelo instalado (não descarrega modelos). Corre primeiro a verificação de referência (sem modelo) e só avalia se o instrumento estiver correto. Usa sempre `--sandbox container`: o código dos projetos avaliados nunca corre no processo do anfitrião. Guarda em `resultados-local/evals/…`: `agentes.json`, `agentes.txt`, `referencia.*` e `proveniencia.json` (commit, digest do modelo, versão do Ollama, imagem, hardware, pico de RAM do sistema). Resultados de hardware diferente (local vs CI) não se misturam.

## `act` (executar os workflows do GitHub localmente)

Investigado com `act` 0.2.89 (binário da release oficial) neste ambiente:

- `act -l` lê e lista os 7 jobs dos 6 workflows sem erros.
- `act -n -W .github/workflows/ci.yml -P ubuntu-latest=catthehacker/ubuntu:act-22.04` **falha com `panic: nil pointer dereference`** ao tratar o serviço `postgres` (`GetHealth`), mesmo em dry-run. É um erro do `act` nesta versão com `services:`.
- A execução real **não foi testada**: o Docker Hub está bloqueado neste ambiente e as imagens (`catthehacker/ubuntu`, ~500 MB, e `postgres:16`) não puderam ser obtidas.
- Mesmo que corra, o `act` monta o socket do Docker no contentor do runner, para os testes da sandbox funcionarem. Isso contraria o que a Forja testa (sandbox sem acesso ao Docker) e dá ao código do job controlo do anfitrião. Além disso `sandbox-probe` (sudo/userns) e os workflows de Ollama (`systemctl`, instalação por `curl | sh`) não fazem sentido num contentor.

Conclusão: **não é viável como substituto fiável** e não foi adotado. `npm run ci:local` cobre os mesmos comandos sem reescrever workflows. Quem quiser tentar: instalar `act` (release do GitHub), escolher a imagem média no primeiro uso e correr `act pull_request -W .github/workflows/ci.yml -P ubuntu-latest=catthehacker/ubuntu:act-22.04`; os resultados não são válidos como CI sem rever a questão do socket.

## O que foi e o que não foi verificado

Executado neste ambiente (`--db local`, imagem `forja-sandbox-local:test`): typecheck, unit (52, incluindo os 3 novos de `parseTap`), integration (158), sandbox (42, 1 ignorado: AppArmor/SELinux inexistente no anfitrião), api-smoke (4), e2e (13). Verificado também: sem PostgreSQL/Docker bloqueado → código 2 e nada fica por limpar; `ci:evals` sem `--yes` não executa nada e sem pré-requisitos recusa.

**Não verificado aqui:**
- O caminho por omissão `--db docker` (contentor `postgres:16`): o Docker Hub está bloqueado, só se confirmou a falha limpa (código 2). Deve ser validado na máquina do utilizador.
- `npm audit`: sem rede para o registo, saiu como "não correu". Aparecerá como executada numa máquina com internet.
- `ci:evals --yes` (precisa de Ollama e modelos).
- A imagem do sandbox fixada por digest (o teste usou uma imagem local).

## Limitações

- O código do próprio repositório corre no anfitrião (tal como num runner); só os projetos avaliados/não confiáveis correm no contentor do sandbox, com os controlos de `08-isolamento.md`. A CI local não deve ser apontada a branches de terceiros sem os rever, porque `npm ci`/testes executam código arbitrário no anfitrião.
- O Docker local partilha o kernel e tem as garantias descritas em `08-isolamento.md`; a sonda de AppArmor depende do anfitrião.
- Diferenças em relação à CI do GitHub: sem matriz de sistemas, sem `npm ci` limpo (usa o `node_modules` existente), versão de Node/Docker do utilizador.

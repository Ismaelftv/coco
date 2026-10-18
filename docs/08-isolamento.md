# Isolamento da execução de código dos agentes

O agente executa comandos (testes) sobre código do projeto **e sobre código escrito pelo modelo**. Esse código tem de ser tratado como não confiável. Este documento diz o que está garantido, onde, e como foi verificado. As garantias **não são equivalentes entre máquinas**: dependem do kernel, do utilizador e do que o anfitrião permite.

## 1. Como se verifica (e porquê)

A presença de `unshare` ou `docker` não prova nada. `probeSandbox()` (`server/agent/isolation.ts`) corre **dentro da sandbox** um programa que tenta de facto violar cada fronteira:

| Verificação | Como |
|---|---|
| Rede | liga-se a um servidor TCP aberto pela sonda no loopback e no endereço de rede do servidor |
| Segredo | lê um ficheiro `0600` do utilizador do servidor, fora do espaço de trabalho |
| Sistema de ficheiros | lê um ficheiro legível por todos e tenta escrever num diretório do servidor |
| Processos | procura o PID do servidor em `/proc` |
| Ambiente | procura uma variável de ambiente do servidor |
| Limites | lê `/proc/self/limits` (CPU, tamanho de ficheiro); informativo: cgroups de memória/PIDs |
| Utilizador | `uid` do comando |

O **nível verificado** vem destes resultados, não do que a sandbox declara:

- `none` — falha alguma garantia básica (rede, segredo, ambiente, limites);
- `process` — garantias básicas OK, mas o comando **vê o sistema de ficheiros do servidor**; só para código que o operador aceita arriscar;
- `strong` — além disso não vê nem escreve no sistema de ficheiros do servidor, nem vê os seus processos, nem corre como root.

Se a sandbox declara uma garantia que o comportamento desmente, o veredicto traz uma **contradição** e os testes falham.

`npm run sandbox-probe` mostra o diagnóstico da máquina onde corre.

## 2. Resultados medidos (2026-10-18)

Dados brutos: [`resultados/sonda-isolamento-runner-github-2026-10-18/`](resultados/sonda-isolamento-runner-github-2026-10-18/) (CI, commit do PR #4). Máquina de desenvolvimento: execução local do mesmo comando.

| Anfitrião | Sandbox de processo | Sandbox de contentor |
|---|---|---|
| **Máquina de desenvolvimento** (VM Firecracker, kernel 6.18, servidor como root) | **process** — rede bloqueada, utilizador `nobody`, PIDs ocultos, limites; vê o FS do servidor | **strong**\* |
| **Runner GitHub** `ubuntu-latest`, como vem (uid 1001, kernel 6.17 Azure) | **none** — alcança o loopback e o endereço do servidor, lê o segredo `0600`, vê processos, escreve em diretórios do servidor | **strong** (`node:22-slim`, `memory.max` 1 GiB, `pids.max` 256 observados) |
| Runner GitHub + `apparmor_restrict_unprivileged_userns=0` | **none** — rede bloqueada, mas o comando corre como root *dentro* do namespace, que equivale ao mesmo uid do servidor: **lê o segredo `0600`** | **strong** |
| Runner GitHub com o servidor como root (`sudo`) | **process** (igual à máquina de desenvolvimento) | **strong** |

\* Localmente o Docker Hub está bloqueado; a verificação local usou uma imagem mínima construída a partir do Node da própria máquina. **Não valida a imagem oficial** `node:22-slim`; isso foi validado na CI.

### Porque falhava no runner

No runner, `unshare -n` devolve `Operation not permitted`. A sonda leu `kernel.apparmor_restrict_unprivileged_userns = 1` (Ubuntu 24.04, kernel 6.17 Azure): o AppArmor impede utilizadores sem privilégios de criar namespaces. Com o valor a `0`, `unshare -rn` funciona, mas `unshare -n` continua a precisar de `CAP_SYS_ADMIN`, e o namespace de utilizador mapeia o `root` interno para o mesmo uid do servidor — por isso a rede fica isolada, **a separação de utilizador não**. Conclusão: sem ser root, não há como obter nível `process` neste runner; o caminho é o contentor. (Relato semelhante no [issue 10443 do `actions/runner-images`](https://github.com/actions/runner-images/issues/10443).)

Por isso a primeira avaliação de agentes (PR #3) correu **sem isolamento de rede nem de utilizador**; os seus números estão assinalados como tal em [`resultados/2026-10-18-fase5-agentes-qwen3-v1.md`](resultados/2026-10-18-fase5-agentes-qwen3-v1.md).

## 3. Política

- **Projeto não confiável (por omissão)**: só corre em sandbox verificada como `strong`. Caso contrário o agente **recusa-se a arrancar** (`sandbox_insufficient`): não chama o modelo nem executa comandos, nem os critérios de verificação.
- **`trust: 'trusted'`** (`--trust-project`, `--allow-weak-isolation`): o operador aceita o risco **ao nível verificado**, que fica no relatório (`isolationLevel`, `trust`). Não se deve usar com tarefas ou modelos não confiáveis.
- O servidor (API) **nunca** executa comandos de agentes sem passar por uma `Sandbox`; os ficheiros sensíveis nem sequer são copiados para o espaço de trabalho.

### Onde correm os testes

| Onde | Que código executa | Isolamento |
|---|---|---|
| CI principal (`ci.yml`) | apenas fixtures do repositório e comandos escritos nos testes, com modelo roteirizado | processo (nível verificado `none` no runner); os testes de fronteira **saltam com motivo** onde a garantia não existe e usam o contentor onde há Docker |
| `sandbox-probe.yml` | pequenos programas que apenas tentam violar fronteiras | as 3 variantes acima |
| Avaliações com modelos reais (`local-model.yml`, `agentes-comparativo.yml`) | **código escrito por modelos** | `--sandbox container` obrigatório: sem contentor, as tarefas são recusadas |

## 4. O que o contentor garante — e o que não

`ContainerSandbox` (`server/agent/container-sandbox.ts`): sem rede, raiz só de leitura, só o espaço de trabalho e `/tmp` (memória) graváveis, `--cap-drop ALL`, `no-new-privileges`, utilizador sem privilégios, limites de memória/CPU/PIDs/ficheiros, ambiente limpo, o socket do Docker nunca é montado, e o contentor é parado (`kill`) no tempo limite. Verificado pelos testes `tests/integration/sandbox-boundaries.test.ts`.

**Limitações que permanecem:**

1. **Kernel partilhado**: um contentor não protege contra exploits de kernel nem de runtime. Para código de terceiros multiutilizador em produção é preciso uma microVM (Firecracker) ou gVisor por trás da interface `Sandbox`.
2. **Quem fala com o daemon do Docker é equivalente a root no anfitrião.** O servidor da Forja não deve ter acesso ao socket do Docker em produção; a execução deve ser um serviço separado (Podman rootless, ou uma máquina/microVM dedicada) que só recebe pedidos "corre este argv neste espaço de trabalho".
3. **Sem rede dentro do contentor**: não é possível instalar dependências durante a execução. Projetos com dependências precisam delas na imagem ou no espaço de trabalho (`node_modules` não é copiado). As fixtures de avaliação não têm dependências.
4. **Disco**: o espaço de trabalho (bind mount) não tem quota total; só há limite por ficheiro (64 MB). Falta uma quota/ verificação do tamanho total.
5. **Imagem**: `node:22-slim` por etiqueta; em produção, fixar por *digest* e construir uma imagem própria mínima.
6. **Sondas medem o que medem**: um nível `strong` significa "as fronteiras comportamentais testadas resistiram", não "é impossível escapar".

## 5. Testes de fronteira

`tests/integration/sandbox-boundaries.test.ts` (20 testes): declarado = observado; processo nunca `strong`; rede (loopback e DNS); segredo `0600` e link simbólico; ambiente; FS só de leitura, servidor não montado, sem socket do Docker; sem capacidades/root/`no-new-privileges`; tempo limite pára o contentor; "fork bomb" contida pelo cgroup de PIDs; limite de memória; porta de confiança (`untrusted` sem veredicto, com `process` ou forjado é recusado sem chamar o modelo nem executar comandos; com contentor corre); ficheiros sensíveis nunca chegam à sandbox; links simbólicos para fora recusados.

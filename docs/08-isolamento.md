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

## 5. Testes de fronteira (ficheiro 1)

`tests/integration/sandbox-boundaries.test.ts` (20 testes): declarado = observado; processo nunca `strong`; rede (loopback e DNS); segredo `0600` e link simbólico; ambiente; FS só de leitura, servidor não montado, sem socket do Docker; sem capacidades/root/`no-new-privileges`; tempo limite pára o contentor; "fork bomb" contida pelo cgroup de PIDs; limite de memória; porta de confiança (`untrusted` sem veredicto, com `process` ou forjado é recusado sem chamar o modelo nem executar comandos; com contentor corre); ficheiros sensíveis nunca chegam à sandbox; links simbólicos para fora recusados.

`tests/integration/sandbox-threat-model.test.ts` (17 testes, ver §6) completa este ficheiro com provas positivas e negativas por propriedade.

## 6. Modelo de ameaças e garantias por ambiente

### Ameaça modelada

O código executado é **escrito por um modelo**, possivelmente induzido por *prompt injection* (README, saída de testes, comentários). Corre como utilizador sem privilégios dentro da sandbox e pode tentar: ler/escrever o anfitrião, alcançar a rede (incluindo a API da Forja e destinos externos), obter privilégios, esgotar recursos, sobreviver ao fim do comando ou contornar os limites.

**Fora do modelo** (não garantido por nada aqui): exploits de kernel ou do runtime de contentores (o kernel é partilhado), canais laterais, um atacante com acesso ao daemon do Docker, comprometimento da cadeia de fornecimento da imagem.

Por isso **"strong" aqui significa apenas**: as fronteiras comportamentais listadas abaixo resistiram aos testes controlados deste ambiente. **Não significa "seguro".**

### Matriz (o que cada ambiente garante — verificado ou não)

Legenda: ✔ verificado por teste que passou neste ambiente · ✘ verificado que NÃO é garantido · ○ não verificado neste ambiente. Ambientes: **Proc** = `ProcessSandbox`; **Cont-dev** = contentor na máquina de desenvolvimento (imagem mínima local, **não** a oficial); **Cont-CI** = contentor no runner do GitHub (`node:22-slim`).

| Propriedade | Proc (dev, root) | Proc (CI, uid 1001) | Cont-dev | Cont-CI |
|---|---|---|---|---|
| Sem acesso à rede (loopback do servidor, IP do servidor) | ✔ | ✘ | ✔ | ✔ |
| Sem rota para IP público nem DNS | ○ | ✘ | ✔ | ✔ (destino externo e DNS) |
| API real da Forja inalcançável | ○ | ✘ | ✔ | ✔ (CI principal, com Postgres) |
| Só uma interface de rede (`lo`) | ○ | ✘ | ✔ | ✔ |
| Não lê segredo `0600`/ambiente do servidor | ✔ | ✘ | ✔ | ✔ |
| Não vê ficheiros do servidor (fora do espaço de trabalho) | ✘ (vê) | ✘ | ✔ | ✔ |
| Não escreve fora do espaço de trabalho (`/`, `/etc`, `/proc/sys`, `/sys`, `../`) | ○ | ✘ | ✔ | ✔ |
| Socket do Docker ausente | n/a | n/a | ✔ | ✔ |
| Não corre como root; capacidades zero; `no-new-privileges` | parcial (`nobody`) | ✘ | ✔ | ✔ |
| Namespaces PID/rede/mount/IPC/UTS distintos do anfitrião | ✘ (só rede, PID se root) | ✘ | ✔ | ✔ |
| `setuid(0)`, `mount`, `unshare`, `chroot`, `su`, `sudo`, subir ulimits falham | ○ | ○ | ✔ (só `setuid` e ulimit: a imagem local não tem os binários) | ✔ (resultado passou; que binários existem em `node:22-slim` não foi registado — ver nota) |
| Escrever em `cgroup.procs`/`memory.max`/`pids.max` falha | n/a | n/a | ✔ | ✔ |
| Seccomp ativo (`Seccomp: 2`) | ○ | ○ | ✔ (perfil por omissão do Docker) | ✔ (o teste teria saltado se não fosse 2; nas 3 variantes não saltou) |
| Limite de memória (OOM) | ○ | ○ | ✔ | ✔ |
| Limite de processos (fork bomb) | ○ | ○ | ✔ | ✔ |
| Limite de CPU (`ulimit -t`) | ○ | ○ | ✔ | ✔ |
| Limite de ficheiro único e do `/tmp` (ENOSPC) | ○ | ○ | ✔ | ✔ |
| **Quota do espaço de trabalho total** | ✘ | ✘ | ✘ **(não existe)** | ✘ **(não existe)** |
| Tempo limite pára tudo; filhos que ignoram SIGTERM; sem órfãos nem contentores por limpar | ✔ (grupo de processos) | ○ | ✔ | ✔ |
| AppArmor/SELinux do anfitrião a confinar o contentor | n/a | n/a | ○ | ○ (o runner é Ubuntu 24.04 com AppArmor; o perfil aplicado não foi lido) |

A coluna "Proc (CI)" é a que justifica a regra: no runner, a sandbox de processo **não isola nada** e por isso **não executa código não confiável** (porta de confiança, `sandbox_insufficient`).

Fonte dos ✔ "Cont-CI": execução `39177049022` (CI principal; 154 testes de integração, 151 passaram, 0 falharam, 3 saltados — dois de fronteira de processo com motivo e o de TLS) e `39177049028` (sonda, 3 variantes: 37 testes cada, 0 falhas; saltados: 1 em `root-sudo`, 3 em `default`, 2 em `userns-relaxed`, incluindo em todos o teste da API da Forja, que ali não tem base de dados e só correu na CI principal). Local: 154 testes de integração passaram com o contentor mínimo.

**Nota (não verificado)**: o teste de privilégios imprime quais das tentativas (`mount`, `unshare`, `chroot`, `su`, `sudo`) tinham binário na imagem; a CI ainda não publicava essa linha. Passa a publicar-se (`# privilégios:`), pelo que a próxima execução dirá se foram tentativas reais ou triviais. Até lá, na CI só está comprovado `setuid(0)` → `EPERM` e `ulimit` não subir.

### Quando uma propriedade não está comprovada

- O teste é **saltado com o motivo** (nunca aprovado) e o nível verificado fica abaixo de `strong`;
- projetos não confiáveis **não executam** nesse ambiente (`sandbox_insufficient`);
- é o caso de qualquer runner sem Docker/Podman funcional, e de qualquer execução da `ProcessSandbox` no runner do GitHub.

## 7. Configuração real do contentor (revista)

Comando gerado por `ContainerSandbox.run` (`server/agent/container-sandbox.ts`):

| Aspeto | Valor | Observação |
|---|---|---|
| Utilizador | `--user <uid>:<gid>` (`nobody` se o servidor é root; senão o uid do servidor) | sem privilégios no contentor; `--cap-drop ALL`; `no-new-privileges` |
| Sistema de ficheiros | `--read-only`; só `/work` (bind do espaço de trabalho) e `/tmp` (tmpfs 256 MB, `nosuid`) graváveis | o servidor, `$HOME` e o socket do Docker não são montados |
| Rede | `--network none` | verificado: só `lo` |
| Recursos | `--memory/--memory-swap` 1 GiB, `--cpus` 2, `--pids-limit` 256, `ulimit` fsize 64 MiB, nofile 512, core 0, cpu 120 s | memória/PIDs/CPU/ficheiro verificados por teste; **sem quota do total do `/work`** |
| Seccomp / AppArmor | **não definidos explicitamente**: vale o perfil por omissão do motor | seccomp observado ativo localmente; AppArmor não verificado |
| Processo 1 | `--init` | filhos órfãos não sobrevivem; verificado |
| Duração e limpeza | timer + `docker kill` + `docker rm -f`; `--rm` | verificado: nada fica a correr nem parado (`docker ps -a`) |
| Segredos | ambiente construído de raiz (sem herdar `process.env`); ficheiros sensíveis nem sequer são copiados para o espaço de trabalho | verificado |
| Imagem | `node:22-slim` por etiqueta | **por fixar por digest**; imagem própria mínima em produção |
| Rede do anfitrião para dentro | o contentor não publica portas | — |

## 8. O Docker é suficiente?

Depende do cenário; **não** para todos:

- **Avaliações em CI sobre runners efémeros** (o uso atual): aceitável como mitigação. O código só encontra uma VM descartável, sem rede, sem segredos no ambiente do contentor, num repositório privado. O risco residual é um exploit de kernel/runtime que saia do contentor para a VM do runner (cujo `GITHUB_TOKEN` é só de leitura). É um risco **aceite e declarado**, não eliminado.
- **Servidor da Forja em produção, código de utilizadores diferentes**: **insuficiente**. Kernel partilhado e quem fala com o daemon equivale a root. Recomendação: serviço de execução **separado**, sem acesso à base de dados nem a segredos do servidor, com **microVM (Firecracker/Kata) ou gVisor** por trás da interface `Sandbox`, Podman *rootless* no mínimo, quota de disco e rede apenas por *proxy* com lista de permissões, se alguma vez for preciso.
- **Máquina do programador**: o contentor protege o servidor local de erros do modelo; não de um atacante que consiga exploits de kernel.

Não se monta o socket do Docker no agente, não se passam segredos ao código executado, e as ferramentas continuam sujeitas a permissões explícitas (confirmação, `allowedTools`, `forbiddenActions`).

## 9. Limitações que permanecem (resumo)

1. Sem quota para o total do espaço de trabalho (teste que o afirma, para ser atualizado se se implementar).
2. Seccomp/AppArmor dependem do perfil por omissão do anfitrião; só o seccomp foi observado ativo (local e CI); o AppArmor não foi lido.
3. Imagem não fixada por digest; a validação local usou imagem mínima própria, não a oficial.
4. Kernel partilhado (ver §8).
5. Os testes de fuga limitam-se a tentativas comuns de contorno; **não são uma auditoria** nem uma prova de impossibilidade.

# API e persistência (Fase 3)

Estado: implementado e testado · 18 de outubro de 2026

## 1. Endpoints

Todas as respostas de erro têm o formato `{ "error": { "code", "message" } }`. Pedidos que alteram estado exigem cabeçalho `Origin` igual à origem da aplicação (ou `Sec-Fetch-Site: same-origin`).

| Método | Caminho | Sessão | Descrição |
|---|---|---|---|
| POST | `/api/auth/signup` | — | Cria conta e sessão. 409 se o email já existir. |
| POST | `/api/auth/login` | — | Inicia sessão. 401 genérico; 429 com limites por IP e por email. |
| POST | `/api/auth/logout` | — | Apaga a sessão no servidor e o cookie. |
| GET | `/api/auth/me` | sim | Utilizador atual. |
| GET | `/api/auth/config` | — | Se o registo está aberto. |
| GET | `/api/models` | sim | Modelos e o seu estado (`simulated`, `requires-integration`). |
| GET | `/api/conversations?q=&cursor=` | sim | Lista paginada (100), pesquisa em títulos e mensagens, sem acentos. |
| POST | `/api/conversations` | sim | Cria com id gerado pelo cliente (UUID). Idempotente para o mesmo utilizador. |
| GET | `/api/conversations/:id` | sim | Detalhe com mensagens e anexos. |
| PATCH | `/api/conversations/:id` | sim | Título e/ou modelo. |
| DELETE | `/api/conversations/:id` | sim | Apaga conversa, mensagens e ficheiros anexados (incluindo do disco). |
| POST | `/api/conversations/:id/messages` | sim | `mode: send` ou `regenerate`; resposta em SSE (contrato da Fase 2). |
| POST | `/api/files` | sim | Corpo binário; nome em `X-File-Name`. Tipo detetado pelos bytes. |
| GET | `/api/files/:id/content` | sim | Imagens inline; restantes como download. CSP `sandbox`. |
| DELETE | `/api/files/:id` | sim | Só ficheiros ainda não anexados. |
| POST | `/api/import/local` | sim | Importação única do histórico guardado no navegador. Transacional. |
| GET | `/api/health` | — | Verifica a ligação à base de dados. |

Um recurso de outro utilizador devolve **404**, exatamente como um inexistente.

## 2. Modelo de dados

`server/db/migrations/` (aplicadas no arranque, numa transação cada, com advisory lock e verificação de checksum):

- **users** — email `citext` único, hash scrypt.
- **sessions** — apenas o SHA-256 do token; expiração deslizante.
- **conversations**, **messages** — `user_id` em ambas; `seq` para ordem estável; índice único parcial garante **uma geração em curso por conversa**.
- **files** — metadados; o conteúdo vive no armazenamento de objetos com chave gerada pelo servidor.
- **audit_log** — só inserções; sem palavras-passe, tokens nem conteúdo de mensagens.
- Pesquisa: `unaccent` + `pg_trgm` com índices GIN sobre uma função IMMUTABLE.

## 3. Fluxo de uma mensagem

1. O cliente gera os ids (UUID) da mensagem do utilizador e da resposta — repetir um pedido não duplica nada.
2. Numa transação: bloqueia a conversa, valida a posse dos anexos, grava a mensagem do utilizador e uma resposta `streaming`.
3. O histórico enviado ao modelo é **lido da base de dados** (nunca aceite do cliente), com o texto dos anexos lido do armazenamento.
4. Durante o streaming a resposta é gravada a cada 1,5 s; no fim fica `complete`, `cancelled` ou `error`. O evento final SSE só é enviado depois de gravado.
5. Se a instância cair, a manutenção (a cada minuto) marca como `cancelled` as gerações sem atualização há mais de 2 minutos.

## 4. Decisões (continuação dos ADR de `02-arquitetura.md`)

**ADR-0008 — Driver `pg` (node-postgres).** Na Fase 3 usou-se um cliente próprio temporário, porque o registo npm estava inacessível no ambiente de desenvolvimento. Foi substituído pelo `pg` assim que a CI no GitHub permitiu instalar e testar dependências; a interface `server/db/db.ts` manteve-se, por isso nenhum módulo mudou. Decisões explícitas: `sslmode` interpretado no código (`require` cifra; `verify-full` valida certificado e nome), `int8` devolvido como número quando seguro, parâmetros JSON sempre serializados como texto JSON, `statement_timeout` e fuso UTC por sessão.

**ADR-0009 — Sessões opacas em cookie, não JWT.** Revogação imediata (logout, "sair de todos os dispositivos" no futuro), token nunca acessível ao JavaScript (`HttpOnly`), `SameSite=Lax`, `Secure` e prefixo `__Host-` em produção. Só o hash do token é guardado. CSRF: verificação de `Origin` em todos os pedidos que alteram estado.

**ADR-0010 — scrypt para palavras-passe.** Nativo do Node (sem dependências), parâmetros OWASP (N=2¹⁷, r=8, p=1), formato versionado com re-hash automático no login quando os parâmetros sobem. Argon2id fica como melhoria quando houver pacotes.

**ADR-0011 — Armazenamento de objetos atrás de interface.** Implementação local em disco (escrita atómica, permissões 0600, chaves aleatórias, fora da raiz web). Em produção: S3 ou compatível com a mesma interface. Ficheiros classificados pelos bytes; SVG e HTML tratados como texto e servidos como download.

## 5. Segurança: o que está coberto por testes

- Isolamento entre utilizadores em todas as rotas (ver, alterar, apagar, enviar, regenerar, ler e reutilizar ficheiros, pesquisar, reutilizar ids).
- Sessão revogada deixa de funcionar; token não está em claro na base de dados.
- CSRF: origem estrangeira e ausência de origem recusadas.
- Limite de tentativas de login por conta.
- SQL injection (valores com aspas e `;` passados como parâmetros), curingas `%`/`_` literais na pesquisa.
- Path traversal nos estáticos; nomes de ficheiro hostis normalizados.
- XSS nas respostas (E2E no navegador).
- Auditoria sem dados sensíveis.

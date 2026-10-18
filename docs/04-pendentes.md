# Pendentes e limitações conhecidas

## Causadas pelo ambiente de desenvolvimento

Resolvido com a CI no GitHub Actions: driver `pg` oficial, `@types/react`, `package-lock.json` e `npm audit` (sem vulnerabilidades altas ou críticas). Restam:

| Item | Ação quando houver rede | Prioridade |
|---|---|---|
| scrypt em vez de argon2id | Opcional: argon2id quando houver pacote; o formato do hash já permite migração no login. | Baixa |
| `docker-compose.yml` não executado (sem daemon Docker) | Validar localmente; o cluster de `scripts/pg-local.sh` foi o usado nos testes. | Média |
| Licenças de vLLM, llama.cpp, Ollama, pgvector, LangGraph, Langfuse, gVisor, Firecracker [C] | Confirmar o `LICENSE` de cada repositório. | Antes da Fase 8 |

## Fase 3 — limitações aceites

1. **Sem verificação de email nem recuperação de palavra-passe.** Requer um serviço de envio de email. O registo revela se um email já existe (409); mitigado com limite por IP. Avaliar resposta genérica quando houver verificação por email.
2. **Sem eliminação de conta nem exportação de dados** (requisitos de RGPD/LGPD antes de abrir a utilizadores reais).
3. **Rate limiting em memória**: correto para uma instância; com várias, passar para Redis ou para a base de dados.
4. **Sem Row Level Security**: o isolamento é garantido na aplicação (todas as consultas filtram por `user_id`, com testes). RLS no PostgreSQL como segunda barreira está planeado.
5. **Armazenamento local em disco**: produção precisa de S3 ou compatível (implementar `ObjectStorage`), com cifra em repouso e cópias de segurança.
6. **Imagens e PDF** são guardados e mostrados, mas não interpretados pelo modelo (requer modelo multimodal — Fase 4). O fornecedor simulado diz isso explicitamente.
7. **Pesquisa** com `ILIKE` + trigramas: adequada até dezenas de milhares de mensagens por utilizador; pesquisa semântica com pgvector na Fase 4.
8. **Sessões**: sem lista de dispositivos nem "terminar todas as sessões" na interface (a tabela já o permite).

## Fase 4 — por fazer

1. **Imagens e PDF para modelos multimodais**: o catálogo ainda não declara capacidades de visão; hoje os anexos não textuais são assinalados ao modelo como "não incluídos".
2. **Raciocínio ("thinking")**: é filtrado e descartado. Falta decidir se se mostra ao utilizador (recolhido) e se se guarda.
3. **Contagem de tokens antes de enviar**: o corte do histórico usa uma estimativa (≈4 caracteres/token) com 10 % de margem; o valor real só se conhece na resposta.
4. **Conjunto de avaliação**: 6 casos; precisa de crescer com casos reais do produto (≥ 100) antes de decisões de troca de modelo.
5. ~~Ferramentas e agentes~~ — feito na Fase 5 (`docs/07-agentes.md`).
6. **Integração nativa da Anthropic** (formato próprio, não compatível com OpenAI): não implementada; opcional.
7. **Custos e quotas por utilizador** (tokens por dia) e limites de concorrência por servidor de modelos.

## Fase 5 — por fazer

1. **Interface web para agentes**: hoje só há CLI (`npm run agent`) e avaliação; falta UI com plano, ações e pedidos de confirmação em tempo real, e persistência das execuções.
2. **Sandbox forte**: o isolamento atual é de processo (sem isolamento do sistema de ficheiros nem limite de memória fiável). Produção multiutilizador exige microVM/contentor.
3. **Ações externas** (web, `git push`, instalação de dependências) não existem; exigirão confirmação e lista de destinos.
4. **Avaliação pequena**: 4 tarefas, só JavaScript/Node. Crescer em número, linguagens e dificuldade; repetir execuções para medir variância.
5. **Comandos por projeto**: só `test` deduzido do `package.json`; falta configuração explícita (build, lint, vários runners).
6. **Defesa contra injeção** é parcial (marcação + deteção heurística); a proteção real vem das barreiras que não dependem do modelo.
7. **Estimativa de tokens** no limite de contexto do agente continua aproximada.

## Próximas fases

1. Especialização (Etapa C): dados próprios, LoRA sobre um modelo de pesos abertos, avaliação comparativa — o primeiro passo para capacidades próprias.
2. Auditoria de acessibilidade com axe-core nos E2E; testes com leitores de ecrã.
3. Carregamento diferido do highlight.js (bundle atual: 389 KB minificado).
4. CI: typecheck, testes unitários, integração (com PostgreSQL de serviço), E2E, auditoria de dependências, ações fixadas por SHA.
5. Observabilidade: logs estruturados (JSON), métricas e traces OpenTelemetry.

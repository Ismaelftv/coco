# Forja

Plataforma de assistente de IA. **Estado atual: Fase 4.** Contas, histórico e ficheiros em PostgreSQL. A plataforma executa **modelos de pesos abertos na nossa própria infraestrutura**: Ollama para desenvolvimento, vLLM para escala. A troca de modelo faz-se por configuração, e as APIs comerciais são opcionais.

> Os modelos usados (ex.: Qwen3, da Alibaba, Apache 2.0) são de terceiros e não foram adaptados por nós. Ver o que é próprio e o que não é em [`docs/06-modelos.md`](docs/06-modelos.md).

## Começar

Requisitos: Node.js ≥ 22 e PostgreSQL 16.

```bash
npm install            # ver docs/04-pendentes.md se o registo npm não estiver acessível
npm run db:start       # cluster PostgreSQL local descartável (ou: docker compose up -d)
cp .env.example .env   # ajustar se necessário
npm run build
npm start              # http://127.0.0.1:5173 — as migrações correm no arranque
```

Sem `MODELS_CONFIG`, só o fornecedor simulado está disponível. Para usar um modelo local:

```bash
ollama pull qwen3:4b
cp config/models.example.json config/models.json
echo "MODELS_CONFIG=config/models.json" >> .env
```

Todas as variáveis de ambiente estão documentadas em [`.env.example`](.env.example) e são validadas no arranque; em produção são obrigatórias `PUBLIC_ORIGIN`, cookies `Secure` e `SCRYPT_LOG_N ≥ 17`.

## Verificar

```bash
npm run typecheck          # TypeScript estrito
npm test                   # unitários
npm run test:integration   # PostgreSQL real e servidor de modelos falso
npm run test:e2e           # E2E no Chromium contra a aplicação completa
npm run test:real-model    # com um Ollama real (OLLAMA_URL); corre na CI
npm run eval -- --config config/models.json --model qwen3-4b-local   # avaliação de um modelo
npm run check              # tudo
```

Os testes de integração e E2E criam e apagam uma base de dados própria em `TEST_DATABASE_URL` (por defeito, o cluster de `npm run db:start`).

## Documentação

- [`docs/01-investigacao.md`](docs/01-investigacao.md) — investigação técnica, fontes, licenças, riscos
- [`docs/02-arquitetura.md`](docs/02-arquitetura.md) — arquitetura, contrato de streaming, ADR 0001–0007, plano faseado
- [`docs/03-frontend.md`](docs/03-frontend.md) — estado real de cada funcionalidade, design system
- [`docs/04-pendentes.md`](docs/04-pendentes.md) — limitações conhecidas e próximos passos
- [`docs/05-api.md`](docs/05-api.md) — API, modelo de dados, segurança, ADR 0008–0011
- [`docs/06-modelos.md`](docs/06-modelos.md) — modelos locais, catálogo, hardware, avaliação, ADR 0012–0013
- [`docs/07-agentes.md`](docs/07-agentes.md) — ferramentas de programação, ciclo de agentes, sandbox, avaliação (Fase 5)
- [`docs/08-isolamento.md`](docs/08-isolamento.md) — garantias de isolamento verificadas (máquina local vs CI), sandbox em contentor, política de confiança

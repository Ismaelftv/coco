# Forja

Plataforma de assistente de IA. **Estado atual: Fase 3 concluída.** Contas de utilizador, histórico e ficheiros persistidos em PostgreSQL, API com streaming gravado no servidor. As respostas continuam a vir de um **fornecedor de modelos simulado** — ainda não há modelo de IA ligado (Fase 4).

## Começar

Requisitos: Node.js ≥ 22 e PostgreSQL 16.

```bash
npm install            # ver docs/04-pendentes.md se o registo npm não estiver acessível
npm run db:start       # cluster PostgreSQL local descartável (ou: docker compose up -d)
cp .env.example .env   # ajustar se necessário
npm run build
npm start              # http://127.0.0.1:5173 — as migrações correm no arranque
```

Todas as variáveis de ambiente estão documentadas em [`.env.example`](.env.example) e são validadas no arranque; em produção são obrigatórias `PUBLIC_ORIGIN`, cookies `Secure` e `SCRYPT_LOG_N ≥ 17`.

## Verificar

```bash
npm run typecheck          # TypeScript estrito
npm test                   # 33 testes unitários
npm run test:integration   # 29 testes contra PostgreSQL real (API, isolamento, cliente DB)
npm run test:e2e           # 12 testes no Chromium contra a aplicação completa
npm run check              # tudo
```

Os testes de integração e E2E criam e apagam uma base de dados própria em `TEST_DATABASE_URL` (por defeito, o cluster de `npm run db:start`).

## Documentação

- [`docs/01-investigacao.md`](docs/01-investigacao.md) — investigação técnica, fontes, licenças, riscos
- [`docs/02-arquitetura.md`](docs/02-arquitetura.md) — arquitetura, contrato de streaming, ADR 0001–0007, plano faseado
- [`docs/03-frontend.md`](docs/03-frontend.md) — estado real de cada funcionalidade, design system
- [`docs/04-pendentes.md`](docs/04-pendentes.md) — limitações conhecidas e próximos passos
- [`docs/05-api.md`](docs/05-api.md) — API, modelo de dados, segurança, ADR 0008–0011

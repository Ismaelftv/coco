# Forja

Plataforma de assistente de IA. **Estado atual: Fase 2** — interface de conversação funcional ligada a um servidor de desenvolvimento com um **fornecedor de modelos simulado**. Ainda não há modelo de IA, autenticação nem base de dados.

## Começar

Requisitos: Node.js ≥ 22.

```bash
npm install          # ver docs/04-pendentes.md se o registo npm não estiver acessível
npm run build        # gera dist/
npm start            # http://127.0.0.1:5173
npm run dev          # build em modo watch + servidor
```

Variáveis de ambiente (opcionais):

| Variável | Por defeito | Uso |
|---|---|---|
| `PORT` | `5173` | Porta do servidor |
| `HOST` | `127.0.0.1` | Interface de escuta |
| `MOCK_DELAY_MS` | `14` | Atraso entre fragmentos do fornecedor simulado |

Nenhum segredo é usado nesta fase. Chaves de fornecedores, quando existirem, vivem só no servidor.

## Verificar

```bash
npm run typecheck    # TypeScript estrito
npm test             # 32 testes unitários e de integração (node:test)
npm run test:e2e     # 11 testes E2E no Chromium (Playwright)
npm run check        # tudo
```

## Documentação

- [`docs/01-investigacao.md`](docs/01-investigacao.md) — investigação técnica, fontes, licenças, riscos
- [`docs/02-arquitetura.md`](docs/02-arquitetura.md) — arquitetura, contrato da API, ADRs, plano faseado
- [`docs/03-frontend.md`](docs/03-frontend.md) — estado real de cada funcionalidade, design system
- [`docs/04-pendentes.md`](docs/04-pendentes.md) — limitações conhecidas e próximos passos

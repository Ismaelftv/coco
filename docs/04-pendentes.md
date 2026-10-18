# Pendentes e limitações conhecidas

## Causadas pelo ambiente desta sessão (registos npm/PyPI e GitHub inacessíveis)

| Item | Ação quando houver rede |
|---|---|
| `@types/react` e `@types/react-dom` não instalados; existe `apps/web/src/types/react-shim.d.ts` | `npm i -D @types/react @types/react-dom`, apagar o shim, correr `npm run typecheck`. |
| Sem `package-lock.json`; dependências ligadas a uma cópia local do sistema | `npm install` para gerar o lockfile com as versões exatas fixadas em `package.json`. |
| `npm audit` não executado (requer lockfile e registo) | Executar e adicionar ao CI. |
| Licenças de vLLM, llama.cpp, Ollama, pgvector, LangGraph, Langfuse, gVisor, Firecracker baseadas em conhecimento prévio [C] | Confirmar o ficheiro `LICENSE` de cada repositório e registar a versão avaliada. |
| Sem Vitest nem Testing Library; testes com `node:test` + Playwright | Suficiente para agora; reavaliar quando houver testes de componentes isolados. |
| Tailwind não utilizado (CLI indisponível) | Decisão deliberada (ADR-0006); reavaliar só se acelerar a equipa. |

## Funcionais (próximas fases)

1. **Fase 3:** API com autenticação, Postgres, conversas por utilizador, upload de ficheiros para armazenamento de objetos, migração do `localStorage` (importação única).
2. **Fase 4:** fornecedores reais por trás de `ModelProvider` (Anthropic, OpenAI, compatível com OpenAI), tokenizador real, contabilização de custos, conjunto de avaliação.
3. Auditoria de acessibilidade com axe-core nos testes E2E; testes com NVDA/VoiceOver.
4. Carregamento diferido do highlight.js (≈73 KB minificado) para reduzir o bundle inicial (373 KB minificado, 122 KB gzip).
5. Virtualização da lista de mensagens para conversas muito longas.
6. Internacionalização (strings estão em português europeu, centralizáveis).
7. CI: typecheck, testes unitários, E2E, auditoria de dependências, ações fixadas por SHA.

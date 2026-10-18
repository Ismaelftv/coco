# Frontend — estado, design system e decisões

Estado: Fase 2, primeira versão · 18 de outubro de 2026

## 1. Estado real das funcionalidades

| Funcionalidade | Estado | Notas |
|---|---|---|
| Barra lateral (expandir/recolher; gaveta em telemóvel com foco gerido e Escape) | **Implementado** | Testado E2E em 1360 px e 390 px. |
| Nova conversa, histórico agrupado por data | **Implementado** | |
| Pesquisa no histórico (título e conteúdo, ignora acentos) | **Implementado** | Local, no navegador. |
| Mudar o nome / eliminar conversa (com confirmação) | **Implementado** | |
| Persistência do histórico | **Implementado — temporário** | `localStorage` atrás da interface `ConversationRepository`; passa para a API na Fase 3. |
| Composer multilinha (Enter envia, Shift+Enter nova linha, IME seguro) | **Implementado** | Altura automática até 40 % da janela; contador perto do limite. |
| Enviar / Parar geração | **Implementado** | Cancelamento real: `AbortController` → servidor deteta o fecho e para o fornecedor. |
| Streaming progressivo (SSE sobre `fetch`) | **Implementado** | Contrato definitivo (`docs/02-arquitetura.md` §4); fragmentos agrupados por frame de animação. |
| Markdown (títulos, listas, tarefas, tabelas, citações, ligações) | **Implementado** | Renderização para React sem `innerHTML` (ADR-0005). Testado contra XSS. |
| Blocos de código com realce e botão Copiar | **Implementado** | highlight.js com 13 linguagens registadas. |
| Copiar mensagem, regenerar última resposta | **Implementado** | |
| Erros com Repetir | **Implementado** | Erros HTTP, de rede, de stream interrompido e do fornecedor. |
| Anexos de texto (seletor, arrastar, colar) com estados de leitura e rejeição | **Implementado** | Lidos no navegador e enviados no pedido; o servidor valida de novo. |
| Anexos de imagem/binários | **Pendente (Fase 3)** | Rejeitados com mensagem explícita. Precisam de armazenamento de objetos. |
| Seletor de modelo | **Implementado** | Lista vinda de `GET /api/models` com estados `simulado` / `requer integração`. |
| Respostas do modelo | **Simulado** | Fornecedor `forja-sim` sem IA. Indicado no topo, no seletor, no rodapé e no próprio texto. |
| Tema claro/escuro/sistema | **Implementado** | Persistido; o modo sistema segue `prefers-color-scheme`. |
| Projetos, Definições | **Pendente** | Visíveis como desativados com etiqueta “Pendente”. |
| Contagem de tokens | **Estimativa** | ≈4 caracteres/token, marcada como estimativa na interface. |

## 2. Design system

Identidade: **Forja** — grafite quente com acento verdete (cobre oxidado) e âmbar para atenção. O símbolo é um “F” com terminais oblíquos, desenhado de raiz.

| Categoria | Decisão |
|---|---|
| Tipografia | Sans do sistema para interface (sem descarregar fontes: privacidade e desempenho); serifada de livro para títulos de marca e de secção; mono do sistema para código. Escala 12/13/14/16/20/24/34 px. Leitura a 16 px com entrelinha 1,68. |
| Espaço | Base de 4 px (`--space-1` a `--space-12`). Coluna de leitura de 46 rem. |
| Forma | Raios 6/10/14/20 px; bolha do utilizador com canto “de origem” mais fechado. |
| Elevação | Três sombras (`sm`, `md`, `lg`), mais fortes no tema escuro. |
| Movimento | 120/180/260 ms com `cubic-bezier(.2,.8,.2,1)`; anulado com `prefers-reduced-motion`. |
| Cor | Todos os valores em `apps/web/src/styles/tokens.css`. Nenhum componente usa cores literais. |
| Contraste | Verificado por script (fórmula WCAG 2.x) para 22 pares texto/fundo: mínimo 4,73:1 no tema claro e 5,43:1 no escuro. |

Os tokens são variáveis CSS e podem ser expostos ao Tailwind v4 via `@theme` sem mudar a marcação dos componentes (ADR-0006).

## 3. Estrutura

```
apps/web/
  index.html                 modelo; o build injeta CSS/JS com hash
  public/favicon.svg
  src/
    main.tsx                 arranque, tema, repositório
    app/App.tsx              layout e responsividade
    components/              UI reutilizável (Sidebar, Composer, ModelPicker, MessageList,
                             MessageView, Markdown, CodeBlock, CopyButton, EmptyState, Icon)
    features/chat/           domínio: tipos, reducer puro, repositório, cliente da API, hook useChat
    features/theme/          preferência de tema
    lib/                     SSE, URLs seguras, anexos, datas, realce, media queries
    styles/                  tokens, base, componentes, markdown
    types/                   declarações temporárias (ver 04-pendentes.md)
server/                      servidor de desenvolvimento + fornecedor simulado
shared/                      contrato e limites partilhados
tests/unit, tests/e2e
```

## 4. Acessibilidade aplicada

- Ligação “Saltar para a caixa de mensagem”; foco visível consistente.
- Rótulos acessíveis em todos os botões de ícone; o seletor de modelo segue o padrão listbox (setas, Home/End, Enter, Escape).
- `role="log"` na conversa; `aria-busy` durante a geração; erros com `role="alert"`; confirmação de eliminação como `alertdialog`.
- Gaveta móvel: conteúdo principal `inert`, foco entra na gaveta e volta ao botão.
- Tabelas e blocos de código roláveis por teclado (`tabIndex=0`).

**Não verificado ainda:** auditoria automática com axe-core e testes com leitores de ecrã reais (ver pendentes).

## 5. Comandos do fornecedor simulado

Escrever na mensagem: `#lento` (streaming lento para testar Parar), `#erro` (falha a meio). Pedir “código” ou “tabela” mostra os respetivos exemplos.

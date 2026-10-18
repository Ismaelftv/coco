import { Icon, Logo, type IconName } from './Icon.tsx';

type Suggestion = { icon: IconName; title: string; prompt: string };

const COMMON: Suggestion[] = [
  { icon: 'edit', title: 'Escrever código', prompt: 'Escreve uma função TypeScript que marque uma tarefa como concluída.' },
  { icon: 'sidebar', title: 'Comparar opções', prompt: 'Faz uma tabela a comparar SSE, WebSockets e HTTP simples.' },
];

/** Comandos que só o fornecedor simulado entende. */
const SIMULATOR: Suggestion[] = [
  { icon: 'stop', title: 'Testar o botão Parar', prompt: 'Resposta longa para testar a interrupção #lento' },
  { icon: 'alert', title: 'Testar uma falha', prompt: 'Simula uma falha do fornecedor #erro' },
];

const MODEL: Suggestion[] = [
  { icon: 'search', title: 'Explicar um conceito', prompt: 'Explica de forma simples o que é uma base de dados vetorial e quando faz sentido usar uma.' },
  { icon: 'refresh', title: 'Rever um texto', prompt: 'Revê este parágrafo e sugere uma versão mais clara: ' },
];

export function EmptyState({ onPick, disabled, simulated }: { onPick(prompt: string): void; disabled: boolean; simulated: boolean }) {
  const suggestions = [...COMMON, ...(simulated ? SIMULATOR : MODEL)];
  return (
    <div className="empty">
      <div className="empty__mark" aria-hidden="true">
        <Logo size={52} />
      </div>
      <h1 className="empty__title">Em que vamos trabalhar?</h1>
      <p className="empty__lead">
        {simulated ? (
          <>
            Estás a usar o <strong>fornecedor simulado</strong>: as respostas são fixas e servem para testar a interface.
          </>
        ) : (
          'As tuas conversas ficam guardadas na tua conta. Podes trocar de modelo na caixa de mensagem.'
        )}
      </p>
      <ul className="suggestions">
        {suggestions.map((s) => (
          <li key={s.title}>
            <button type="button" className="suggestion" onClick={() => onPick(s.prompt)} disabled={disabled}>
              <Icon name={s.icon} size={16} />
              <span className="suggestion__title">{s.title}</span>
              <span className="suggestion__prompt">{s.prompt}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

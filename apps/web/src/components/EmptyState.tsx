import { Icon, Logo, type IconName } from './Icon.tsx';

const SUGGESTIONS: { icon: IconName; title: string; prompt: string }[] = [
  { icon: 'edit', title: 'Escrever código', prompt: 'Escreve uma função TypeScript que marque uma tarefa como concluída.' },
  { icon: 'sidebar', title: 'Comparar opções', prompt: 'Faz uma tabela a comparar SSE, WebSockets e HTTP simples.' },
  { icon: 'stop', title: 'Testar o botão Parar', prompt: 'Resposta longa para testar a interrupção #lento' },
  { icon: 'alert', title: 'Testar uma falha', prompt: 'Simula uma falha do fornecedor #erro' },
];

export function EmptyState({ onPick, disabled }: { onPick(prompt: string): void; disabled: boolean }) {
  return (
    <div className="empty">
      <div className="empty__mark" aria-hidden="true">
        <Logo size={52} />
      </div>
      <h1 className="empty__title">Em que vamos trabalhar?</h1>
      <p className="empty__lead">
        Esta é a fundação da interface da Forja. As respostas vêm de um <strong>fornecedor simulado</strong> até um
        modelo real ser integrado no backend.
      </p>
      <ul className="suggestions">
        {SUGGESTIONS.map((s) => (
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

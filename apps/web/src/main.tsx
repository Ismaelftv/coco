import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App.tsx';
import { browserStorage, createLocalRepository } from './features/chat/repository.ts';
import { applyStoredTheme } from './features/theme/useTheme.ts';
import './styles/tokens.css';
import './styles/base.css';
import './styles/app.css';
import './styles/markdown.css';

applyStoredTheme();

const container = document.getElementById('root');
if (!container) throw new Error('Elemento #root em falta em index.html');

const repository = createLocalRepository(browserStorage());

createRoot(container).render(
  <StrictMode>
    <App repository={repository} />
  </StrictMode>,
);

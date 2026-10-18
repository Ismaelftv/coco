import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Root } from './app/App.tsx';
import { applyStoredTheme } from './features/theme/useTheme.ts';
import './styles/tokens.css';
import './styles/base.css';
import './styles/app.css';
import './styles/auth.css';
import './styles/markdown.css';

applyStoredTheme();

const container = document.getElementById('root');
if (!container) throw new Error('Elemento #root em falta em index.html');

createRoot(container).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);

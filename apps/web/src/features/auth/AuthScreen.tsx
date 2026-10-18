import { useId, useState, type FormEvent } from 'react';
import { LIMITS } from '../../../../../shared/limits.ts';
import { Icon, Logo } from '../../components/Icon.tsx';

interface Props {
  signupEnabled: boolean;
  expired: boolean;
  onLogin(email: string, password: string): Promise<void>;
  onSignup(email: string, password: string, displayName?: string): Promise<void>;
}

type Mode = 'login' | 'signup';

export function AuthScreen({ signupEnabled, expired, onLogin, onSignup }: Props) {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = { email: useId(), password: useId(), name: useId(), hint: useId(), error: useId() };

  const tooShort = mode === 'signup' && password.length > 0 && password.length < LIMITS.passwordMin;

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      if (mode === 'login') await onLogin(email, password);
      else await onSignup(email, password, name.trim() || undefined);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
  };

  return (
    <main className="auth">
      <div className="auth__panel">
        <div className="auth__brand">
          <Logo size={40} />
          <span className="brand__name">Forja</span>
        </div>
        <h1 className="auth__title">{mode === 'login' ? 'Entrar na tua conta' : 'Criar conta'}</h1>
        <p className="auth__lead">
          {mode === 'login'
            ? 'As tuas conversas e ficheiros ficam guardados na tua conta.'
            : 'Só precisas de um email e de uma palavra-passe longa.'}
        </p>

        {expired ? (
          <p className="auth__notice" role="status">
            A tua sessão terminou. Entra de novo para continuar.
          </p>
        ) : null}

        <form className="auth__form" onSubmit={submit} noValidate>
          {mode === 'signup' ? (
            <div className="field">
              <label htmlFor={ids.name}>Nome (opcional)</label>
              <input id={ids.name} className="input" autoComplete="name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
          ) : null}
          <div className="field">
            <label htmlFor={ids.email}>Email</label>
            <input
              id={ids.email}
              className="input"
              type="email"
              autoComplete="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-describedby={error ? ids.error : undefined}
            />
          </div>
          <div className="field">
            <label htmlFor={ids.password}>Palavra-passe</label>
            <div className="input-wrap">
              <input
                id={ids.password}
                className="input"
                type={showPassword ? 'text' : 'password'}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                required
                minLength={mode === 'signup' ? LIMITS.passwordMin : undefined}
                maxLength={LIMITS.passwordMax}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-describedby={mode === 'signup' ? ids.hint : undefined}
                aria-invalid={tooShort}
              />
              <button
                type="button"
                className="input-wrap__toggle"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Esconder palavra-passe' : 'Mostrar palavra-passe'}
                aria-pressed={showPassword}
              >
                {showPassword ? 'Esconder' : 'Mostrar'}
              </button>
            </div>
            {mode === 'signup' ? (
              <p id={ids.hint} className={tooShort ? 'field__hint is-invalid' : 'field__hint'}>
                Pelo menos {LIMITS.passwordMin} caracteres. Uma frase é mais segura e fácil de lembrar.
              </p>
            ) : null}
          </div>

          {error ? (
            <p id={ids.error} className="auth__error" role="alert">
              <Icon name="alert" size={16} /> {error}
            </p>
          ) : null}

          <button type="submit" className="btn btn--primary btn--block btn--lg" disabled={busy || !email || !password || tooShort}>
            {busy ? 'Aguarda…' : mode === 'login' ? 'Entrar' : 'Criar conta'}
          </button>
        </form>

        {signupEnabled ? (
          <p className="auth__switch">
            {mode === 'login' ? 'Ainda não tens conta?' : 'Já tens conta?'}{' '}
            <button type="button" className="link-btn" onClick={() => switchMode(mode === 'login' ? 'signup' : 'login')}>
              {mode === 'login' ? 'Criar conta' : 'Entrar'}
            </button>
          </p>
        ) : null}
      </div>
      <p className="auth__footnote">Versão de desenvolvimento · respostas simuladas, sem modelo de IA ligado.</p>
    </main>
  );
}

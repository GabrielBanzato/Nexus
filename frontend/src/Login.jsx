import { useState } from 'react';
import { Eye, EyeOff, LoaderCircle, LockKeyhole, Radar, TriangleAlert } from 'lucide-react';
import { login } from './lib/api.js';

/**
 * Tela de login do Nexus.
 * @param {{ onSuccess: (token: string) => void, notice?: string | null }} props
 */
export default function Login({ onSuccess, notice }) {
  const [senha, setSenha] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!senha) {
      setError('Digite a senha de acesso.');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const { token } = await login(senha);
      onSuccess(token);
    } catch (err) {
      setError(err.message);
      setSenha('');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#111111] bg-[radial-gradient(ellipse_70%_50%_at_50%_0%,rgba(127,29,29,0.25),transparent)] px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="flex size-14 items-center justify-center rounded-2xl bg-linear-to-br from-red-700 to-red-950 text-white shadow-xl shadow-red-950/60 ring-1 ring-red-600/30">
            <Radar className="size-7" />
          </div>
          <h1 className="mt-4 text-2xl font-bold tracking-tight text-white">
            Nexus<span className="text-red-600">.</span>
          </h1>
          <p className="mt-1 text-sm text-neutral-500">Radar de Prospecção</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="rounded-2xl border border-neutral-800 bg-[#1a1a1a] p-6 shadow-2xl shadow-black/50"
        >
          {notice && (
            <p className="mb-4 rounded-xl border border-amber-900/50 bg-amber-950/30 px-3 py-2.5 text-sm text-amber-300">
              {notice}
            </p>
          )}

          <label htmlFor="senha" className="text-sm font-medium text-neutral-300">
            Senha de acesso
          </label>
          <div className="relative mt-2">
            <LockKeyhole className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-neutral-500" />
            <input
              id="senha"
              type={showPassword ? 'text' : 'password'}
              value={senha}
              onChange={(e) => setSenha(e.target.value)}
              autoComplete="current-password"
              autoFocus
              disabled={loading}
              placeholder="••••••••"
              aria-invalid={Boolean(error)}
              aria-describedby={error ? 'login-error' : undefined}
              className="h-11 w-full rounded-xl border border-neutral-800 bg-[#141414] pr-11 pl-10 text-sm text-neutral-100 placeholder:text-neutral-600 transition outline-none focus:border-red-700 focus:ring-4 focus:ring-red-900/30 disabled:opacity-60"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
              className="absolute top-1/2 right-2 flex size-8 -translate-y-1/2 items-center justify-center rounded-lg text-neutral-500 transition hover:bg-neutral-800 hover:text-neutral-200"
            >
              {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>

          {error && (
            <p id="login-error" role="alert" className="mt-3 flex items-center gap-2 text-sm text-red-400">
              <TriangleAlert className="size-4 shrink-0" />
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="mt-5 inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-red-800 text-sm font-semibold text-white shadow-lg shadow-red-950/50 ring-1 ring-red-600/30 transition hover:bg-red-700 active:scale-[0.99] disabled:cursor-not-allowed disabled:bg-red-900/60"
          >
            {loading ? (
              <>
                <LoaderCircle className="size-4 animate-spin" />
                Verificando...
              </>
            ) : (
              'Entrar no Nexus'
            )}
          </button>
        </form>

        <p className="mt-6 text-center text-xs text-neutral-600">Acesso restrito à equipe comercial.</p>
      </div>
    </div>
  );
}

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { CircleCheck, CircleX, Info, X } from 'lucide-react';

const ToastContext = createContext(null);

const TONES = {
  success: { icon: CircleCheck, className: 'text-emerald-400' },
  error: { icon: CircleX, className: 'text-red-400' },
  info: { icon: Info, className: 'text-sky-400' },
};

/**
 * Notificações globais. Uso: const toast = useToast(); toast.success('Guardado!');
 * Com ação: toast.success('Arquivado', 'Lead X', { action: { label: 'Desfazer', onClick } }).
 */
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id) => setToasts((list) => list.filter((t) => t.id !== id)), []);

  const push = useCallback(
    (type, title, message, { duration = 5000, action } = {}) => {
      const id = ++nextId.current;
      setToasts((list) => [...list.slice(-3), { id, type, title, message, action }]);
      // Com ação (ex.: "Desfazer"), dá mais tempo para o utilizador reagir.
      setTimeout(() => dismiss(id), action ? Math.max(duration, 8000) : duration);
    },
    [dismiss],
  );

  const api = useMemo(
    () => ({
      success: (title, message, options) => push('success', title, message, options),
      error: (title, message, options) => push('error', title, message, { duration: 8000, ...options }),
      info: (title, message, options) => push('info', title, message, options),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-4 bottom-4 z-[60] flex flex-col gap-2 sm:inset-x-auto sm:right-6 sm:bottom-6 sm:w-96"
      >
        {toasts.map((toast) => {
          const { icon: Icon, className } = TONES[toast.type];
          return (
            <div
              key={toast.id}
              role="status"
              className="pointer-events-auto flex items-start gap-3 rounded-2xl border border-neutral-800 bg-[#1a1a1a]/95 p-4 shadow-2xl shadow-black/60 backdrop-blur"
            >
              <Icon className={`mt-0.5 size-5 shrink-0 ${className}`} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-white">{toast.title}</p>
                {toast.message && <p className="mt-0.5 text-sm break-words text-neutral-400">{toast.message}</p>}
                {toast.action && (
                  <button
                    type="button"
                    onClick={() => {
                      dismiss(toast.id);
                      toast.action.onClick();
                    }}
                    className="mt-2 rounded-lg text-sm font-semibold text-red-400 transition hover:text-red-300"
                  >
                    {toast.action.label}
                  </button>
                )}
              </div>
              <button
                type="button"
                onClick={() => dismiss(toast.id)}
                aria-label="Fechar notificação"
                className="-m-1 rounded-lg p-1 text-neutral-500 transition hover:bg-neutral-800 hover:text-white"
              >
                <X className="size-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast deve ser usado dentro de <ToastProvider>.');
  return context;
}

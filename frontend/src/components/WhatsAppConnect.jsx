import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, LoaderCircle, LogOut, QrCode, Smartphone, WifiOff } from 'lucide-react';
import { getWhatsAppQr, getWhatsAppStatus, logoutWhatsApp } from '../lib/api.js';
import { formatRelative } from '../lib/labels.js';
import { useSocketEvent } from '../lib/socket.js';
import { useToast } from './toast.jsx';
import { Badge, Button, ConfirmDialog, Modal, cx } from './ui.jsx';

/** Estados da sessão (ver backend: services/whatsappClient.js) → rótulo e cor. */
export const WHATSAPP_STATUS_META = {
  ready: { label: 'WhatsApp conectado', short: 'Conectado', tone: 'emerald' },
  qr: { label: 'Aguardando leitura do QR Code', short: 'Aguardando QR', tone: 'amber' },
  initializing: { label: 'WhatsApp a iniciar', short: 'A iniciar', tone: 'sky' },
  authenticated: { label: 'WhatsApp a sincronizar', short: 'A sincronizar', tone: 'sky' },
  disconnected: { label: 'WhatsApp desconectado', short: 'Desconectado', tone: 'red' },
  auth_failure: { label: 'Falha ao autenticar o WhatsApp', short: 'Falha', tone: 'red' },
  error: { label: 'Erro no WhatsApp', short: 'Erro', tone: 'red' },
  idle: { label: 'WhatsApp parado', short: 'Parado', tone: 'neutral' },
  disabled: { label: 'Integração desligada', short: 'Desligado', tone: 'neutral' },
};

export function WhatsAppStatusPill({ status, onClick, compact = false }) {
  const meta = WHATSAPP_STATUS_META[status] ?? WHATSAPP_STATUS_META.disabled;
  const pill = <Badge tone={meta.tone} dot>{compact ? meta.short : meta.label}</Badge>;
  if (!onClick) return pill;
  return (
    <button type="button" onClick={onClick} title="Gerir a ligação do WhatsApp" className="rounded-full transition hover:brightness-125">
      {pill}
    </button>
  );
}

const STATUS_KEY = ['whatsapp', 'status'];
const QR_KEY = ['whatsapp', 'qr'];
const QR_FALLBACK_POLL_MS = 15_000;

/**
 * Estado da sessão para o admin: /status + /qr, atualizados em tempo real pelo evento
 * `whatsapp:state` (só chega à sala dos admins). O polling de 15s é só rede de segurança
 * para quando o tempo real estiver em baixo.
 */
export function useWhatsAppAdminState({ enabled = true } = {}) {
  const queryClient = useQueryClient();

  const status = useQuery({ queryKey: STATUS_KEY, queryFn: getWhatsAppStatus, enabled, retry: false });
  const current = status.data?.status;
  const qr = useQuery({
    queryKey: QR_KEY,
    queryFn: getWhatsAppQr,
    enabled: enabled && current === 'qr',
    refetchInterval: current === 'qr' ? QR_FALLBACK_POLL_MS : false,
  });

  useSocketEvent('whatsapp:state', (state) => {
    const { qr: qrImage, ...rest } = state;
    queryClient.setQueryData(STATUS_KEY, (old) => ({ ...old, ...rest, has_qr: Boolean(qrImage), enabled: true }));
    queryClient.setQueryData(QR_KEY, { status: state.status, qr: qrImage, qr_updated_at: state.qr_updated_at });
  });

  const disabled = status.error?.body?.code === 'WHATSAPP_DISABLED';
  return {
    status: disabled ? 'disabled' : current,
    state: status.data,
    qr: current === 'qr' ? qr.data : null,
    isLoading: status.isLoading,
    error: disabled ? null : status.error,
  };
}

function formatPhone(digits) {
  if (!digits) return '';
  const m = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(digits);
  return m ? `+55 (${m[1]}) ${m[2]}-${m[3]}` : `+${digits}`;
}

function CenteredState({ icon: Icon, tone = 'neutral', spin = false, title, children }) {
  const tones = { neutral: 'text-neutral-400 bg-neutral-800/60', emerald: 'text-emerald-300 bg-emerald-500/10', amber: 'text-amber-300 bg-amber-500/10', red: 'text-red-300 bg-red-500/10', sky: 'text-sky-300 bg-sky-500/10' };
  return (
    <div className="flex flex-col items-center py-6 text-center">
      <span className={cx('flex size-14 items-center justify-center rounded-2xl', tones[tone])}>
        <Icon className={cx('size-7', spin && 'animate-spin')} />
      </span>
      <p className="mt-4 font-semibold text-white">{title}</p>
      {children && <div className="mt-1.5 max-w-sm text-sm text-neutral-400">{children}</div>}
    </div>
  );
}

/**
 * Painel de ligação do WhatsApp da empresa (admin): mostra o QR Code para ler com o
 * telemóvel e, depois de ligado, o número e a opção de desligar.
 */
export function WhatsAppConnectModal({ open, onClose }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { status, state, qr, isLoading, error } = useWhatsAppAdminState({ enabled: open });
  const [confirmLogout, setConfirmLogout] = useState(false);

  const logout = useMutation({
    mutationFn: logoutWhatsApp,
    onSuccess: (next) => {
      queryClient.setQueryData(STATUS_KEY, (old) => ({ ...old, ...next, has_qr: false }));
      setConfirmLogout(false);
      toast.success('Número desconectado', 'Um novo QR Code vai aparecer em instantes.');
    },
    onError: (err) => toast.error('Não foi possível desconectar', err.message),
  });

  let body;
  if (isLoading) {
    body = <CenteredState icon={LoaderCircle} spin title="A consultar o WhatsApp..." />;
  } else if (error) {
    body = <CenteredState icon={CircleAlert} tone="red" title="Não foi possível consultar o WhatsApp">{error.message}</CenteredState>;
  } else if (status === 'disabled') {
    body = (
      <CenteredState icon={WifiOff} title="Integração desligada no servidor">
        Defina <code className="rounded bg-neutral-800 px-1 py-0.5 text-xs text-neutral-200">WHATSAPP_ENABLED=true</code> no
        backend e reinicie-o para ligar o WhatsApp.
      </CenteredState>
    );
  } else if (status === 'qr') {
    body = (
      <div className="grid items-center gap-6 sm:grid-cols-[auto_1fr]">
        <div className="mx-auto flex size-64 items-center justify-center rounded-2xl bg-white p-3 shadow-2xl shadow-red-950/40 ring-4 ring-red-900/30">
          {qr?.qr ? (
            // Fundo branco: os leitores de QR precisam de contraste (não inverter no tema escuro).
            <img src={qr.qr} alt="QR Code para ligar o WhatsApp da empresa" className="size-full [image-rendering:pixelated]" />
          ) : (
            <LoaderCircle className="size-8 animate-spin text-neutral-400" />
          )}
        </div>
        <div>
          <ol className="space-y-3 text-sm text-neutral-300">
            {[
              'Abra o WhatsApp no telemóvel da empresa.',
              'Toque em ⋮ (Android) ou Definições (iPhone) e depois em Aparelhos conectados.',
              'Toque em Conectar um aparelho e aponte a câmara para este código.',
            ].map((step, i) => (
              <li key={step} className="flex gap-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-red-950/70 text-xs font-bold text-red-300 ring-1 ring-red-900">{i + 1}</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
          <p className="mt-4 text-xs text-neutral-500">
            O código renova-se sozinho a cada ~20 segundos{qr?.qr_updated_at ? ` · atualizado ${formatRelative(qr.qr_updated_at)}` : ''}.
          </p>
        </div>
      </div>
    );
  } else if (status === 'ready') {
    body = (
      <CenteredState icon={Smartphone} tone="emerald" title="WhatsApp conectado">
        <p className="text-base font-semibold text-emerald-300 tabular-nums">{formatPhone(state?.phone)}</p>
        <p className="mt-1">As mensagens deste número chegam à Central de Atendimento em tempo real.</p>
      </CenteredState>
    );
  } else if (status === 'initializing' || status === 'authenticated') {
    body = (
      <CenteredState icon={LoaderCircle} tone="sky" spin title={status === 'authenticated' ? 'QR lido! A sincronizar as conversas...' : 'A iniciar o WhatsApp...'}>
        {status === 'initializing' && 'O navegador do servidor está a abrir o WhatsApp Web; o QR Code aparece em alguns segundos.'}
      </CenteredState>
    );
  } else {
    body = (
      <CenteredState icon={CircleAlert} tone="amber" title={WHATSAPP_STATUS_META[status]?.label ?? 'WhatsApp indisponível'}>
        {state?.error && <p className="break-words">{state.error}</p>}
        {!String(state?.error ?? '').startsWith('Pasta da sessão') && <p className="mt-1">O servidor está a tentar religar automaticamente.</p>}
      </CenteredState>
    );
  }

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        size="lg"
        title={
          <span className="flex items-center gap-2">
            <QrCode className="size-5 text-red-500" />
            WhatsApp da empresa
          </span>
        }
        description="Ligue o número que a equipe usa para atender os clientes."
        footer={
          <>
            {status === 'ready' && (
              <Button variant="danger" icon={LogOut} onClick={() => setConfirmLogout(true)} className="mr-auto">
                Desconectar número
              </Button>
            )}
            <Button variant="ghost" onClick={onClose}>Fechar</Button>
          </>
        }
      >
        <div className="flex justify-center pb-4">
          <WhatsAppStatusPill status={status ?? 'initializing'} />
        </div>
        {body}
      </Modal>

      <ConfirmDialog
        open={confirmLogout}
        title="Desconectar o número?"
        description="A Central de Atendimento deixa de receber e enviar mensagens até alguém ler um novo QR Code."
        confirmLabel="Desconectar"
        loading={logout.isPending}
        onConfirm={() => logout.mutate()}
        onClose={() => setConfirmLogout(false)}
      />
    </>
  );
}

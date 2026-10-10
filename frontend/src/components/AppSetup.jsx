import { useEffect, useState } from 'react';
import { Bell, BellOff, CheckCircle2, Download, Share, Smartphone, SquarePlus, X } from 'lucide-react';
import { disablePush, enablePush, resubscribePush, sendTestPush, useInstallState, usePushState } from '../lib/pwa.js';
import { useToast } from './toast.jsx';
import { Button, IconButton, Modal, cx } from './ui.jsx';

/**
 * "App e notificações": instalar o Nexus no telemóvel/computador (PWA) e ligar as notificações
 * deste aparelho. Aberto pelo botão da barra lateral (desktop) ou do topo (telemóvel).
 */

const DISMISS_KEY = 'nexus:installBannerDismissed';

function Step({ n, children }) {
  return (
    <li className="flex items-start gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-red-950/70 text-xs font-bold text-red-200 ring-1 ring-red-800/60">{n}</span>
      <span className="pt-0.5 text-sm text-neutral-300">{children}</span>
    </li>
  );
}

function Section({ icon: Icon, title, children }) {
  return (
    <section className="rounded-2xl bg-[#141414] p-4 ring-1 ring-neutral-800">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-white">
        <Icon className="size-4 text-red-500" />
        {title}
      </h3>
      {children}
    </section>
  );
}

function InstallSection({ install }) {
  const toast = useToast();
  if (install.installed) {
    return (
      <p className="flex items-center gap-2 text-sm text-emerald-300">
        <CheckCircle2 className="size-4" /> Você está usando o app instalado.
      </p>
    );
  }
  if (install.canPrompt) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-neutral-400">Fica com ícone na tela inicial e abre em tela cheia, como qualquer app.</p>
        <Button
          icon={Download}
          onClick={async () => {
            if (await install.install()) toast.success('Nexus instalado', 'Abra pelo ícone na tela inicial.');
          }}
        >
          Instalar o Nexus
        </Button>
      </div>
    );
  }
  if (install.ios) {
    return (
      <ol className="space-y-2.5">
        <Step n={1}>
          Abra o Nexus no <strong className="text-white">Safari</strong> e toque em <Share className="inline size-4 -translate-y-0.5 text-sky-400" aria-label="Compartilhar" />{' '}
          <strong className="text-white">Compartilhar</strong> (embaixo, no centro).
        </Step>
        <Step n={2}>
          Role para baixo e toque em <SquarePlus className="inline size-4 -translate-y-0.5" aria-hidden="true" /> <strong className="text-white">Adicionar à Tela de Início</strong>.
        </Step>
        <Step n={3}>
          Toque em <strong className="text-white">Adicionar</strong> e abra o Nexus pelo ícone novo.
        </Step>
      </ol>
    );
  }
  return (
    <p className="text-sm text-neutral-400">
      No celular Android, abra o Nexus no <strong className="text-neutral-200">Chrome</strong>: menu <strong className="text-neutral-200">⋮</strong> →{' '}
      <strong className="text-neutral-200">Instalar app</strong>. No computador, use o Chrome ou o Edge (ícone de instalar na barra de endereço).
    </p>
  );
}

function PushSection({ push, refresh, install }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const run = async (fn) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      toast.error('Não foi possível concluir', err.message);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const turnOn = () =>
    run(async () => {
      const result = await enablePush();
      if (result === 'enabled') {
        toast.success('Notificações ativadas', 'Vamos enviar uma de teste para confirmar.');
        await sendTestPush().catch(() => {});
      } else if (result === 'denied') toast.error('Permissão recusada', 'Para ativar depois, libere as notificações do Nexus nas configurações do navegador.');
      else if (result === 'disabled-server') toast.error('Notificações indisponíveis', 'O servidor ainda não está preparado para enviar notificações.');
      else toast.error('Este navegador não suporta notificações');
    });

  const list = (
    <ul className="mb-3 space-y-1 text-sm text-neutral-400">
      <li>• Mensagem nova de um cliente seu na Central</li>
      <li>• Lembretes das suas reuniões (no dia e 1h antes)</li>
      <li>• Admin: o WhatsApp da empresa precisa do QR Code</li>
    </ul>
  );

  if (push === 'on') {
    return (
      <div className="space-y-3">
        <p className="flex items-center gap-2 text-sm text-emerald-300">
          <CheckCircle2 className="size-4" /> Ativadas neste aparelho.
        </p>
        {list}
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" icon={Bell} loading={busy} onClick={() => run(async () => {
            const { data } = await sendTestPush();
            toast.info(data.delivered ? 'Notificação de teste enviada' : 'Nenhum aparelho recebeu', data.delivered ? 'Deve aparecer em segundos (com o Nexus em segundo plano ela também chega).' : 'Tente desativar e ativar de novo.');
          })}>
            Enviar teste
          </Button>
          <Button variant="ghost" size="sm" icon={BellOff} disabled={busy} onClick={() => run(disablePush)}>
            Desativar
          </Button>
        </div>
      </div>
    );
  }
  if (push === 'needs-install') {
    return <p className="text-sm text-neutral-400">No iPhone, as notificações só funcionam com o app instalado: siga os passos acima e ative-as por dentro do app.</p>;
  }
  if (push === 'denied') {
    return (
      <p className="text-sm text-amber-200/90">
        As notificações foram bloqueadas para o Nexus. {install.ios ? 'No iPhone: Ajustes → Notificações → Nexus → Permitir Notificações.' : 'Toque no cadeado da barra de endereço (ou nas configurações do app) → Notificações → Permitir.'} Depois volte aqui.
      </p>
    );
  }
  if (push === 'unsupported') {
    return <p className="text-sm text-neutral-400">Este navegador não suporta notificações. Use o Chrome (Android/computador) ou o app instalado no iPhone (iOS 16.4 ou mais recente).</p>;
  }
  return (
    <div>
      {list}
      <Button icon={Bell} loading={busy} onClick={turnOn}>
        Ativar notificações
      </Button>
    </div>
  );
}

/** Estado partilhado do botão e do modal. Regista de novo a inscrição deste aparelho ao entrar. */
export function useAppSetup() {
  const install = useInstallState();
  const [push, refreshPush] = usePushState();
  useEffect(() => {
    // Outra conta usou este aparelho (ou a inscrição mudou): passa a ser de quem entrou.
    resubscribePush().then(refreshPush).catch(() => {});
  }, [refreshPush]);
  const pending = (!install.installed && (install.canPrompt || install.ios)) || push === 'off';
  return { install, push, refreshPush, pending };
}

export function AppSetupModal({ open, onClose, setup }) {
  return (
    <Modal open={open} onClose={onClose} title="App e notificações" description="Use o Nexus como app no celular e receba os avisos importantes.">
      <div className="space-y-3">
        <Section icon={Smartphone} title="Instalar o app">
          <InstallSection install={setup.install} />
        </Section>
        <Section icon={Bell} title="Notificações neste aparelho">
          <PushSection push={setup.push} refresh={setup.refreshPush} install={setup.install} />
        </Section>
      </div>
    </Modal>
  );
}

/** Botão do topo (telemóvel), com ponto vermelho quando há algo a fazer. */
export function AppSetupIconButton({ setup, onClick }) {
  return (
    <span className="relative">
      <IconButton icon={Smartphone} label="App e notificações" onClick={onClick} className="size-9" />
      {setup.pending && <span className="pointer-events-none absolute top-1 right-1 size-2 rounded-full bg-red-500 ring-2 ring-[#1a1a1a]" />}
    </span>
  );
}

/** Botão da barra lateral (desktop). */
export function AppSetupSidebarButton({ setup, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-neutral-400 transition hover:bg-neutral-800/70 hover:text-white"
    >
      <Smartphone className="size-4" />
      <span className="flex-1 text-left">App e notificações</span>
      {setup.pending && <span className="size-2 rounded-full bg-red-500" aria-label="Há algo por configurar" />}
    </button>
  );
}

/** Telemóvel, ainda no navegador: convite discreto para instalar (fecha-se de vez no X). */
export function InstallBanner({ setup, onOpen }) {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });
  const { install } = setup;
  if (dismissed || install.installed || !(install.canPrompt || install.ios)) return null;
  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // sem armazenamento: volta a aparecer na próxima visita
    }
  };
  return (
    <div className={cx('mb-4 flex items-center gap-3 rounded-2xl bg-red-950/40 px-4 py-3 ring-1 ring-red-900/50 lg:hidden')}>
      <img src="/icons/icon-192.png" alt="" className="size-10 rounded-xl" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-white">Instale o Nexus no seu celular</p>
        <p className="text-xs text-neutral-400">Abre como app e avisa de mensagens e reuniões.</p>
      </div>
      <Button size="sm" onClick={install.canPrompt ? install.install : onOpen}>
        {install.canPrompt ? 'Instalar' : 'Como?'}
      </Button>
      <button type="button" onClick={dismiss} aria-label="Não mostrar de novo" className="rounded-lg p-1 text-neutral-500 hover:text-white">
        <X className="size-4" />
      </button>
    </div>
  );
}

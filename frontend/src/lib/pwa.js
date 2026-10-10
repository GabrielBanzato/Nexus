import { useCallback, useEffect, useState } from 'react';
import { request } from './api.js';

/**
 * App instalado (PWA) e notificações no telemóvel (Web Push).
 *
 *  - Android/Chrome/Edge: o navegador oferece "Instalar" (beforeinstallprompt) → botão nosso.
 *  - iPhone/iPad: não há botão automático; instala-se pelo Safari (Partilhar → Adicionar ao Ecrã
 *    principal). Notificações no iPhone só funcionam com o app instalado (iOS 16.4+).
 */

export const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;

export const isIOS = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

// O evento chega uma vez, cedo (antes de o React montar): guarda-se aqui.
let deferredPrompt = null;
const installListeners = new Set();
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault(); // o nosso botão decide quando mostrar
    deferredPrompt = event;
    installListeners.forEach((fn) => fn());
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    installListeners.forEach((fn) => fn());
  });
}

/** Regista o service worker (só em produção: em dev o Vite serve outra coisa em /sw.js). */
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
  // O index.html já o regista cedo; aqui só garante (mesmo registo) e mostra o erro, se houver.
  navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('Service worker não registado', err));
  navigator.serviceWorker.addEventListener('message', (event) => {
    // Notificação tocada com o app já aberto (navigate() falhou): muda de página aqui.
    if (event.data?.type === 'navigate' && event.data.url) window.location.href = event.data.url;
    if (event.data?.type === 'push-resubscribe') resubscribePush().catch(() => {});
  });
}

/** Estado da instalação: `canPrompt` (Android/desktop com botão), `ios` (instruções), `installed`. */
export function useInstallState() {
  const [, force] = useState(0);
  useEffect(() => {
    const update = () => force((n) => n + 1);
    installListeners.add(update);
    return () => installListeners.delete(update);
  }, []);
  const install = useCallback(async () => {
    if (!deferredPrompt) return false;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    deferredPrompt = null;
    installListeners.forEach((fn) => fn());
    return outcome === 'accepted';
  }, []);
  return { installed: isStandalone(), canPrompt: Boolean(deferredPrompt), ios: isIOS(), install };
}

// ---------------------------------------------------------------------------
// Notificações
// ---------------------------------------------------------------------------

function base64UrlToUint8Array(base64) {
  const padded = `${base64}${'='.repeat((4 - (base64.length % 4)) % 4)}`.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

async function currentSubscription() {
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

async function saveSubscription(subscription) {
  await request('/api/push/subscriptions', { method: 'POST', body: JSON.stringify(subscription.toJSON()) });
}

/**
 * Liga as notificações neste aparelho: pede permissão (tem de vir de um clique), inscreve no
 * serviço de push do navegador e regista no servidor.
 * @returns {Promise<'enabled'|'denied'|'unsupported'|'disabled-server'>}
 */
export async function enablePush() {
  if (!pushSupported()) return 'unsupported';
  const { data } = await request('/api/push/public-key');
  if (!data.enabled || !data.public_key) return 'disabled-server';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';
  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToUint8Array(data.public_key) });
  }
  await saveSubscription(subscription);
  return 'enabled';
}

/**
 * Ao sair da conta: este aparelho deixa de receber as notificações dela. Só local (o token já
 * vai ser apagado); o servidor descobre no próximo envio (410) e apaga a inscrição.
 */
export function forgetPushOnThisDevice() {
  if (!pushSupported()) return;
  currentSubscription()
    .then((subscription) => subscription?.unsubscribe())
    .catch(() => {});
}

export async function disablePush() {
  const subscription = await currentSubscription().catch(() => null);
  if (!subscription) return;
  await request('/api/push/subscriptions', { method: 'DELETE', body: JSON.stringify({ endpoint: subscription.endpoint }) }).catch(() => {});
  await subscription.unsubscribe().catch(() => {});
}

/** Inscrição trocada pelo navegador, ou outra pessoa entrou neste aparelho: regista de novo. */
export async function resubscribePush() {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  const subscription = await currentSubscription();
  if (subscription) await saveSubscription(subscription);
  else await enablePush();
}

export const sendTestPush = () => request('/api/push/test', { method: 'POST' });

/** 'on' | 'off' | 'denied' | 'unsupported' | 'needs-install' (iPhone sem o app instalado). */
export function usePushState() {
  const [state, setState] = useState('off');
  const refresh = useCallback(async () => {
    if (!pushSupported()) return setState(isIOS() && !isStandalone() ? 'needs-install' : 'unsupported');
    if (Notification.permission === 'denied') return setState('denied');
    if (import.meta.env.DEV) return setState('unsupported');
    const subscription = await currentSubscription().catch(() => null);
    setState(subscription && Notification.permission === 'granted' ? 'on' : 'off');
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  return [state, refresh];
}

import { useState } from 'react';
import { Globe, Loader2, MessageCircle, PhoneOff, Star } from 'lucide-react';
import { startLeadConversation } from '../lib/api.js';
import { openChatWithDraft } from '../lib/chatDraft.js';
import { LANGUAGE_LABELS } from '../utils/country.js';
import { gerarLinkWhatsApp, gerarMensagemWhatsApp, paisDoLead } from '../utils/whatsapp.js';
import { useToast } from './toast.jsx';
import { cx } from './ui.jsx';

/**
 * Peças visuais dos cards de lead, compartilhadas entre o Painel de Prospecção e a Triagem
 * (modo Caixas), para que os dois tenham exatamente o mesmo visual.
 */

const numberFormat = new Intl.NumberFormat('pt-BR');
const ratingFormat = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export const cardClass =
  'group flex flex-col rounded-2xl border bg-[#1a1a1a] p-5 transition duration-200 hover:-translate-y-0.5 hover:border-red-900/70 hover:shadow-xl hover:shadow-red-950/30';

export const secondaryButtonClass =
  'inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-xl border border-neutral-800 px-3 text-sm font-medium whitespace-nowrap text-neutral-300 transition hover:border-neutral-700 hover:bg-neutral-800/60 hover:text-white';

/** Remove CEP e país: "R. X, 10 - Centro, Campinas - SP, 13000-000" -> "R. X, 10 - Centro, Campinas - SP". */
export function shortAddress(address) {
  if (!address) return 'Endereço não informado';
  return address
    .replace(/,?\s*\d{5}-?\d{3}\s*$/, '')
    .replace(/,?\s*Brasil\s*$/i, '')
    .trim();
}

export function GroupBadge({ group }) {
  if (group === 'SEM_SITE') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-linear-to-r from-red-700 to-red-600 px-2.5 py-1 text-[11px] font-bold tracking-wide text-white shadow-md shadow-red-900/50 ring-1 ring-red-500/40">
        <span className="size-1.5 animate-pulse rounded-full bg-white" />
        SEM SITE
      </span>
    );
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-1 text-[11px] font-bold tracking-wide text-emerald-400 ring-1 ring-emerald-500/30">
      <Globe className="size-3" />
      COM SITE
    </span>
  );
}

export function Rating({ rating, reviewsCount }) {
  if (!rating) {
    return <p className="text-sm text-neutral-500">Sem avaliações</p>;
  }

  return (
    <div className="flex items-center gap-1.5 text-sm">
      <Star className="size-4 fill-amber-400 text-amber-400" />
      <span className="font-semibold text-white">{ratingFormat.format(rating)}</span>
      {reviewsCount != null && (
        <span className="text-neutral-500">({numberFormat.format(reviewsCount)} avaliações)</span>
      )}
    </div>
  );
}

/**
 * Botão de abordagem via WhatsApp. Abre a conversa do lead na Central de Atendimento (pelo
 * número da empresa, com a assinatura de quem envia) com a mensagem de abordagem já escrita no
 * campo, para rever e enviar. Só se a integração estiver desligada no servidor recorre ao
 * link wa.me (app do WhatsApp do computador).
 *  - variant="full": botão verde de largura total ("Chamar no WhatsApp"), usado nos cards.
 *  - variant="icon": só o ícone, discreto, para linhas de tabela.
 * `onContact` (opcional) dispara no clique.
 */
export function WhatsAppButton({ lead, variant = 'full', approached = false, onContact, className }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const link = gerarLinkWhatsApp(lead);
  // Empresa de fora: a mensagem sai no idioma do país (ex.: inglês nos EUA/Austrália).
  const pais = paisDoLead(lead);
  const idioma = pais.foreign ? `${pais.flag} ${pais.label}: mensagem em ${LANGUAGE_LABELS[pais.lang]}` : null;
  const unavailable = lead.phone ? `Número não compatível com WhatsApp: ${lead.phone}` : 'Telefone não informado';

  const handleContact = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const conversation = await startLeadConversation(lead.id);
      onContact?.(lead);
      openChatWithDraft(conversation, gerarMensagemWhatsApp(lead));
    } catch (err) {
      if (err.body?.code === 'WHATSAPP_DISABLED') {
        onContact?.(lead);
        window.open(link, '_blank', 'noopener,noreferrer');
      } else {
        toast.error('Não foi possível abrir a conversa', err.message);
      }
    } finally {
      setBusy(false);
    }
  };

  if (variant === 'icon') {
    if (!link) {
      return (
        <span title={unavailable} aria-label={unavailable} className={cx('inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-neutral-700', className)}>
          <PhoneOff className="size-4" />
        </span>
      );
    }
    return (
      <button
        type="button"
        onClick={handleContact}
        disabled={busy}
        title={`Chamar no WhatsApp (pela Central de Atendimento)${idioma ? ` · ${idioma}` : ""}`}
        aria-label={`Chamar ${lead.name} no WhatsApp`}
        className={cx(
          'inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-emerald-500 transition hover:bg-emerald-950/50 hover:text-emerald-300 focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:outline-none disabled:cursor-wait disabled:opacity-60',
          className,
        )}
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : <MessageCircle className="size-4" />}
      </button>
    );
  }

  if (!link) {
    return (
      <span
        title={unavailable}
        className={cx('flex h-10 w-full cursor-not-allowed items-center justify-center gap-2 rounded-xl bg-neutral-800/70 px-4 text-sm font-medium text-neutral-500', className)}
      >
        <PhoneOff className="size-4" />
        Sem WhatsApp
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={handleContact}
      disabled={busy}
      title={`Abre a conversa na Central de Atendimento com a mensagem pronta para enviar${idioma ? ` · ${idioma}` : ""}`}
      className={cx(
        approached
          ? 'flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-emerald-900/60 bg-emerald-950/20 px-4 text-sm font-semibold whitespace-nowrap text-emerald-400 transition hover:bg-emerald-950/50 active:scale-[0.98]'
          : 'flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-semibold whitespace-nowrap text-white shadow-md shadow-emerald-950/50 transition hover:bg-emerald-500 active:scale-[0.98]',
        'disabled:cursor-wait disabled:opacity-70',
        className,
      )}
    >
      {busy ? <Loader2 className="size-4 animate-spin" /> : <MessageCircle className="size-4" />}
      {approached ? 'Chamar novamente' : 'Chamar no WhatsApp'}
      {pais.foreign && (
        <span className="rounded-md bg-black/20 px-1.5 py-0.5 text-xs font-medium" aria-label={idioma}>
          {pais.flag} {pais.lang.toUpperCase()}
        </span>
      )}
    </button>
  );
}

import { useState } from 'react';
import { Ban, FileCheck2, Flame, PartyPopper, Repeat } from 'lucide-react';
import { formatCurrency, parseMoney } from '../lib/labels.js';
import { Button, Field, Modal, Select, Textarea, cx, inputClass } from './ui.jsx';

/**
 * Pop-ups do pipeline: o que o vendedor responde ao levar um negócio para cada estágio.
 *  - Em Negociação: dores do cliente, proposta real e isca;
 *  - Aguardando Resposta: proposta final apresentada (e o valor);
 *  - Cliente Fechado: sistema a fazer, valor negociado, prazo e mensalidade (o admin é avisado);
 *  - Perdido: o motivo (o admin é avisado).
 * Também serve para editar as respostas depois (`editing`), a partir do detalhe do negócio.
 */
export const STAGES_WITH_DETAILS = ['negotiation', 'awaiting', 'won', 'lost'];

export const LOSS_REASONS = ['Preço acima do orçamento', 'Escolheu um concorrente', 'Sem resposta do cliente', 'Projeto adiado', 'Fora do perfil'];
const OTHER = '__other__';

const pad = (n) => String(n).padStart(2, '0');
const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const nextMonth = () => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + 1);
  return monthKey(d);
};
const moneyText = (v) => (Number(v) > 0 ? String(v).replace('.', ',') : '');

function initialForm(stage, deal) {
  switch (stage) {
    case 'negotiation':
      return { pains: deal.pains ?? '', proposal_offer: deal.proposal_offer ?? '', bait: deal.bait ?? '' };
    case 'awaiting':
      return { final_proposal: deal.final_proposal ?? deal.proposal_offer ?? '', value: moneyText(deal.value) };
    case 'won':
      return {
        won_scope: deal.won_scope ?? '',
        value: moneyText(deal.value),
        delivery_due: deal.delivery_due ?? '',
        has_monthly: Number(deal.monthly_value) > 0,
        monthly_value: moneyText(deal.monthly_value),
        monthly_start: deal.monthly_start?.slice(0, 7) ?? nextMonth(),
      };
    case 'lost': {
      const known = LOSS_REASONS.includes(deal.lost_reason);
      return { choice: deal.lost_reason ? (known ? deal.lost_reason : OTHER) : '', other: known ? '' : deal.lost_reason ?? '' };
    }
    default:
      return {};
  }
}

const META = {
  negotiation: { title: 'Em negociação', icon: Flame, color: 'text-amber-400', submit: 'Guardar e mover' },
  awaiting: { title: 'Aguardando resposta', icon: FileCheck2, color: 'text-violet-400', submit: 'Guardar e mover' },
  won: { title: 'Cliente fechado! 🎉', icon: PartyPopper, color: 'text-emerald-400', submit: 'Fechar negócio' },
  lost: { title: 'Marcar como perdido', icon: Ban, color: 'text-red-400', submit: 'Marcar como perdido' },
};

/** Valida e converte o formulário no corpo do pedido. Devolve { body } ou { errors }. */
function toBody(stage, form, { canEditBilling }) {
  const errors = {};
  const need = (field, message) => {
    if (!String(form[field] ?? '').trim()) errors[field] = message;
  };
  if (stage === 'negotiation') {
    need('pains', 'Conte as dores do cliente.');
    need('proposal_offer', 'Descreva a proposta real.');
    need('bait', 'Qual é a isca?');
    if (Object.keys(errors).length) return { errors };
    return { body: { pains: form.pains.trim(), proposal_offer: form.proposal_offer.trim(), bait: form.bait.trim() } };
  }
  if (stage === 'awaiting') {
    need('final_proposal', 'Descreva a proposta final apresentada.');
    if (Object.keys(errors).length) return { errors };
    const value = parseMoney(form.value);
    return { body: { final_proposal: form.final_proposal.trim(), ...(value > 0 ? { value } : {}) } };
  }
  if (stage === 'won') {
    need('won_scope', 'Que sistema vamos fazer?');
    need('delivery_due', 'Indique o prazo.');
    const value = parseMoney(form.value);
    if (!(value > 0)) errors.value = 'Indique o valor negociado.';
    const monthly = form.has_monthly ? parseMoney(form.monthly_value) : 0;
    if (form.has_monthly && !(monthly > 0)) errors.monthly_value = 'Indique o valor da mensalidade.';
    if (form.has_monthly && !form.monthly_start) errors.monthly_start = 'Indique o mês da 1.ª mensalidade.';
    if (Object.keys(errors).length) return { errors };
    const body = { won_scope: form.won_scope.trim(), value, delivery_due: form.delivery_due };
    if (canEditBilling) Object.assign(body, { monthly_value: monthly, monthly_start: monthly > 0 ? `${form.monthly_start}-01` : null });
    return { body };
  }
  if (stage === 'lost') {
    const reason = form.choice === OTHER ? form.other.trim() : form.choice;
    if (!reason) return { errors: { [form.choice === OTHER ? 'other' : 'choice']: 'Indique o motivo da perda.' } };
    return { body: { lost_reason: reason.slice(0, 255) } };
  }
  return { body: {} };
}

/**
 * @param {{ stage, deal, editing?: boolean, canEditBilling?: boolean, submitting, error, onCancel, onConfirm(body) }} props
 *   canEditBilling: mensalidade (no fecho sempre; depois, só o admin).
 */
export default function DealStageModal({ stage, deal, editing = false, canEditBilling = true, submitting, error, onCancel, onConfirm }) {
  const [form, setForm] = useState(() => initialForm(stage, deal));
  const [errors, setErrors] = useState({});
  const meta = META[stage];

  const set = (field) => (event) => {
    const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    setForm((f) => ({ ...f, [field]: value }));
    setErrors((e) => ({ ...e, [field]: undefined }));
  };

  const submit = (event) => {
    event.preventDefault();
    const result = toBody(stage, form, { canEditBilling: canEditBilling || !editing });
    if (result.errors) return setErrors(result.errors);
    onConfirm(result.body);
  };

  const area = (field, { label, placeholder, rows = 3, autoFocus = false, hint }) => (
    <Field label={label} required error={errors[field]} hint={hint}>
      {({ id, invalid }) => (
        <Textarea id={id} rows={rows} aria-invalid={invalid} value={form[field]} onChange={set(field)} placeholder={placeholder} maxLength={4000} data-autofocus={autoFocus || undefined} className="min-h-20" />
      )}
    </Field>
  );

  return (
    <Modal
      open
      onClose={onCancel}
      size="md"
      title={
        <span className="flex items-center gap-2">
          <meta.icon className={cx('size-5', meta.color)} />
          {editing ? `${meta.title.replace(' 🎉', '').replace('!', '')} · editar` : meta.title}
        </span>
      }
      description={`${deal.title}${deal.company && deal.company !== deal.title ? ` · ${deal.company}` : ''}`}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={submitting}>Cancelar</Button>
          <Button type="submit" form="deal-stage-form" variant={stage === 'lost' ? 'danger' : 'primary'} loading={submitting}>
            {editing ? 'Guardar' : meta.submit}
          </Button>
        </>
      }
    >
      <form id="deal-stage-form" onSubmit={submit} className="space-y-4" noValidate>
        {error && <p role="alert" className="rounded-xl bg-red-950/40 px-3 py-2 text-sm text-red-300">{error}</p>}

        {stage === 'negotiation' && (
          <>
            {area('pains', { label: 'Dores do cliente', placeholder: 'O que está a doer hoje? Ex: perde pedidos no WhatsApp, não aparece no Google, depende de iFood…', autoFocus: true })}
            {area('proposal_offer', { label: 'Proposta real', placeholder: 'O que vamos entregar de verdade e por quanto. Ex: site + cardápio digital, R$ 3.500 + R$ 150/mês' })}
            {area('bait', { label: 'Isca', placeholder: 'O gancho para ele dizer sim. Ex: 1.º mês grátis, domínio incluído, entrega em 7 dias', rows: 2 })}
          </>
        )}

        {stage === 'awaiting' && (
          <>
            {area('final_proposal', { label: 'Proposta final apresentada', placeholder: 'Exatamente o que foi proposto: escopo, valor, condições de pagamento, prazo…', rows: 5, autoFocus: true })}
            <Field label="Valor da proposta (R$)" hint={deal.value ? `Atual: ${formatCurrency(deal.value)}` : 'Atualiza o valor do negócio'}>
              {({ id }) => <input id={id} inputMode="decimal" value={form.value} onChange={set('value')} className={inputClass} placeholder="Ex: 4.500" />}
            </Field>
          </>
        )}

        {stage === 'won' && (
          <>
            {area('won_scope', { label: 'Sistema a fazer', placeholder: 'Ex: site institucional + cardápio digital + integração com WhatsApp', autoFocus: true })}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Valor negociado (R$)" required error={errors.value}>
                {({ id, invalid }) => <input id={id} inputMode="decimal" aria-invalid={invalid} value={form.value} onChange={set('value')} className={inputClass} placeholder="Ex: 4.500" />}
              </Field>
              <Field label="Prazo de entrega" required error={errors.delivery_due}>
                {({ id, invalid }) => <input id={id} type="date" aria-invalid={invalid} value={form.delivery_due} onChange={set('delivery_due')} className={inputClass} />}
              </Field>
            </div>
            {(canEditBilling || !editing) && (
              <div className="rounded-xl border border-neutral-800 p-3">
                <label className="flex cursor-pointer items-center gap-3">
                  <input type="checkbox" checked={form.has_monthly} onChange={set('has_monthly')} className="size-4 accent-red-700" />
                  <span className="flex items-center gap-1.5 text-sm font-medium text-neutral-200">
                    <Repeat className="size-4 text-sky-400" />
                    O cliente vai pagar mensalidade
                  </span>
                </label>
                {form.has_monthly && (
                  <div className="mt-3 grid gap-4 sm:grid-cols-2">
                    <Field label="Mensalidade (R$)" required error={errors.monthly_value}>
                      {({ id, invalid }) => <input id={id} inputMode="decimal" aria-invalid={invalid} value={form.monthly_value} onChange={set('monthly_value')} className={inputClass} placeholder="Ex: 150" />}
                    </Field>
                    <Field label="1.ª mensalidade em" required error={errors.monthly_start}>
                      {({ id, invalid }) => <input id={id} type="month" aria-invalid={invalid} value={form.monthly_start} onChange={set('monthly_start')} className={inputClass} />}
                    </Field>
                  </div>
                )}
              </div>
            )}
            {!editing && <p className="text-xs text-neutral-500">O admin recebe o aviso no telemóvel com o sistema, o valor e o prazo.</p>}
          </>
        )}

        {stage === 'lost' && (
          <>
            <Field label="Motivo da perda" required error={errors.choice}>
              {({ id, invalid }) => (
                <Select id={id} aria-invalid={invalid} value={form.choice} onChange={set('choice')} data-autofocus>
                  <option value="">Escolha o motivo…</option>
                  {LOSS_REASONS.map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                  <option value={OTHER}>Outro motivo…</option>
                </Select>
              )}
            </Field>
            {form.choice === OTHER && (
              <Field label="Qual?" required error={errors.other}>
                {({ id, invalid }) => <Textarea id={id} rows={2} maxLength={255} aria-invalid={invalid} value={form.other} onChange={set('other')} placeholder="Conte o que aconteceu" className="min-h-16" />}
              </Field>
            )}
            {!editing && <p className="text-xs text-neutral-500">O motivo alimenta a análise de perdas e o admin é avisado.</p>}
          </>
        )}
      </form>
    </Modal>
  );
}

/** Respostas dos pop-ups, no detalhe do negócio (com "Editar"). */
export function DealStageAnswers({ deal, canEdit, onEdit }) {
  const blocks = [
    deal.pains || deal.proposal_offer || deal.bait
      ? { stage: 'negotiation', title: 'Negociação', rows: [['Dores', deal.pains], ['Proposta real', deal.proposal_offer], ['Isca', deal.bait]] }
      : null,
    deal.final_proposal ? { stage: 'awaiting', title: 'Proposta final', rows: [[null, deal.final_proposal]] } : null,
    deal.won_scope
      ? {
          stage: 'won',
          title: 'Fecho',
          rows: [
            ['Sistema', deal.won_scope],
            ['Prazo', deal.delivery_due?.split('-').reverse().join('/')],
            ['Mensalidade', Number(deal.monthly_value) > 0 ? `${formatCurrency(deal.monthly_value)}/mês desde ${deal.monthly_start?.slice(5, 7)}/${deal.monthly_start?.slice(0, 4)}${deal.monthly_end ? ` até ${deal.monthly_end.slice(5, 7)}/${deal.monthly_end.slice(0, 4)}` : ''}` : null],
          ],
        }
      : null,
  ].filter(Boolean);
  if (!blocks.length) return null;
  return (
    <div className="space-y-3">
      {blocks.map((b) => (
        <section key={b.stage} className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-3">
          <header className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-semibold tracking-wide text-neutral-400 uppercase">{b.title}</h3>
            {canEdit && (
              <button type="button" onClick={() => onEdit(b.stage)} className="text-xs font-medium text-neutral-400 transition hover:text-white">
                Editar
              </button>
            )}
          </header>
          <dl className="space-y-1.5 text-sm">
            {b.rows
              .filter(([, v]) => v)
              .map(([label, value]) => (
                <div key={label ?? 'text'}>
                  {label && <dt className="text-xs text-neutral-500">{label}</dt>}
                  <dd className="whitespace-pre-line text-neutral-200">{value}</dd>
                </div>
              ))}
          </dl>
        </section>
      ))}
    </div>
  );
}

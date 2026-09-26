import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, CircleCheck, CircleX, History, MessageSquareText, Pencil, Plus, Ticket, Trash2 } from 'lucide-react';
import { addNote, getActivity } from '../lib/api.js';
import { describeActivity, formatDateTime, formatRelative } from '../lib/labels.js';
import { useToast } from './toast.jsx';
import { Avatar, Button, EmptyState, ErrorState, Spinner, Textarea, cx } from './ui.jsx';

const KIND_STYLE = {
  note: { icon: MessageSquareText, className: 'bg-sky-950/60 text-sky-300 ring-sky-900/60' },
  deal: { icon: Plus, className: 'bg-neutral-800 text-neutral-300 ring-neutral-700' },
  ticket: { icon: Ticket, className: 'bg-neutral-800 text-neutral-300 ring-neutral-700' },
  edit: { icon: Pencil, className: 'bg-neutral-800 text-neutral-400 ring-neutral-700' },
  move: { icon: ArrowRightLeft, className: 'bg-amber-950/50 text-amber-300 ring-amber-900/60' },
  won: { icon: CircleCheck, className: 'bg-emerald-950/50 text-emerald-300 ring-emerald-900/60' },
  lost: { icon: CircleX, className: 'bg-red-950/50 text-red-300 ring-red-900/60' },
  delete: { icon: Trash2, className: 'bg-red-950/50 text-red-300 ring-red-900/60' },
};

const ENTITY_LABEL = { client: 'cliente', ticket: 'chamado', deal: 'negócio', lead: 'triagem' };
const dayLabel = (date) =>
  new Date(date).toLocaleDateString('pt-PT', { weekday: 'long', day: 'numeric', month: 'long' });

/**
 * Histórico de auditoria de um registo (+ registo de notas).
 * @param {{ entity: 'clients'|'tickets'|'deals', id: number, primaryType: string }} props
 *   primaryType: tipo da própria entidade nos logs; eventos relacionados (ex.: chamados de
 *   um cliente) mostram uma etiqueta de origem.
 */
export default function ActivityTimeline({ entity, id, primaryType }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const queryKey = ['activity', entity, id];

  const { data: logs = [], isLoading, isError, error, refetch } = useQuery({ queryKey, queryFn: () => getActivity(entity, id) });

  const noteMutation = useMutation({
    mutationFn: (text) => addNote(entity, id, text),
    onSuccess: () => {
      setNote('');
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (err) => toast.error('Não foi possível guardar a nota', err.message),
  });

  const submit = (event) => {
    event.preventDefault();
    if (note.trim()) noteMutation.mutate(note.trim());
  };

  // Agrupa por dia (os logs já vêm do mais recente para o mais antigo).
  const groups = [];
  for (const log of logs) {
    const key = new Date(log.created_at).toDateString();
    if (groups.at(-1)?.key !== key) groups.push({ key, date: log.created_at, items: [] });
    groups.at(-1).items.push(log);
  }

  return (
    <div className="space-y-5">
      <form onSubmit={submit} className="space-y-2">
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(e);
          }}
          rows={2}
          maxLength={2000}
          placeholder="Registar uma nota: chamada, reunião, combinado com o cliente... (Ctrl+Enter)"
          className="min-h-16"
          aria-label="Nova nota"
        />
        <div className="flex justify-end">
          <Button type="submit" size="sm" icon={MessageSquareText} loading={noteMutation.isPending} disabled={!note.trim()}>
            Adicionar nota
          </Button>
        </div>
      </form>

      {isError ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : isLoading ? (
        <Spinner label="A carregar histórico..." />
      ) : logs.length === 0 ? (
        <EmptyState icon={History} title="Sem atividade registada" description="As ações da equipe sobre este registo aparecem aqui." />
      ) : (
        <ol className="space-y-5" aria-label="Histórico de atividade">
          {groups.map((group) => (
            <li key={group.key}>
              <p className="mb-2 text-xs font-semibold tracking-wide text-neutral-500 uppercase first-letter:uppercase">{dayLabel(group.date)}</p>
              <ol className="relative space-y-3 border-l border-neutral-800 pl-5">
                {group.items.map((log) => {
                  const { title, body, kind } = describeActivity(log);
                  const style = KIND_STYLE[kind] ?? KIND_STYLE.edit;
                  const related = primaryType && log.entity_type !== primaryType;
                  return (
                    <li key={log.id} className="relative">
                      <span className={cx('absolute top-0.5 -left-[31px] flex size-5 items-center justify-center rounded-full ring-1', style.className)}>
                        <style.icon className="size-3" />
                      </span>
                      <p className="text-sm text-neutral-300">
                        <span className="inline-flex items-center gap-1.5 align-middle font-semibold text-white">
                          {log.user_id && <Avatar name={log.user_name ?? '?'} id={log.user_id} size="xs" />}
                          {log.user_name ?? 'Sistema'}
                        </span>{' '}
                        {title}
                        {related && (
                          <span className="ml-1.5 rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] font-medium text-neutral-400 uppercase">
                            {ENTITY_LABEL[log.entity_type] ?? log.entity_type} #{log.entity_id}
                          </span>
                        )}
                      </p>
                      {body && (
                        <p className={cx('mt-1 text-sm whitespace-pre-line', kind === 'note' ? 'rounded-lg bg-neutral-800/60 px-3 py-2 text-neutral-200' : 'text-neutral-500')}>
                          {body}
                        </p>
                      )}
                      <time dateTime={log.created_at} title={formatDateTime(log.created_at)} className="mt-0.5 block text-xs text-neutral-600">
                        {formatRelative(log.created_at)}
                      </time>
                    </li>
                  );
                })}
              </ol>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

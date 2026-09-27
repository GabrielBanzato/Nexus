import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DndContext, DragOverlay, useDroppable } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowRightLeft, Clock, Plus, Trash2, UserRound } from 'lucide-react';
import {
  createKanbanTask,
  deleteKanbanTask,
  getKanbanBoard,
  moveKanbanTask,
  updateKanbanTask,
} from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useUserDirectory } from '../lib/hooks.js';
import { KANBAN_COLUMNS, formatRelative } from '../lib/labels.js';
import { useBoardDnd } from '../lib/useBoardDnd.js';
import { useToast } from '../components/toast.jsx';
import {
  Avatar,
  Button,
  ConfirmDialog,
  ErrorState,
  Field,
  Modal,
  PageHeader,
  Select,
  Textarea,
  apiErrorToForm,
  cx,
  inputClass,
} from '../components/ui.jsx';

const COLUMN_IDS = KANBAN_COLUMNS.map((c) => c.id);
// ---------------------------------------------------------------------------
// Cartão
// ---------------------------------------------------------------------------

function TaskCard({ task, overlay = false }) {
  return (
    <div
      className={cx(
        'group rounded-xl border bg-[#202020] p-3 text-left transition',
        overlay
          ? 'rotate-2 cursor-grabbing border-red-800/70 shadow-2xl shadow-black/70'
          : 'cursor-grab border-neutral-800 hover:border-neutral-700 hover:bg-[#242424] active:cursor-grabbing',
      )}
    >
      <p className="line-clamp-3 text-sm leading-snug font-medium text-neutral-100">{task.title}</p>
      {task.description && <p className="mt-1.5 line-clamp-2 text-xs text-neutral-500">{task.description}</p>}
      <div className="mt-3 flex items-center justify-between gap-2">
        {task.responsible_id ? (
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-neutral-400">
            <Avatar name={task.responsible_name ?? '?'} id={task.responsible_id} size="xs" />
            <span className="truncate">{task.responsible_name}</span>
          </span>
        ) : (
          <span className="flex items-center gap-1 text-xs text-neutral-600">
            <UserRound className="size-3.5" />
            Sem responsável
          </span>
        )}
        <span className="flex shrink-0 items-center gap-1 text-[11px] text-neutral-600" title="Última atualização">
          <Clock className="size-3" />
          {formatRelative(task.updated_at)}
        </span>
      </div>
    </div>
  );
}

function SortableTask({ task, onOpen }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      aria-label={`Tarefa: ${task.title}. Enter para editar, Espaço para mover.`}
      onClick={() => onOpen(task)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          onOpen(task);
          return;
        }
        listeners?.onKeyDown?.(event);
      }}
      // select-none + sem callout: o toque longo que inicia o arrasto não seleciona texto nem abre menu (iOS/Android).
      className={cx('touch-manipulation rounded-xl outline-none select-none [-webkit-touch-callout:none] focus-visible:ring-2 focus-visible:ring-red-600', isDragging && 'opacity-30')}
    >
      <TaskCard task={task} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Coluna
// ---------------------------------------------------------------------------

function AddTaskInline({ column, onAdd }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const value = title.trim();
    if (!value) return;
    setSaving(true);
    try {
      await onAdd({ title: value, column_name: column });
      setTitle(''); // continua aberto para adicionar várias em sequência
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="m-2 mt-0 flex items-center gap-1.5 rounded-lg px-2 py-2 text-sm text-neutral-500 transition hover:bg-neutral-800/70 hover:text-neutral-200"
      >
        <Plus className="size-4" />
        Adicionar tarefa
      </button>
    );
  }

  return (
    <div className="m-2 mt-0 space-y-2">
      <textarea
        autoFocus
        rows={2}
        value={title}
        maxLength={200}
        disabled={saving}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
          if (e.key === 'Escape') setOpen(false);
        }}
        placeholder="Título da tarefa (Enter para guardar)"
        className={cx(inputClass, 'h-auto resize-none py-2')}
      />
      <div className="flex gap-2">
        <Button size="sm" onClick={submit} loading={saving} disabled={!title.trim()}>
          Adicionar
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}

function KanbanColumn({ column, tasks, onOpen, onAdd }) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });

  return (
    <section
      aria-label={column.label}
      data-board-column={column.id}
      className="flex w-[82vw] max-w-80 shrink-0 snap-start flex-col rounded-2xl border border-neutral-800 bg-[#161616] sm:w-72 lg:w-auto lg:max-w-none lg:min-w-0"
    >
      <header className="flex items-center justify-between px-3 pt-3 pb-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-neutral-200">
          <span className={cx('size-2 rounded-full', column.dot)} />
          {column.label}
        </h2>
        <span className="rounded-md bg-neutral-800 px-1.5 py-0.5 text-xs font-medium text-neutral-400 tabular-nums">
          {tasks.length}
        </span>
      </header>

      <SortableContext id={column.id} items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
        <div
          ref={setNodeRef}
          className={cx(
            'mx-2 mb-2 flex min-h-28 flex-1 flex-col gap-2 rounded-xl p-1 transition-colors',
            isOver && 'bg-red-950/20 ring-1 ring-red-900/50',
          )}
        >
          {tasks.map((task) => (
            <SortableTask key={task.id} task={task} onOpen={onOpen} />
          ))}
          {tasks.length === 0 && (
            <p className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-neutral-800 px-3 py-6 text-center text-xs text-neutral-600">
              Arraste tarefas para aqui
            </p>
          )}
        </div>
      </SortableContext>

      <AddTaskInline column={column.id} onAdd={onAdd} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Editor de tarefa
// ---------------------------------------------------------------------------

function TaskEditor({ task, onClose, onSave, onMove, onDelete, canDelete }) {
  const { data: users = [] } = useUserDirectory();
  const [form, setForm] = useState({
    title: task.title,
    description: task.description ?? '',
    responsible_id: task.responsible_id ?? '',
  });
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const set = (field) => (event) => setForm((f) => ({ ...f, [field]: event.target.value }));

  const save = async (event) => {
    event.preventDefault();
    if (!form.title.trim()) return setErrors({ title: 'Indique um título.' });
    setSaving(true);
    try {
      await onSave({
        title: form.title.trim(),
        description: form.description.trim() || null,
        responsible_id: form.responsible_id ? Number(form.responsible_id) : null,
      });
      onClose();
    } catch (err) {
      setErrors(apiErrorToForm(err).fields);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setDeleting(true);
    try {
      await onDelete();
      onClose();
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <Modal
        open
        onClose={onClose}
        title="Editar tarefa"
        description={`Criada ${formatRelative(task.created_at)}`}
        footer={
          <>
            {canDelete && (
              <Button variant="danger" icon={Trash2} onClick={() => setConfirmDelete(true)} className="mr-auto">
                Apagar
              </Button>
            )}
            <Button variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" form="task-editor" loading={saving}>
              Guardar
            </Button>
          </>
        }
      >
        <form id="task-editor" onSubmit={save} className="space-y-4">
          <Field label="Título" required error={errors.title}>
            {({ id, invalid }) => (
              <input id={id} aria-invalid={invalid} value={form.title} onChange={set('title')} maxLength={200} className={inputClass} />
            )}
          </Field>
          <Field label="Descrição">
            {({ id }) => <Textarea id={id} value={form.description} onChange={set('description')} rows={4} placeholder="Detalhes, links, critérios de aceitação..." />}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Responsável" error={errors.responsible_id}>
              {({ id }) => (
                <Select id={id} value={form.responsible_id} onChange={set('responsible_id')}>
                  <option value="">Sem responsável</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {/* Alternativa ao arrasto (teclado, telemóvel): move para o fim da coluna escolhida. */}
            <Field label="Mover para" hint="Também pode arrastar o cartão.">
              {({ id }) => (
                <Select id={id} value={task.column_name} onChange={(e) => onMove(e.target.value)}>
                  {KANBAN_COLUMNS.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={confirmDelete}
        title="Apagar tarefa?"
        description={`"${task.title}" será removida do quadro. Esta ação não pode ser desfeita.`}
        confirmLabel="Apagar tarefa"
        loading={deleting}
        onConfirm={remove}
        onClose={() => setConfirmDelete(false)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------

export default function KanbanPage() {
  const { user, isManager } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [mine, setMine] = useState(false);
  const boardKey = useMemo(() => ['kanban', { mine }], [mine]);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: boardKey,
    queryFn: () => getKanbanBoard({ mine }),
  });

  const [editingId, setEditingId] = useState(null);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['kanban'] });

  const moveMutation = useMutation({
    mutationFn: ({ id, column_name, position }) => moveKanbanTask(id, { column_name, position }),
    onError: (err, variables) => {
      queryClient.setQueryData(boardKey, variables.snapshot); // rollback
      toast.error('Não foi possível mover a tarefa', err.message);
    },
    onSettled: invalidate,
  });

  const createMutation = useMutation({
    mutationFn: createKanbanTask,
    onSuccess: invalidate,
    onError: (err) => toast.error('Não foi possível criar a tarefa', err.message),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ...body }) => updateKanbanTask(id, body),
    onSuccess: () => {
      toast.success('Tarefa atualizada');
      invalidate();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteKanbanTask,
    onSuccess: () => {
      toast.success('Tarefa apagada');
      invalidate();
    },
    onError: (err) => toast.error('Não foi possível apagar', err.message),
  });


  // Arrasto: lógica partilhada com o pipeline (lib/useBoardDnd.js).
  const { board, sensors, collisionDetection, activeItem: activeTask, handlers } = useBoardDnd({
    columnIds: COLUMN_IDS,
    serverBoard: data,
    columnField: 'column_name',
    filtered: mine,
    onDrop: ({ id, column, position, next, snapshot }) => {
      queryClient.setQueryData(boardKey, next); // otimista
      moveMutation.mutate({ id, column_name: column, position, snapshot });
    },
  });

  const allTasks = Object.values(board).flat();
  const editingTask = editingId ? allTasks.find((t) => t.id === editingId) : null;
  const doneCount = board.done.length;
  const progress = allTasks.length ? Math.round((doneCount / allTasks.length) * 100) : 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Quadro Kanban"
        description="Arraste os cartões entre colunas para atualizar o estado do trabalho."
        actions={
          <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-neutral-800 px-3 py-2 text-sm text-neutral-300 select-none hover:border-neutral-700">
            <input
              type="checkbox"
              checked={mine}
              onChange={(e) => setMine(e.target.checked)}
              className="size-4 accent-red-700"
            />
            Só as minhas
          </label>
        }
      />

      {!isLoading && !isError && (
        <div className="flex items-center gap-3 text-sm text-neutral-400">
          <div className="h-1.5 w-40 overflow-hidden rounded-full bg-neutral-800">
            <div className="h-full rounded-full bg-emerald-500 transition-[width] duration-500" style={{ width: `${progress}%` }} />
          </div>
          <span>
            <strong className="text-neutral-200">{doneCount}</strong> de {allTasks.length} concluídas
          </span>
        </div>
      )}

      {isError ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {KANBAN_COLUMNS.map((c) => (
            <div key={c.id} className="h-64 animate-pulse rounded-2xl border border-neutral-800 bg-[#161616]" />
          ))}
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={collisionDetection}
          {...handlers}
          accessibility={{
            screenReaderInstructions: {
              draggable: 'Prima Espaço para pegar na tarefa, setas para mover e Espaço para largar. Escape cancela.',
            },
          }}
        >
          <div className="-mx-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-4 sm:mx-0 sm:scroll-px-0 sm:px-0 lg:grid lg:grid-cols-4 lg:overflow-visible">
            {KANBAN_COLUMNS.map((column) => (
              <KanbanColumn
                key={column.id}
                column={column}
                tasks={board[column.id]}
                onOpen={(task) => setEditingId(task.id)}
                onAdd={(body) => createMutation.mutateAsync({ ...body, responsible_id: mine ? user?.id : undefined })}
              />
            ))}
          </div>
          <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.2, 0, 0, 1)' }}>
            {activeTask ? <TaskCard task={activeTask} overlay /> : null}
          </DragOverlay>
        </DndContext>
      )}

      {editingTask && (
        <TaskEditor
          key={editingTask.id}
          task={editingTask}
          canDelete={isManager || editingTask.created_by === user?.id || editingTask.responsible_id === user?.id}
          onClose={() => setEditingId(null)}
          onSave={(body) => updateMutation.mutateAsync({ id: editingTask.id, ...body })}
          onMove={(column_name) =>
            moveMutation.mutate({
              id: editingTask.id,
              column_name,
              position: 1_000_000, // o backend ajusta para o fim da coluna
              snapshot: board,
            })
          }
          onDelete={() => deleteMutation.mutateAsync(editingTask.id)}
        />
      )}

      <p className="hidden items-center gap-1.5 text-xs text-neutral-600 sm:flex">
        <ArrowRightLeft className="size-3.5" />
        Teclado: Tab até ao cartão, Espaço para pegar, setas para mover, Espaço para largar. Enter abre os detalhes.
      </p>
    </div>
  );
}

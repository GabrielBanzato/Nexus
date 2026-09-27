import { db } from '../config/database.js';
import { notFound } from '../lib/errors.js';
import { createOrderedBoard } from '../lib/orderedBoard.js';

export const KANBAN_COLUMNS = ['todo', 'in_progress', 'review', 'done'];

// Ordenação, locks e serialização ficam no motor genérico (ver lib/orderedBoard.js).
const board = createOrderedBoard({
  table: 'kanban_tasks',
  columnField: 'column_name',
  notFound: () => notFound('Tarefa'),
});

function withNames(query) {
  return query
    .leftJoin('users as r', 'r.id', 'k.responsible_id')
    .select('k.*', 'r.name as responsible_name');
}

export function findTaskById(id) {
  return withNames(db('kanban_tasks as k')).where('k.id', id).first();
}

/** Quadro completo agrupado por coluna, já ordenado por posição. */
export async function getBoard({ responsibleId } = {}) {
  const query = withNames(db('kanban_tasks as k')).orderBy('k.column_name').orderBy('k.position').orderBy('k.id');
  if (responsibleId) query.where('k.responsible_id', responsibleId);
  const tasks = await query;

  const grouped = Object.fromEntries(KANBAN_COLUMNS.map((column) => [column, []]));
  for (const task of tasks) grouped[task.column_name].push(task);
  return grouped;
}

/** Cria a tarefa; sem `position`, entra no fim da coluna. */
export async function createTask({ position, column_name: column = 'todo', ...fields }) {
  const id = await board.insert(fields, { column, position });
  return findTaskById(id);
}

/** Atualiza campos de conteúdo (título, descrição, responsável). Coluna/posição só via moveTask. */
export async function updateTask(id, fields) {
  await db('kanban_tasks').where({ id }).update(fields);
  return findTaskById(id);
}

/** Drag-and-drop. @returns {Promise<{ task: object, from: { column, position } }>} */
export async function moveTask(id, { column, position }) {
  const { from } = await board.move(id, { column, position });
  return { task: await findTaskById(id), from };
}

export function deleteTask(id) {
  return board.remove(id);
}

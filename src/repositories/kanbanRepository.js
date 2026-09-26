import { db } from '../config/database.js';
import { notFound } from '../lib/errors.js';

export const KANBAN_COLUMNS = ['todo', 'in_progress', 'review', 'done'];

/**
 * Modelo de ordenação: posições densas por coluna (0, 1, 2, ...), 0 = topo.
 * Toda operação que muda a ordem roda numa transação que bloqueia (FOR UPDATE)
 * as linhas das colunas envolvidas; assim dois drag-and-drops simultâneos são serializados.
 *
 * IMPORTANTE: dentro das transações, toda leitura que decide posições é uma leitura com
 * lock (FOR UPDATE). No REPEATABLE READ do InnoDB, um SELECT comum lê o snapshot tirado
 * na primeira leitura da transação, que pode ser anterior aos locks e estar desatualizado.
 */

const MAX_RETRIES = 6;
const RETRIABLE = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT', 'KANBAN_STALE_READ']);

async function withDeadlockRetry(fn) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!RETRIABLE.has(err.code) || attempt >= MAX_RETRIES) throw err;
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 25 * attempt)); // backoff com jitter
    }
  }
}

/**
 * Fila de mutações do quadro (dentro do processo): criar, mover e apagar rodam uma de cada vez.
 * Com uma instância do backend isso elimina deadlocks sob muitos drag-and-drops simultâneos
 * (cada mutação leva poucos ms). Os locks do MySQL + retry acima continuam a garantir a
 * consistência se houver várias instâncias.
 */
let boardQueue = Promise.resolve();
function serializeBoard(fn) {
  const run = boardQueue.then(fn, fn);
  boardQueue = run.catch(() => {});
  return run;
}

const staleRead = () => Object.assign(new Error('Tarefa movida por outro pedido; repetindo.'), { code: 'KANBAN_STALE_READ' });

/** Bloqueia todas as tarefas das colunas informadas, sempre na mesma ordem (evita deadlock). */
function lockColumns(trx, columns) {
  return trx('kanban_tasks')
    .whereIn('column_name', [...new Set(columns)].sort())
    .orderBy('id')
    .forUpdate()
    .select('id');
}

async function countInColumn(trx, column, excludingId) {
  const query = trx('kanban_tasks').where({ column_name: column });
  if (excludingId) query.whereNot({ id: excludingId });
  const [{ total }] = await query.count({ total: '*' }).forUpdate();
  return Number(total);
}

/** Leitura com lock (dado mais recente, não o snapshot da transação). */
function lockTask(trx, id) {
  return trx('kanban_tasks').select('column_name', 'position', 'title').where({ id }).forUpdate().first();
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

function withNames(query) {
  return query
    .leftJoin('users as r', 'r.id', 'k.responsible_id')
    .select('k.*', 'r.name as responsible_name');
}

export function findTaskById(id, trx = db) {
  return withNames(trx('kanban_tasks as k')).where('k.id', id).first();
}

/** Quadro completo agrupado por coluna, já ordenado por posição. */
export async function getBoard({ responsibleId } = {}) {
  const query = withNames(db('kanban_tasks as k')).orderBy('k.column_name').orderBy('k.position').orderBy('k.id');
  if (responsibleId) query.where('k.responsible_id', responsibleId);
  const tasks = await query;

  const board = Object.fromEntries(KANBAN_COLUMNS.map((column) => [column, []]));
  for (const task of tasks) board[task.column_name].push(task);
  return board;
}

/** Cria a tarefa; sem `position`, entra no fim da coluna. */
export function createTask({ position, ...fields }) {
  const column = fields.column_name ?? 'todo';

  return serializeBoard(() => withDeadlockRetry(() =>
    db.transaction(async (trx) => {
      await lockColumns(trx, [column]);
      const count = await countInColumn(trx, column);
      const target = position === undefined ? count : clamp(position, 0, count);

      await trx('kanban_tasks').where({ column_name: column }).andWhere('position', '>=', target).increment('position', 1);
      const [id] = await trx('kanban_tasks').insert({ ...fields, column_name: column, position: target });
      return findTaskById(id, trx);
    }),
  ));
}

/** Atualiza campos de conteúdo (título, descrição, responsável). Coluna/posição só via moveTask. */
export async function updateTask(id, fields) {
  await db('kanban_tasks').where({ id }).update(fields);
  return findTaskById(id);
}

/**
 * Drag-and-drop: move a tarefa para `column` na posição `position` (índice de destino).
 * @returns {Promise<{ task: object, from: { column, position } }>}
 */
export function moveTask(id, { column, position }) {
  return serializeBoard(() => withDeadlockRetry(async () => {
    // Fora da transação: só para saber quais colunas bloquear.
    const hint = await db('kanban_tasks').select('column_name').where({ id }).first();
    if (!hint) throw notFound('Tarefa');

    return db.transaction(async (trx) => {
      const toColumn = column ?? hint.column_name;
      await lockColumns(trx, [hint.column_name, toColumn]);

      // Relê com lock: se outro pedido mudou a tarefa de coluna entretanto, repete do início.
      const task = await lockTask(trx, id);
      if (!task) throw notFound('Tarefa');
      if (task.column_name !== hint.column_name) throw staleRead();

      const from = { column: task.column_name, position: task.position };
      const maxPosition = await countInColumn(trx, toColumn, id);
      const toPosition = clamp(position, 0, maxPosition);

      if (from.column === toColumn) {
        if (toPosition > from.position) {
          // Desceu: quem estava entre a posição antiga e a nova sobe uma casa.
          await trx('kanban_tasks')
            .where({ column_name: toColumn })
            .whereBetween('position', [from.position + 1, toPosition])
            .decrement('position', 1);
        } else if (toPosition < from.position) {
          // Subiu: quem estava entre a nova e a antiga desce uma casa.
          await trx('kanban_tasks')
            .where({ column_name: toColumn })
            .whereBetween('position', [toPosition, from.position - 1])
            .increment('position', 1);
        }
      } else {
        // Fecha o buraco na coluna de origem e abre espaço na de destino.
        await trx('kanban_tasks')
          .where({ column_name: from.column })
          .andWhere('position', '>', from.position)
          .decrement('position', 1);
        await trx('kanban_tasks')
          .where({ column_name: toColumn })
          .andWhere('position', '>=', toPosition)
          .increment('position', 1);
      }

      await trx('kanban_tasks').where({ id }).update({ column_name: toColumn, position: toPosition });
      return { task: await findTaskById(id, trx), from };
    });
  }));
}

export function deleteTask(id) {
  return serializeBoard(() => withDeadlockRetry(async () => {
    const hint = await db('kanban_tasks').select('column_name').where({ id }).first();
    if (!hint) throw notFound('Tarefa');

    return db.transaction(async (trx) => {
      await lockColumns(trx, [hint.column_name]);
      const task = await lockTask(trx, id);
      if (!task) throw notFound('Tarefa');
      if (task.column_name !== hint.column_name) throw staleRead();

      await trx('kanban_tasks').where({ id }).delete();
      await trx('kanban_tasks')
        .where({ column_name: task.column_name })
        .andWhere('position', '>', task.position)
        .decrement('position', 1);
      return task;
    });
  }));
}

import { db } from '../config/database.js';

/**
 * Motor de quadros ordenados (Kanban de tarefas, pipeline de negócios...).
 *
 * Modelo: cada linha tem uma coluna (`columnField`) e uma `position` densa dentro dela
 * (0, 1, 2, ... — 0 = topo). Garantias:
 *  - Mutações do mesmo quadro são serializadas no processo: com uma instância do backend
 *    não há deadlocks, mesmo com muitos drag-and-drops simultâneos.
 *  - Dentro da transação, as colunas envolvidas são bloqueadas (FOR UPDATE) e toda leitura
 *    que decide posições é uma leitura com lock. No REPEATABLE READ do InnoDB, um SELECT
 *    comum leria um snapshot possivelmente anterior aos locks.
 *  - Deadlocks/timeouts de lock (várias instâncias) são repetidos com backoff.
 */

const MAX_RETRIES = 6;
const RETRIABLE = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT', 'BOARD_STALE_READ']);

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const staleRead = () => Object.assign(new Error('Item movido por outro pedido; repetindo.'), { code: 'BOARD_STALE_READ' });

async function withRetry(fn) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!RETRIABLE.has(err.code) || attempt >= MAX_RETRIES) throw err;
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 25 * attempt));
    }
  }
}

/**
 * @param {object} options
 * @param {string} options.table        Tabela (precisa de `id` e `position`).
 * @param {string} options.columnField  Coluna que define a lista (ex.: 'column_name', 'stage').
 * @param {() => Error} options.notFound Erro lançado quando o item não existe.
 */
export function createOrderedBoard({ table, columnField, notFound }) {
  let queue = Promise.resolve();
  const serialize = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };
  const run = (fn) => serialize(() => withRetry(fn));

  const lockColumns = (trx, columns) =>
    trx(table).whereIn(columnField, [...new Set(columns)].sort()).orderBy('id').forUpdate().select('id');

  async function countIn(trx, column, excludingId) {
    const query = trx(table).where(columnField, column);
    if (excludingId) query.whereNot({ id: excludingId });
    const [{ total }] = await query.count({ total: '*' }).forUpdate();
    return Number(total);
  }

  const lockRow = (trx, id) => trx(table).where({ id }).forUpdate().first();

  return {
    /**
     * Insere na coluna (sem `position`, vai para o fim).
     * `afterInsert(trx, id)` roda na mesma transação (ex.: atualizar outras tabelas atomicamente).
     * @returns {Promise<number>} id criado
     */
    insert(fields, { column, position }, afterInsert) {
      return run(() =>
        db.transaction(async (trx) => {
          await lockColumns(trx, [column]);
          const count = await countIn(trx, column);
          const target = position === undefined ? count : clamp(position, 0, count);

          await trx(table).where(columnField, column).andWhere('position', '>=', target).increment('position', 1);
          const [id] = await trx(table).insert({ ...fields, [columnField]: column, position: target });
          if (afterInsert) await afterInsert(trx, id);
          return id;
        }),
      );
    },

    /**
     * Move o item para `column` no índice `position` (índice na coluna, sem contar o próprio item).
     * `onMove(trx, { id, row, from, to })` roda na mesma transação; o retorno vai em `extra`.
     * @returns {Promise<{ from, to, row, extra }>}
     */
    move(id, { column, position }, onMove) {
      return run(async () => {
        const hint = await db(table).select(columnField).where({ id }).first();
        if (!hint) throw notFound();

        return db.transaction(async (trx) => {
          const toColumn = column ?? hint[columnField];
          await lockColumns(trx, [hint[columnField], toColumn]);

          const row = await lockRow(trx, id);
          if (!row) throw notFound();
          if (row[columnField] !== hint[columnField]) throw staleRead();

          const from = { column: row[columnField], position: row.position };
          const max = await countIn(trx, toColumn, id);
          const toPosition = clamp(position ?? max, 0, max);

          if (from.column === toColumn) {
            if (toPosition > from.position) {
              await trx(table)
                .where(columnField, toColumn)
                .whereBetween('position', [from.position + 1, toPosition])
                .decrement('position', 1);
            } else if (toPosition < from.position) {
              await trx(table)
                .where(columnField, toColumn)
                .whereBetween('position', [toPosition, from.position - 1])
                .increment('position', 1);
            }
          } else {
            await trx(table).where(columnField, from.column).andWhere('position', '>', from.position).decrement('position', 1);
            await trx(table).where(columnField, toColumn).andWhere('position', '>=', toPosition).increment('position', 1);
          }

          await trx(table).where({ id }).update({ [columnField]: toColumn, position: toPosition });
          const to = { column: toColumn, position: toPosition };
          const extra = onMove ? await onMove(trx, { id, row, from, to }) : undefined;
          return { from, to, row, extra };
        });
      });
    },

    /**
     * Remove o item e fecha o buraco na coluna.
     * `afterRemove(trx, row)` roda na mesma transação (ex.: devolver o lead à triagem).
     * @returns {Promise<object>} linha removida
     */
    remove(id, afterRemove) {
      return run(async () => {
        const hint = await db(table).select(columnField).where({ id }).first();
        if (!hint) throw notFound();

        return db.transaction(async (trx) => {
          await lockColumns(trx, [hint[columnField]]);
          const row = await lockRow(trx, id);
          if (!row) throw notFound();
          if (row[columnField] !== hint[columnField]) throw staleRead();

          await trx(table).where({ id }).delete();
          await trx(table).where(columnField, row[columnField]).andWhere('position', '>', row.position).decrement('position', 1);
          if (afterRemove) await afterRemove(trx, row);
          return row;
        });
      });
    },
  };
}

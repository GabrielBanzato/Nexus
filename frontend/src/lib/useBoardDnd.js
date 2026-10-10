import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyboardSensor, PointerSensor, TouchSensor, closestCorners, pointerWithin, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable';

/**
 * Lógica de drag-and-drop partilhada pelos quadros (Kanban de tarefas, pipeline de negócios).
 *
 * - Cópia local do quadro que muda em tempo real durante o arrasto; fora do arrasto
 *   acompanha `serverBoard` (cache do TanStack Query).
 * - Teclado: Espaço pega/larga, ↑/↓ dentro da coluna, ←/→ saltam para a coluna vizinha.
 * - Ao largar, calcula a posição que o backend espera e chama `onDrop` (a página faz a
 *   atualização otimista do cache e a mutação).
 */

/** Tempo que o dedo precisa ficar parado sobre o cartão para começar a arrastar. */
export const TOUCH_DRAG_DELAY_MS = 1000;

/**
 * PointerSensor só para rato/caneta. Os eventos de ponteiro também disparam no toque (e antes
 * do touchstart); sem este filtro o PointerSensor capturava o dedo, o navegador assumia o
 * scroll e cancelava o arrasto. Assim, o toque fica só com o TouchSensor (toque longo).
 */
class MousePointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: 'onPointerDown',
      handler: (event, options) =>
        event.nativeEvent.pointerType !== 'touch' && PointerSensor.activators[0].handler(event, options),
    },
  ];
}

function findColumn(board, columnIds, id) {
  if (columnIds.includes(id)) return id;
  return columnIds.find((column) => board[column]?.some((item) => item.id === id));
}

function locate(board, columnIds, id) {
  const column = findColumn(board, columnIds, id);
  const index = column ? board[column].findIndex((item) => item.id === id) : -1;
  return { column, index, item: column ? board[column][index] : null };
}

/**
 * O backend espera o índice na coluna completa (sem contar o próprio item). Com filtros
 * (ex.: "só os meus"), o índice na tela não é o real: calcula-se pelas posições do
 * servidor dos vizinhos onde o cartão foi solto.
 */
function serverTargetPosition(list, index, origin, columnField) {
  const withoutSelf = (item) =>
    item.position - (origin.column === item[columnField] && origin.position < item.position ? 1 : 0);
  const above = list[index - 1];
  const below = list[index + 1];
  if (above) return withoutSelf(above) + 1;
  if (below) return withoutSelf(below);
  return 0;
}

function makeKeyboardCoordinates(columnIds) {
  return (event, args) => {
    const horizontal = event.code === 'ArrowLeft' || event.code === 'ArrowRight';
    if (!horizontal) return sortableKeyboardCoordinates(event, args);

    const { collisionRect, droppableRects } = args.context;
    if (!collisionRect) return undefined;
    event.preventDefault();

    const centerX = collisionRect.left + collisionRect.width / 2;
    const columns = columnIds.map((id) => ({ id, rect: droppableRects.get(id) })).filter((c) => c.rect);
    const distance = (c) => Math.abs(c.rect.left + c.rect.width / 2 - centerX);
    const current = columns.reduce((best, c) => (distance(c) < distance(best) ? c : best), columns[0]);
    const target = columns[columns.indexOf(current) + (event.code === 'ArrowRight' ? 1 : -1)];
    if (!target) return undefined;

    // Traz a coluna de destino para a vista (quadros com scroll horizontal).
    document.querySelector(`[data-board-column="${target.id}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return {
      x: target.rect.left + (target.rect.width - collisionRect.width) / 2,
      y: Math.min(Math.max(collisionRect.top, target.rect.top), Math.max(target.rect.top, target.rect.bottom - collisionRect.height)),
    };
  };
}

/**
 * @param {object} options
 * @param {string[]} options.columnIds
 * @param {Record<string, object[]>} options.serverBoard  Quadro vindo do servidor/cache.
 * @param {string} options.columnField  Campo da coluna no item ('column_name', 'stage').
 * @param {boolean} options.filtered    Se a vista está filtrada (posições ≠ índices).
 * @param {(move: { id, column, index, position, next, snapshot, item, from }) => void} options.onDrop
 */
export function useBoardDnd({ columnIds, serverBoard, columnField, filtered, onDrop }) {
  const empty = Object.fromEntries(columnIds.map((id) => [id, []]));
  const [board, setBoard] = useState(serverBoard ?? empty);
  const [activeId, setActiveId] = useState(null);
  const origin = useRef(null);
  const lastOverId = useRef(null);
  const recentlyMovedColumn = useRef(false);

  useEffect(() => {
    if (serverBoard && activeId === null) setBoard(serverBoard);
  }, [serverBoard, activeId]);

  // Libera a "trava" de colisão no frame seguinte a uma troca de coluna (ver collisionDetection).
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      recentlyMovedColumn.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [board]);

  /**
   * Colisão para quadros com colunas:
   *  1. Vale o que está SOB O PONTEIRO. Só `closestCorners` compara os cantos do cartão com os
   *     vizinhos: ao largar numa coluna quase vazia ao lado de uma cheia (ex.: "Perdido" ao lado
   *     de "Fechado"), o cartão caía na coluna vizinha. Sem ponteiro (teclado), usa proximidade.
   *  2. Logo após mudar de coluna, mantém o último alvo até ao próximo frame. Sem isto, a mudança
   *     de layout faz a colisão apontar para a coluna anterior, o cartão volta, e o ciclo repete-se
   *     ("Maximum update depth exceeded" — padrão do exemplo multi-container do dnd-kit).
   */
  const collisionDetection = useCallback(
    (args) => {
      const underPointer = pointerWithin(args);
      const collisions = underPointer.length ? underPointer : closestCorners(args);
      const overId = collisions[0]?.id ?? null;

      if (overId !== null && !recentlyMovedColumn.current) {
        lastOverId.current = overId;
        return [{ id: overId }];
      }
      if (recentlyMovedColumn.current) lastOverId.current = lastOverId.current ?? activeId;
      return lastOverId.current !== null ? [{ id: lastOverId.current }] : [];
    },
    [activeId],
  );

  const sensors = useSensors(
    useSensor(MousePointerSensor, { activationConstraint: { distance: 6 } }), // clique curto = abrir
    // Toque: segurar parado 1s para arrastar. Mexer o dedo mais de 5px antes disso é scroll normal.
    useSensor(TouchSensor, { activationConstraint: { delay: TOUCH_DRAG_DELAY_MS, tolerance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: makeKeyboardCoordinates(columnIds),
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter'] },
    }),
  );

  const onDragStart = ({ active, activatorEvent }) => {
    // No telemóvel, uma vibração curta confirma que o toque longo "pegou" o cartão.
    if (activatorEvent?.type === 'touchstart') navigator.vibrate?.(15);
    lastOverId.current = null;
    const found = locate(board, columnIds, active.id);
    origin.current = { snapshot: board, column: found.column, index: found.index, position: found.item.position };
    setActiveId(active.id);
  };

  // Passa o cartão para a outra coluna enquanto é arrastado (feedback imediato).
  const onDragOver = ({ active, over }) => {
    if (!over) return;
    setBoard((prev) => {
      const from = findColumn(prev, columnIds, active.id);
      const to = findColumn(prev, columnIds, over.id);
      if (!from || !to || from === to) return prev;

      const moving = prev[from].find((item) => item.id === active.id);
      let index = prev[to].length;
      if (!columnIds.includes(over.id)) {
        const overIndex = prev[to].findIndex((item) => item.id === over.id);
        const below = active.rect.current.translated && active.rect.current.translated.top > over.rect.top + over.rect.height / 2;
        index = overIndex >= 0 ? overIndex + (below ? 1 : 0) : prev[to].length;
      }
      recentlyMovedColumn.current = true;
      return {
        ...prev,
        [from]: prev[from].filter((item) => item.id !== active.id),
        [to]: [...prev[to].slice(0, index), moving, ...prev[to].slice(index)],
      };
    });
  };

  const onDragEnd = ({ active, over }) => {
    const start = origin.current;
    setActiveId(null);
    if (!over || !start) {
      setBoard(start?.snapshot ?? board);
      return;
    }

    let next = board;
    const column = findColumn(next, columnIds, active.id);
    if (column === findColumn(next, columnIds, over.id)) {
      const oldIndex = next[column].findIndex((item) => item.id === active.id);
      const newIndex = columnIds.includes(over.id) ? next[column].length - 1 : next[column].findIndex((item) => item.id === over.id);
      if (newIndex >= 0 && oldIndex !== newIndex) next = { ...next, [column]: arrayMove(next[column], oldIndex, newIndex) };
    }

    const index = next[column].findIndex((item) => item.id === active.id);
    if (column === start.column && index === start.index) {
      setBoard(start.snapshot);
      return;
    }

    const position = serverTargetPosition(next[column], index, start, columnField);
    next = { ...next, [column]: next[column].map((item) => (item.id === active.id ? { ...item, [columnField]: column } : item)) };
    if (!filtered) {
      // Quadro completo: as posições passam a ser os próprios índices.
      next = Object.fromEntries(Object.entries(next).map(([col, list]) => [col, list.map((item, i) => ({ ...item, position: i }))]));
    }
    setBoard(next);
    onDrop({
      id: active.id,
      column,
      index,
      position,
      next,
      snapshot: start.snapshot,
      from: start.column,
      item: next[column][index],
    });
  };

  const onDragCancel = () => {
    setActiveId(null);
    if (origin.current) setBoard(origin.current.snapshot);
  };

  const all = Object.values(board).flat();
  return {
    board,
    sensors,
    collisionDetection,
    activeItem: activeId === null ? null : all.find((item) => item.id === activeId) ?? null,
    handlers: { onDragStart, onDragOver, onDragEnd, onDragCancel },
  };
}

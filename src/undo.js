import { parentPath, basename } from './util.js';
import { notifyFsChanged } from './dnd.js';

// 되돌릴 수 있는 파일 작업 히스토리.
// move: {type:'move', items:[{from,to}]}  /  copy: {type:'copy', created:[path]}
// rename: {type:'rename', from, to}  /  renameBatch: {type:'renameBatch', items:[{from,to}]}
// create: {type:'create', path}
const stack = [];
const MAX = 50;
let activeUndo = null;

export function recordOp(op) {
  let remaining;
  if (op.type === 'move' || op.type === 'renameBatch') remaining = op.items.map((item) => ({ ...item }));
  else if (op.type === 'copy') remaining = [...op.created];
  else if (op.type === 'create') remaining = [op.path];
  else if (op.type === 'rename') remaining = [{ from: op.from, to: op.to }];
  else return;
  if (!remaining.length) return;
  stack.push({ type: op.type, remaining });
  if (stack.length > MAX) stack.splice(stack.findIndex((entry) => entry !== activeUndo), 1);
}

// 마지막 작업을 되돌린다. 되돌린 작업 type 반환, 스택이 비었으면 null.
export async function undoLast() {
  if (activeUndo) return null;
  const op = stack[stack.length - 1];
  if (!op) return null;
  activeUndo = op;
  const affected = new Set();
  try {
    while (op.remaining.length) {
      const item = op.remaining[op.remaining.length - 1];
      let result;
      let completed;
      let dirs;
      if (op.type === 'move') {
        result = await window.api.move([item.to], parentPath(item.from), { name: basename(item.from) });
        completed = result.items?.some((moved) => moved.from === item.to && moved.to === item.from);
        dirs = [parentPath(item.from), parentPath(item.to)];
        // A failed cross-volume cleanup may still have changed both locations.
        for (const recovery of result.recovery || []) {
          affected.add(parentPath(recovery.from));
          affected.add(parentPath(recovery.to));
        }
      } else if (op.type === 'copy' || op.type === 'create') {
        result = await window.api.trash([item]);
        completed = result.ok || result.trashed?.includes(item);
        dirs = [parentPath(item)];
      } else {
        result = await window.api.rename(item.to, basename(item.from));
        completed = result.ok;
        dirs = [parentPath(item.from), parentPath(item.to)];
      }
      if (completed) {
        op.remaining.pop();
        dirs.forEach((dir) => affected.add(dir));
      }
      if (!result.ok) throw new Error(result.error || '파일 작업에 실패했습니다.');
      if (!completed) throw new Error('항목이 원래 경로로 복원되지 않았습니다.');
    }
  } catch (err) {
    alert('실행 취소 실패: ' + (err.message || err));
  } finally {
    // A new operation may have been recorded while an IPC request was pending.
    if (!op.remaining.length) {
      const index = stack.indexOf(op);
      if (index !== -1) stack.splice(index, 1);
    }
    activeUndo = null;
  }
  if (affected.size) notifyFsChanged([...affected]);
  return op.type;
}

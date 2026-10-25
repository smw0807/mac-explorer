import { notifyFsChanged } from './dnd.js';

// Only the backend can verify that a file still belongs to a completed operation.
// Keep its opaque undo tokens; never infer an inverse operation from a path.
const stack = [];
const MAX = 50;
let activeUndo = null;

async function releaseHistory(op) {
  try {
    await window.api.undoRelease(op.remaining);
  } catch { /* The backend also releases tokens when their renderer is destroyed. */ }
}

export function recordOp(op) {
  if (!['move', 'copy', 'create', 'rename', 'renameBatch'].includes(op.type)) return;
  const remaining = [...new Set((Array.isArray(op.undo) ? op.undo : [])
    .map((item) => item?.token).filter((token) => typeof token === 'string' && token.length > 0))];
  if (!remaining.length) return;
  stack.push({ type: op.type, remaining });
  if (stack.length > MAX) {
    const [removed] = stack.splice(stack.findIndex((entry) => entry !== activeUndo), 1);
    releaseHistory(removed);
  }
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
      const token = op.remaining[op.remaining.length - 1];
      const result = await window.api.undo(token);
      // An unsuccessful undo can still have changed recovery locations.
      for (const dir of result.dirs || []) affected.add(dir);
      if (!result.ok) throw new Error(result.error || '파일 작업에 실패했습니다.');
      op.remaining.pop();
      if (result.warning) alert(result.warning);
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

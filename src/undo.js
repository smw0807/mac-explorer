import { parentPath, basename } from './util.js';
import { notifyFsChanged } from './dnd.js';

// 되돌릴 수 있는 파일 작업 히스토리.
// move: {type:'move', items:[{from,to}]}  /  copy: {type:'copy', created:[path]}
// rename: {type:'rename', from, to}  /  renameBatch: {type:'renameBatch', items:[{from,to}]}
// create: {type:'create', path}
const stack = [];
const MAX = 50;

export function recordOp(op) {
  stack.push(op);
  if (stack.length > MAX) stack.shift();
}

// 마지막 작업을 되돌린다. 되돌린 작업 type 반환, 스택이 비었으면 null.
export async function undoLast() {
  const op = stack.pop();
  if (!op) return null;
  const affected = new Set();
  try {
    if (op.type === 'move') {
      for (const { from, to } of op.items) {
        const dir = parentPath(from);
        const r = await window.api.move([to], dir, { conflict: 'keepBoth' });
        if (!r.ok) throw new Error(r.error);
        // 이동 당시 keepBoth로 이름이 바뀌었던 항목은 원래 이름으로 복구
        const landed = r.items[0]?.to;
        if (landed && basename(landed) !== basename(from)) {
          await window.api.rename(landed, basename(from));
        }
        affected.add(dir);
        affected.add(parentPath(to));
      }
    } else if (op.type === 'copy' || op.type === 'create') {
      const paths = op.type === 'copy' ? op.created : [op.path];
      const r = await window.api.trash(paths);
      if (!r.ok) throw new Error(r.error);
      paths.forEach((p) => affected.add(parentPath(p)));
    } else if (op.type === 'rename') {
      const r = await window.api.rename(op.to, basename(op.from));
      if (!r.ok) throw new Error(r.error);
      affected.add(parentPath(op.from));
    } else if (op.type === 'renameBatch') {
      for (const { from, to } of [...op.items].reverse()) {
        const r = await window.api.rename(to, basename(from));
        if (!r.ok) throw new Error(r.error);
        affected.add(parentPath(from));
      }
    }
  } catch (err) {
    alert('실행 취소 실패: ' + (err.message || err));
  }
  if (affected.size) notifyFsChanged([...affected]);
  return op.type;
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { notifyFsChanged } from '../dnd.js';
import { recordOp } from '../undo.js';
import { parentPath } from '../util.js';

// Copy jobs outlive the pane that started them, including a closed tab.
export default function useCopyJobs() {
  const [jobs, setJobs] = useState([]);
  const completed = useRef(new Set());

  useEffect(() => window.api.onCopyProgress((event) => {
    if (completed.current.has(event.jobId)) return;
    if (event.done) {
      // A tiny copy can finish before copyStart's IPC response reaches us.
      // Keep its ID so that the response cannot restore a finished progress row.
      completed.current.add(event.jobId);
      setJobs((previous) => previous.filter((job) => job.jobId !== event.jobId));
      recordOp({ type: 'copy', undo: event.undo });
      const dirs = new Set(event.created?.map(parentPath) || []);
      if (event.destDir) dirs.add(event.destDir);
      if (dirs.size) notifyFsChanged([...dirs]);
      if (event.error) alert(event.error);
      return;
    }
    setJobs((previous) => {
      if (completed.current.has(event.jobId)) return previous;
      const current = previous.find((job) => job.jobId === event.jobId);
      if (current) return previous.map((job) => job === current ? { ...job, ...event } : job);
      return [...previous, { copied: 0, total: 0, currentFile: '', ...event }];
    });
  }), []);

  const startCopy = useCallback(async (paths, destDir, opts) => {
    try {
      const result = await window.api.copyStart(paths, destDir, opts);
      if (!result.ok) { alert(result.error); return; }
      setJobs((previous) => {
        if (completed.current.has(result.jobId) || previous.some((job) => job.jobId === result.jobId)) return previous;
        return [...previous, { jobId: result.jobId, destDir, copied: 0, total: 0, currentFile: '' }];
      });
    } catch (error) {
      alert(error.message || String(error));
    }
  }, []);

  const cancelCopy = useCallback(async (jobId) => {
    setJobs((previous) => previous.map((job) => job.jobId === jobId ? { ...job, canceling: true } : job));
    try {
      const result = await window.api.copyCancel(jobId);
      if (!result.ok) throw new Error(result.error);
    } catch (error) {
      setJobs((previous) => previous.map((job) => job.jobId === jobId ? { ...job, canceling: false } : job));
      alert(error.message || String(error));
    }
  }, []);

  return { jobs, startCopy, cancelCopy };
}

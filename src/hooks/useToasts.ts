import { useCallback, useRef, useState } from 'react';

export interface Toast {
  id: number;
  message: string;
  kind: 'success' | 'error' | 'info';
}

/** Small toast queue used for copy / download / clear feedback. */
export function useToasts(timeout = 2600) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);

  const push = useCallback(
    (message: string, kind: Toast['kind'] = 'success') => {
      counter.current += 1;
      const id = counter.current;
      setToasts((current) => [...current, { id, message, kind }]);
      window.setTimeout(() => {
        setToasts((current) => current.filter((toast) => toast.id !== id));
      }, timeout);
    },
    [timeout],
  );

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  return { toasts, push, dismiss };
}

import { useCallback, useState } from 'react';
import { Icon, type IconName } from './Icon';

export type ToastKind = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  detail?: string;
}

let nextId = 1;

const ICONS: Record<ToastKind, IconName> = {
  success: 'check',
  error: 'alert',
  info: 'info',
  warning: 'alert',
};

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback((toast: Omit<Toast, 'id'>) => {
    const id = nextId++;
    setToasts((current) => [...current.slice(-4), { ...toast, id }]);
    window.setTimeout(() => dismiss(id), toast.kind === 'error' ? 7000 : 4200);
  }, [dismiss]);

  return { toasts, push, dismiss };
}

export function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toast-stack" role="region" aria-label="Notifications">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.kind}`} role="status">
          <span className="toast__icon">
            <Icon name={ICONS[toast.kind]} size={15} />
          </span>
          <div className="toast__body">
            <p className="toast__message">{toast.message}</p>
            {toast.detail ? <p className="toast__detail">{toast.detail}</p> : null}
          </div>
          <button className="toast__close" onClick={() => onDismiss(toast.id)} aria-label="Dismiss notification">
            <Icon name="close" size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

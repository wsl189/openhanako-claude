export interface Toast {
  id: number;
  text: string;
  type: 'success' | 'error' | 'info';
}

export interface ToastSlice {
  toasts: Toast[];
  addToast: (text: string, type?: Toast['type'], duration?: number) => void;
  removeToast: (id: number) => void;
}

let _toastId = 0;

export const createToastSlice = (
  set: (partial: Partial<ToastSlice> | ((s: ToastSlice) => Partial<ToastSlice>)) => void
): ToastSlice => ({
  toasts: [],
  addToast: (text, type = 'info', duration = 5000) => {
    const id = ++_toastId;
    set((s) => ({ toasts: [...s.toasts, { id, text, type }] }));
    if (duration > 0) {
      setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
      }, duration);
    }
  },
  removeToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
});

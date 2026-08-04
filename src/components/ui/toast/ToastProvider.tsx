import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createClientId } from '@/lib/client-id';
import { ToastViewport } from './ToastViewport';
import type { ToastApi, ToastInput, ToastRecord, ToastUpdate, ToastVariant } from './toast.types';

const MAX_TOASTS = 4;
const TOAST_EXIT_DURATION_MS = 180;

const ToastContext = createContext<ToastApi | undefined>(undefined);

function createToastId() {
  return createClientId('toast');
}

function getDefaultDuration(variant: ToastVariant) {
  switch (variant) {
    case 'success':
    case 'info':
      return 4000;
    case 'warning':
      return 5000;
    case 'error':
      return 6000;
    case 'loading':
      return 0;
  }
}

function buildToastRecord(input: ToastInput, id: string, existing?: ToastRecord): ToastRecord {
  const durationMs = input.durationMs ?? getDefaultDuration(input.variant);
  const dismissible = input.dismissible ?? true;
  const base: ToastRecord = {
    ...input,
    id,
    durationMs,
    dismissible,
    createdAt: existing?.createdAt ?? Date.now(),
    closing: false,
    paused: false,
  };

  if (input.layout === 'plugin-run') {
    return base;
  }

  return {
    ...base,
    layout: 'default',
  };
}

function applyToastPatch(existing: ToastRecord, patch: ToastUpdate): ToastRecord {
  const variant = patch.variant ?? existing.variant;
  const durationMs = patch.durationMs ?? existing.durationMs ?? getDefaultDuration(variant);
  const dismissible = patch.dismissible ?? existing.dismissible;
  const layout = patch.layout ?? existing.layout;
  const next: ToastRecord = {
    ...existing,
    ...patch,
    layout,
    variant,
    durationMs,
    dismissible,
    closing: false,
  };

  if (layout === 'plugin-run' && existing.layout === 'plugin-run') {
    return {
      ...next,
      pluginRun: patch.pluginRun ?? existing.pluginRun,
    };
  }

  return next;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const toastsRef = useRef<ToastRecord[]>([]);
  const dismissTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const removalTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const dismissStartedAtRef = useRef<Map<string, number>>(new Map());
  const dismissRemainingRef = useRef<Map<string, number>>(new Map());

  const setToastState = useCallback((updater: (current: ToastRecord[]) => ToastRecord[]) => {
    setToasts((current) => {
      const next = updater(current);
      toastsRef.current = next;
      return next;
    });
  }, []);

  const clearDismissTimer = useCallback((id: string) => {
    const timer = dismissTimersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      dismissTimersRef.current.delete(id);
    }
    dismissStartedAtRef.current.delete(id);
  }, []);

  const clearRemovalTimer = useCallback((id: string) => {
    const timer = removalTimersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      removalTimersRef.current.delete(id);
    }
  }, []);

  const clearToastTracking = useCallback(
    (id: string) => {
      clearDismissTimer(id);
      clearRemovalTimer(id);
      dismissRemainingRef.current.delete(id);
    },
    [clearDismissTimer, clearRemovalTimer],
  );

  const removeToastNow = useCallback(
    (id: string) => {
      clearToastTracking(id);
      setToastState((current) => current.filter((toast) => toast.id !== id));
    },
    [clearToastTracking, setToastState],
  );

  const dismiss = useCallback(
    (id: string) => {
      const target = toastsRef.current.find((toast) => toast.id === id);
      if (!target || target.closing) {
        return;
      }

      clearDismissTimer(id);
      clearRemovalTimer(id);
      setToastState((current) =>
        current.map((toast) =>
          toast.id === id ? { ...toast, closing: true, paused: false } : toast,
        ),
      );

      const removalTimer = setTimeout(() => {
        removeToastNow(id);
      }, TOAST_EXIT_DURATION_MS);
      removalTimersRef.current.set(id, removalTimer);
    },
    [clearDismissTimer, clearRemovalTimer, removeToastNow, setToastState],
  );

  const scheduleDismiss = useCallback(
    (id: string, durationMs: number) => {
      clearDismissTimer(id);
      if (durationMs <= 0) {
        dismissRemainingRef.current.delete(id);
        return;
      }

      dismissRemainingRef.current.set(id, durationMs);
      dismissStartedAtRef.current.set(id, Date.now());
      const timer = setTimeout(() => {
        dismiss(id);
      }, durationMs);
      dismissTimersRef.current.set(id, timer);
    },
    [clearDismissTimer, dismiss],
  );

  const show = useCallback(
    (input: ToastInput) => {
      const id = input.id ?? createToastId();
      let removedIds: string[] = [];

      clearRemovalTimer(id);
      setToastState((current) => {
        const existingIndex = current.findIndex((toast) => toast.id === id);
        const existing = existingIndex >= 0 ? current[existingIndex] : undefined;
        const nextToast = buildToastRecord(input, id, existing);
        let next = [...current];

        if (existingIndex >= 0) {
          next[existingIndex] = nextToast;
        } else {
          next = [nextToast, ...next];
        }

        if (next.length > MAX_TOASTS) {
          removedIds = next.slice(MAX_TOASTS).map((toast) => toast.id);
          next = next.slice(0, MAX_TOASTS);
        }

        return next;
      });

      for (const removedId of removedIds) {
        clearToastTracking(removedId);
      }

      const durationMs = input.durationMs ?? getDefaultDuration(input.variant);
      scheduleDismiss(id, durationMs);
      return id;
    },
    [clearRemovalTimer, clearToastTracking, scheduleDismiss, setToastState],
  );

  const update = useCallback(
    (id: string, patch: ToastUpdate) => {
      let nextDurationMs: number | null = null;

      clearRemovalTimer(id);
      setToastState((current) =>
        current.map((toast) => {
          if (toast.id !== id) {
            return toast;
          }

          const nextToast = applyToastPatch(toast, patch);
          nextDurationMs = nextToast.durationMs;
          return nextToast;
        }),
      );

      if (nextDurationMs === null) {
        return;
      }

      scheduleDismiss(id, nextDurationMs);
    },
    [clearRemovalTimer, scheduleDismiss, setToastState],
  );

  const dismissAll = useCallback(() => {
    for (const id of toastsRef.current.map((toast) => toast.id)) {
      clearToastTracking(id);
    }
    toastsRef.current = [];
    setToasts([]);
  }, [clearToastTracking]);

  const pause = useCallback(
    (id: string) => {
      const toast = toastsRef.current.find((item) => item.id === id);
      if (!toast || toast.closing || toast.durationMs <= 0 || toast.paused) {
        return;
      }

      const startedAt = dismissStartedAtRef.current.get(id);
      const remainingMs = dismissRemainingRef.current.get(id) ?? toast.durationMs;
      if (startedAt) {
        dismissRemainingRef.current.set(id, Math.max(0, remainingMs - (Date.now() - startedAt)));
      }

      clearDismissTimer(id);
      setToastState((current) =>
        current.map((item) => (item.id === id ? { ...item, paused: true } : item)),
      );
    },
    [clearDismissTimer, setToastState],
  );

  const resume = useCallback(
    (id: string) => {
      const toast = toastsRef.current.find((item) => item.id === id);
      if (!toast || toast.closing || toast.durationMs <= 0 || !toast.paused) {
        return;
      }

      const remainingMs = dismissRemainingRef.current.get(id) ?? toast.durationMs;
      setToastState((current) =>
        current.map((item) => (item.id === id ? { ...item, paused: false } : item)),
      );

      scheduleDismiss(id, remainingMs);
    },
    [scheduleDismiss, setToastState],
  );

  useEffect(
    () => () => {
      for (const timer of dismissTimersRef.current.values()) {
        clearTimeout(timer);
      }
      for (const timer of removalTimersRef.current.values()) {
        clearTimeout(timer);
      }
    },
    [],
  );

  const api = useMemo<ToastApi>(
    () => ({
      show,
      success: (input) => show({ ...input, variant: 'success' }),
      error: (input) => show({ ...input, variant: 'error' }),
      warning: (input) => show({ ...input, variant: 'warning' }),
      info: (input) => show({ ...input, variant: 'info' }),
      loading: (input) => show({ ...input, variant: 'loading' }),
      update,
      dismiss,
      dismissAll,
    }),
    [dismiss, dismissAll, show, update],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} onPause={pause} onResume={resume} />
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }

  return context;
}

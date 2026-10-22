import { useCallback, useEffect, useRef, useState } from "react";
import type { Attachment } from "../types";
import type { SubmissionOutcome } from "./useChatActions";

export interface QueuedMessage {
  id: string;
  text: string;
  attachments: Attachment[];
  uncertain?: boolean;
}
interface Args {
  isLoading: boolean;
  scopeKey?: string;
  stop: () => Promise<void>;
  waitForIdle?: () => Promise<void>;
  send: (
    text: string,
    attachments: Attachment[],
  ) => Promise<SubmissionOutcome | void>;
}
interface ChatQueue {
  messages: QueuedMessage[];
  error: string | null;
  busy: boolean;
  enqueue: (text: string, attachments?: Attachment[]) => void;
  remove: (id: string) => void;
  clear: () => void;
  sendNow: (id: string) => Promise<void>;
  stopCurrentTurn: () => Promise<void>;
  isHeld: () => boolean;
}

// @lat: [[chat-input#Chat Input#Queued message send-now]]
export function useChatQueue(args: Args): ChatQueue {
  const latest = useRef(args);
  useEffect(() => {
    latest.current = args;
  });
  const queue = useRef<QueuedMessage[]>([]);
  const [messages, setMessages] = useState<QueuedMessage[]>([]);
  const inFlight = useRef<Promise<void> | null>(null);
  const inFlightGenerationRef = useRef(0);
  const submittingRef = useRef(false);
  const explicitStopRef = useRef<Promise<void> | null>(null);
  const stopFailedRef = useRef(false);
  const selectedId = useRef<string | null>(null);
  const paused = useRef(false);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current += 1;
      explicitStopRef.current = null;
    },
    [args.scopeKey],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idleRevision, setIdleRevision] = useState(0);

  const enqueue = useCallback(
    (text: string, attachments: Attachment[] = []): void => {
      queue.current.push({ id: crypto.randomUUID(), text, attachments });
      setMessages([...queue.current]);
    },
    [],
  );
  const remove = useCallback((id: string): void => {
    if (selectedId.current === id) return;
    queue.current = queue.current.filter((item) => item.id !== id);
    setMessages([...queue.current]);
  }, []);

  const clear = useCallback((): void => {
    generation.current += 1;
    queue.current = [];
    paused.current = false;
    setMessages([]);
    setError(null);
  }, []);

  const run = useCallback(
    (interrupt: boolean, item?: QueuedMessage): Promise<void> => {
      if (inFlight.current) return inFlight.current;
      const { stop, send, waitForIdle } = latest.current;
      const version = generation.current;
      const contextChanged = (): boolean => {
        if (version === generation.current) return false;
        if (queue.current.length) {
          paused.current = true;
          setError(
            "Chat context changed. Queue paused; check the connection before retrying.",
          );
        }
        return true;
      };
      stopFailedRef.current = false;
      inFlightGenerationRef.current = version;
      selectedId.current = item?.id ?? null;
      setBusy(true);
      // Defer the body one microtask so the lock is installed before any callback.
      const pending = Promise.resolve().then(async (): Promise<void> => {
        let submitting = false;
        try {
          if (contextChanged()) return;
          if (interrupt) await stop();
          else await waitForIdle?.();
          if (contextChanged()) return;
          if (item) {
            submitting = true;
            submittingRef.current = true;
            const outcome = await send(item.text, item.attachments);
            if (outcome === "rejected" || outcome === "uncertain") {
              item.uncertain = outcome === "uncertain";
              paused.current = true;
              setError(
                outcome === "uncertain"
                  ? "Delivery uncertain. Check the session before removing or resubmitting this message. Queue paused."
                  : "Message not accepted. Queue paused; use Send now to retry.",
              );
              setMessages([...queue.current]);
              return;
            }
            queue.current = queue.current.filter((m) => m.id !== item.id);
            setMessages([...queue.current]);
          }
          // Stop cannot resolve ambiguous delivery. Keep the queue paused until
          // the user inspects/removes the uncertain item and explicitly sends.
          if (
            !stopFailedRef.current &&
            !queue.current.some((m) => m.uncertain)
          ) {
            paused.current = false;
            setError(null);
            if (!item) setIdleRevision((revision) => revision + 1);
          }
        } catch (reason) {
          if (version !== generation.current && !submitting) {
            if (!item) throw reason;
            return;
          }
          paused.current = true;
          if (item && submitting) {
            item.uncertain = true;
            setMessages([...queue.current]);
          }
          setError(
            submitting
              ? "Delivery uncertain. Check the session before removing or resubmitting this message. Queue paused."
              : `${reason instanceof Error ? reason.message : String(reason)} Queue paused; retry Stop or Send now.`,
          );
          if (!item) throw reason;
        } finally {
          if (inFlight.current === pending) {
            submittingRef.current = false;
            inFlight.current = null;
            selectedId.current = null;
            setBusy(false);
            // Completion can precede the submit ACK: retry the guarded drain
            // after releasing its lock, but never wake a different chat scope.
            if (version === generation.current)
              setIdleRevision((revision) => revision + 1);
          }
        }
      });
      inFlight.current = pending;
      return pending;
    },
    [],
  );

  const sendNow = useCallback(
    (id: string): Promise<void> => {
      if (inFlight.current) return inFlight.current.catch(() => undefined);
      if (explicitStopRef.current)
        return explicitStopRef.current.catch(() => undefined);
      const item = queue.current.find((m) => m.id === id);
      if (!item || item.uncertain) return Promise.resolve();
      return run(latest.current.isLoading, item);
    },
    [run],
  );
  const stopCurrentTurn = useCallback((): Promise<void> => {
    if (explicitStopRef.current) return explicitStopRef.current;
    if (
      !submittingRef.current &&
      (!inFlight.current ||
        inFlightGenerationRef.current === generation.current)
    )
      return run(true);
    // A submitted successor may already be running before its ACK arrives.
    // Stop it independently; keep the send lock and its delivery outcome intact.
    const version = generation.current;
    const pending = latest.current.stop().catch((reason) => {
      if (version !== generation.current) throw reason;
      stopFailedRef.current = true;
      paused.current = true;
      setError(
        `${reason instanceof Error ? reason.message : String(reason)} Queue paused; retry Stop or Send now.`,
      );
      throw reason;
    });
    explicitStopRef.current = pending;
    void pending
      .finally(() => {
        if (explicitStopRef.current === pending) {
          explicitStopRef.current = null;
          setIdleRevision((revision) => revision + 1);
        }
      })
      .catch(() => undefined);
    return pending;
  }, [run]);
  const isHeld = useCallback(
    (): boolean =>
      Boolean(inFlight.current || explicitStopRef.current || paused.current),
    [],
  );

  useEffect(() => {
    if (
      args.isLoading ||
      paused.current ||
      inFlight.current ||
      explicitStopRef.current
    )
      return;
    const item = queue.current[0];
    if (item && !item.uncertain) void run(false, item);
  }, [args.isLoading, idleRevision, run]);

  return {
    messages,
    error,
    busy,
    enqueue,
    remove,
    clear,
    sendNow,
    stopCurrentTurn,
    isHeld,
  };
}

import { useCallback, useEffect, useRef, useState } from 'react';
import type { StreamEvent } from '../../../shared/types';
import { isAbortError, toApiError } from './api';
import type { ApiRequestError } from './api';
import { useAuthEpoch } from './auth';
import { useLiveEvent } from './live';

const LIVE_REFETCH_DEBOUNCE_MS = 250;

export interface Resource<T> {
  /** Last good value. Kept while refetching and when a refetch fails. */
  data: T | undefined;
  error: ApiRequestError | null;
  /** True until the first answer (good or bad) for the current key. */
  loading: boolean;
  reload: () => void;
  /** Local, optimistic edit of the cached value. */
  mutate: (update: (current: T) => T) => void;
}

export interface ResourceOptions {
  /** Stream event types that should trigger a debounced refetch. */
  refreshOn?: readonly StreamEvent['type'][];
  /** Narrow the trigger further, e.g. to one run. */
  when?: (event: StreamEvent) => boolean;
}

interface State<T> {
  key: string;
  data: T | undefined;
  error: ApiRequestError | null;
  loading: boolean;
}

/**
 * Loads one resource and keeps it fresh. `key` identifies what is being
 * loaded: when it changes the old value is dropped, otherwise stale data stays
 * on screen while the next answer is on its way.
 */
export function useResource<T>(
  key: string,
  load: (signal: AbortSignal) => Promise<T>,
  options: ResourceOptions = {},
): Resource<T> {
  const [state, setState] = useState<State<T>>({ key, data: undefined, error: null, loading: true });
  const [tick, setTick] = useState(0);
  const epoch = useAuthEpoch();
  const loadRef = useRef(load);
  const optionsRef = useRef(options);
  const debounce = useRef<number | null>(null);

  useEffect(() => {
    loadRef.current = load;
    optionsRef.current = options;
  });

  useEffect(() => {
    const controller = new AbortController();
    loadRef.current(controller.signal).then(
      (data) => {
        if (controller.signal.aborted) return;
        setState({ key, data, error: null, loading: false });
      },
      (error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        setState((previous) => ({
          key,
          data: previous.key === key ? previous.data : undefined,
          error: toApiError(error),
          loading: false,
        }));
      },
    );
    return () => controller.abort();
  }, [key, tick, epoch]);

  const reload = useCallback(() => setTick((value) => value + 1), []);

  const mutate = useCallback(
    (update: (current: T) => T) => {
      setState((previous) =>
        previous.key === key && previous.data !== undefined
          ? { ...previous, data: update(previous.data) }
          : previous,
      );
    },
    [key],
  );

  useLiveEvent((event) => {
    const { refreshOn, when } = optionsRef.current;
    const relevant =
      event.type === 'resync' || (refreshOn?.includes(event.type) === true && (!when || when(event)));
    if (!relevant) return;
    if (debounce.current !== null) window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(() => {
      debounce.current = null;
      reload();
    }, LIVE_REFETCH_DEBOUNCE_MS);
  });

  useEffect(
    () => () => {
      if (debounce.current !== null) window.clearTimeout(debounce.current);
    },
    [],
  );

  // The first render after a key change still holds the previous key's state.
  if (state.key !== key) return { data: undefined, error: null, loading: true, reload, mutate };
  return { data: state.data, error: state.error, loading: state.loading, reload, mutate };
}

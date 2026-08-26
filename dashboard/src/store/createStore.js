// A Zustand-shaped store built on React 18's useSyncExternalStore.
//
// The call sites in this app are the ones Zustand documents:
//
//     const connected = useCommandStore((s) => s.link.connected);
//     useCommandStore.getState().ingestTelemetry(packet);
//
// so replacing this file with `import { create } from 'zustand'` is a one-line
// change if the dependency is ever added. It is not added here for a practical
// reason: this worktree shares its node_modules with the user's checkout, and
// installing into it would mutate their tree to gain ~40 lines.
//
// The one subtlety worth understanding is the snapshot cache below.
// useSyncExternalStore calls getSnapshot on every render AND on every store
// notification, and compares the result with Object.is. A selector that builds
// a new object each call -- `(s) => ({ a: s.a, b: s.b })` -- therefore looks
// like it changed every single time, and React loops forever. The cache holds
// the last selected value and returns the SAME reference while the supplied
// equality function says nothing changed, which is what makes `shallow` usable
// as a selector guard.
import { useRef, useSyncExternalStore } from 'react';

const identity = (state) => state;

export function createStore(initializer) {
  let state;
  const listeners = new Set();

  const getState = () => state;

  const setState = (partial, replace = false) => {
    const next = typeof partial === 'function' ? partial(state) : partial;
    if (Object.is(next, state)) return;
    state = replace ? next : { ...state, ...next };
    // Copied before iterating: an action that unsubscribes during the fan-out
    // would otherwise mutate the Set mid-iteration.
    for (const listener of [...listeners]) listener();
  };

  const subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  state = initializer(setState, getState);

  function useStore(selector = identity, equals = Object.is) {
    // One cache per component instance. Sharing it across components would let
    // a cheap selector in one component invalidate an expensive one in another.
    const cache = useRef({ primed: false, value: undefined });

    const getSnapshot = () => {
      const next = selector(state);
      if (cache.current.primed && equals(cache.current.value, next)) {
        return cache.current.value;
      }
      cache.current = { primed: true, value: next };
      return next;
    };

    // Third argument is the server snapshot; this app never renders on a
    // server, and passing the same function keeps hydration paths honest.
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  }

  useStore.getState = getState;
  useStore.setState = setState;
  useStore.subscribe = subscribe;
  return useStore;
}

/**
 * Shallow equality over own enumerable keys.
 *
 * Pass as the second argument to a selector that returns a fresh object:
 *
 *     const { speed, source } = useCommandStore(
 *       (s) => ({ speed: s.trucks[id]?.speed, source: s.trucks[id]?.source }),
 *       shallow,
 *     );
 */
export function shallow(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || a === null) return false;
  if (typeof b !== 'object' || b === null) return false;

  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;
  return keysA.every(
    (key) => Object.prototype.hasOwnProperty.call(b, key) && Object.is(a[key], b[key]),
  );
}

// A small typed publish/subscribe bus. Topics and payload types come from EventMap in core/types.ts, so a
// module publishes or listens by name without importing another module's internals.

export type Listener<T> = (payload: T) => void

export type ListenerErrorHandler = (topic: string, error: unknown) => void

// A listener that throws must not stop the others, but its error must not disappear either.
const reportListenerError: ListenerErrorHandler = (topic, error) => {
  console.error(`[bus] a "${topic}" listener threw`, error)
}

export class EventBus<M extends object> {
  private listeners = new Map<keyof M, Set<Listener<never>>>()
  private onError: ListenerErrorHandler

  constructor(onError: ListenerErrorHandler = reportListenerError) {
    this.onError = onError
  }

  /** Listen to a topic. Returns a function that stops listening. */
  subscribe<K extends keyof M>(topic: K, listener: Listener<M[K]>): () => void {
    let set = this.listeners.get(topic)
    if (!set) {
      set = new Set()
      this.listeners.set(topic, set)
    }
    set.add(listener as Listener<never>)
    return () => {
      set.delete(listener as Listener<never>)
    }
  }

  /** Deliver a payload to every listener of the topic, in the order they subscribed. */
  publish<K extends keyof M>(topic: K, payload: M[K]): void {
    const set = this.listeners.get(topic)
    if (!set) return
    for (const listener of [...set]) {
      try {
        ;(listener as Listener<M[K]>)(payload)
      } catch (error) {
        this.onError(String(topic), error)
      }
    }
  }
}

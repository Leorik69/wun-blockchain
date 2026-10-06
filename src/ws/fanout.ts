/**
 * Redis-backed WebSocket fan-out (Phase 7.3).
 *
 * Problem: behind a load balancer each replica holds only the WS clients that
 * happened to connect to it. A block mined on replica A must still reach the
 * clients connected to replica B. Solution: when Redis is active, wrap the
 * local {@link Broadcaster} so every `broadcast()` ALSO publishes the event to a
 * shared Redis channel; each replica subscribes to that channel and re-broadcasts
 * received events to ONLY its own locally-connected clients.
 *
 * Loop suppression: each replica stamps its published envelope with a unique
 * `origin` id and ignores envelopes carrying its own id, so the publishing
 * replica never double-delivers to its local clients (it already delivered
 * synchronously via the wrapped `broadcast`).
 *
 * MEMORY-MODE PARITY: this wrapper is NOT used when `REDIS_URL` is unset. The
 * bootstrap then keeps the plain `createBroadcaster()` and its direct in-process
 * broadcast, byte-identical to today. The wrapped broadcaster reuses the SAME
 * client `Set` instance, so the connection gauge and the WS hub see one shared
 * registry regardless of mode.
 *
 * Wire shapes are preserved: the published `message`/`eventType` are exactly the
 * arguments the controllers already pass to `broadcast()` (e.g.
 * `{ type: 'block_mined', block }` with eventType `'block_mined'`).
 */
import { randomUUID } from 'crypto';
import type { AppConfig } from '../config';
import type { StateStore, Unsubscribe } from '../state/StateStore';
import type { Broadcaster } from './hub';

/** Envelope published on the Redis fan-out channel. */
interface FanoutEnvelope {
  /** Unique id of the publishing replica (for loop suppression). */
  origin: string;
  /** The exact payload passed to `broadcast()`. */
  message: unknown;
  /** Optional subscription filter passed to `broadcast()`. */
  eventType?: string;
}

/** Result of {@link attachWsFanout}. */
export interface WsFanout {
  /** Broadcaster to install on `ctx` (wraps the local one; shares its client set). */
  broadcaster: Broadcaster;
  /**
   * Begin subscribing to the shared channel. Resolves to the shutdown function
   * the bootstrap calls on SIGTERM. Safe to call once.
   */
  start(): Promise<Unsubscribe>;
}

/**
 * Wrap `local` with Redis pub/sub fan-out. Only call this in Redis mode.
 *
 * @param selfId - optional stable replica id (defaults to a random UUID);
 *   exposed for tests that assert loop suppression deterministically.
 */
export function attachWsFanout(
  local: Broadcaster,
  store: StateStore,
  config: AppConfig,
  selfId: string = randomUUID(),
): WsFanout {
  const channel = config.redis.channel;

  const broadcaster: Broadcaster = {
    // Share the SAME client registry as the local broadcaster so the hub and
    // the WS-connection gauge observe one set.
    clients: local.clients,
    broadcast(message: unknown, eventType?: string): void {
      // 1. Deliver to our own connected clients immediately (unchanged path).
      local.broadcast(message, eventType);
      // 2. Fan out to the other replicas. Fire-and-forget; `publish` never
      //    throws (it fails soft), so a Redis blip cannot break the HTTP path.
      const envelope: FanoutEnvelope = { origin: selfId, message, eventType };
      void store.publish(channel, envelope as unknown as Record<string, unknown>);
    },
  };

  const start = async (): Promise<Unsubscribe> => {
    return store.subscribe(channel, (raw) => {
      const envelope = raw as unknown as FanoutEnvelope;
      // Ignore our own echo (we already delivered locally in broadcast()).
      if (!envelope || envelope.origin === selfId) return;
      local.broadcast(envelope.message, envelope.eventType);
    });
  };

  return { broadcaster, start };
}

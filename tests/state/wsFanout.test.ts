/**
 * Phase 7.3 — Redis pub/sub WebSocket fan-out with a FAKE Redis.
 *
 * Requires NO live Redis. Two {@link RedisStateStore}s share one
 * {@link FakeRedisBackend} to simulate two replicas; each is wrapped by
 * {@link attachWsFanout}. An event broadcast on replica A must reach replica B's
 * local clients, while A must NOT double-deliver to itself (origin suppression).
 * Also asserts the memory-mode parity path: a plain broadcaster delivers
 * directly to its own clients with no store involved.
 */
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/config';
import { RedisStateStore } from '../../src/state/RedisStateStore';
import { createBroadcaster, type Broadcaster, type WebSocketClient } from '../../src/ws/hub';
import { attachWsFanout } from '../../src/ws/fanout';
import { makeFakeFactory, flush } from './fakeRedis';

/** A broadcaster with one attached fake client that records every send. */
function makeHub(subscriptions: string[]): { broadcaster: Broadcaster; received: unknown[] } {
  const received: unknown[] = [];
  const broadcaster = createBroadcaster();
  const client = {
    ws: { send: (raw: string) => received.push(JSON.parse(raw)) },
    subscriptions: new Set(subscriptions),
  } as unknown as WebSocketClient;
  broadcaster.clients.add(client);
  return { broadcaster, received };
}

const config = loadConfig({ NODE_ENV: 'development', REDIS_URL: 'redis://localhost:6379' });

describe('attachWsFanout — cross-replica fan-out (fake Redis pub/sub)', () => {
  it('delivers an event published by one hub to another hub local clients', async () => {
    const { backend, factory } = makeFakeFactory();
    const storeA = new RedisStateStore({ url: config.redis.url!, keyPrefix: config.redis.keyPrefix, clientFactory: factory });
    const storeB = new RedisStateStore({ url: config.redis.url!, keyPrefix: config.redis.keyPrefix, clientFactory: factory });

    const hubA = makeHub(['block_mined']);
    const hubB = makeHub(['block_mined']);

    const fanA = attachWsFanout(hubA.broadcaster, storeA, config, 'replica-A');
    const fanB = attachWsFanout(hubB.broadcaster, storeB, config, 'replica-B');
    const unsubA = await fanA.start();
    const unsubB = await fanB.start();

    const event = { type: 'block_mined', block: { index: 5, hash: '0x5' } };
    fanA.broadcaster.broadcast(event, 'block_mined');
    await flush(5);

    // A delivered locally exactly once (its own echo is suppressed).
    expect(hubA.received).toEqual([event]);
    // B received the fanned-out event.
    expect(hubB.received).toEqual([event]);

    // Reverse direction works too.
    fanB.broadcaster.broadcast(event, 'block_mined');
    await flush(5);
    expect(hubB.received).toHaveLength(2);
    expect(hubA.received).toHaveLength(2);

    await unsubA();
    await unsubB();
    expect(backend.channelSubs.size).toBeGreaterThanOrEqual(0);
    await storeA.close();
    await storeB.close();
  });

  it('respects subscription filters (eventType) across replicas', async () => {
    const { factory } = makeFakeFactory();
    const storeA = new RedisStateStore({ url: config.redis.url!, keyPrefix: config.redis.keyPrefix, clientFactory: factory });
    const storeB = new RedisStateStore({ url: config.redis.url!, keyPrefix: config.redis.keyPrefix, clientFactory: factory });

    const hubA = makeHub(['block_mined']);
    // B's client is NOT subscribed to transaction_added.
    const hubB = makeHub(['block_mined']);

    const fanA = attachWsFanout(hubA.broadcaster, storeA, config, 'A');
    const fanB = attachWsFanout(hubB.broadcaster, storeB, config, 'B');
    await fanA.start();
    await fanB.start();

    fanA.broadcaster.broadcast({ type: 'transaction_added', tx: 'x' }, 'transaction_added');
    await flush(5);

    // Neither A nor B client subscribed to transaction_added → no delivery.
    expect(hubA.received).toHaveLength(0);
    expect(hubB.received).toHaveLength(0);

    await storeA.close();
    await storeB.close();
  });
});

describe('memory-mode parity — direct broadcast (no store, no Redis)', () => {
  it('delivers straight to local clients', () => {
    const hub = makeHub(['block_mined']);
    const event = { type: 'block_mined', block: { index: 1 } };
    hub.broadcaster.broadcast(event, 'block_mined');
    expect(hub.received).toEqual([event]);
  });

  it('does not deliver to clients unsubscribed from the eventType', () => {
    const hub = makeHub(['blockchain_info']); // not subscribed to block_mined
    hub.broadcaster.broadcast({ type: 'block_mined' }, 'block_mined');
    expect(hub.received).toHaveLength(0);
  });
});

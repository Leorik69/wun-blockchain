/**
 * StateStore factory (Phase 7.1).
 *
 * Chooses the coordination backend from config:
 *   - `REDIS_URL` unset → {@link MemoryStateStore} (DEFAULT, single-process,
 *     no sockets, no timers, no `ioredis` import). This is the path for local
 *     dev and ALL tests.
 *   - `REDIS_URL` set   → {@link RedisStateStore} (lazy client, dormant until
 *     the first command runs).
 *
 * Constructing the store NEVER opens a connection: the Redis client is created
 * on first use inside RedisStateStore, so importing this module (and even
 * building the Redis store) has no side effects.
 */
import type { AppConfig } from '../config';
import type { StateStore } from './StateStore';
import { MemoryStateStore } from './MemoryStateStore';
import { RedisStateStore, type RedisClientFactory } from './RedisStateStore';

export interface CreateStateStoreOptions {
  /** TEST SEAM: inject a fake Redis client factory (bypasses ioredis). */
  clientFactory?: RedisClientFactory;
}

/** Create the coordination backend implied by `config`. */
export function createStateStore(
  config: AppConfig,
  opts: CreateStateStoreOptions = {},
): StateStore {
  const url = config.redis.url;
  if (!url) {
    return new MemoryStateStore();
  }
  return new RedisStateStore({
    url,
    keyPrefix: config.redis.keyPrefix,
    commandTimeoutMs: config.redis.commandTimeoutMs,
    clientFactory: opts.clientFactory,
  });
}

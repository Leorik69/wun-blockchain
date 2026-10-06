/**
 * Barrel for the cross-replica coordination layer (Phase 7).
 *
 * Importing this module has NO side effects: the Redis client is dynamically
 * imported lazily inside RedisStateStore only when a command first runs, so
 * memory mode (no `REDIS_URL`) never loads `ioredis` or opens a socket.
 */
export type {
  StateStore,
  StateStoreKind,
  ChainTip,
  PubSubMessage,
  Unsubscribe,
  LockHandle,
  RateLimitHit,
  ContractStateCache,
} from './StateStore';
export { MemoryStateStore } from './MemoryStateStore';
export {
  RedisStateStore,
  type RedisClient,
  type RedisClientFactory,
  type RedisStateStoreOptions,
} from './RedisStateStore';
export { createStateStore, type CreateStateStoreOptions } from './createStateStore';
export {
  DistributedMiningLock,
  MiningLockRefusedError,
  type DistributedMiningLockOptions,
} from './DistributedMiningLock';

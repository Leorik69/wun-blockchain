# WUNCoin Blockchain

Блокчейн-сервис криптовалюты WUN: консенсус Proof-of-Work, ECDSA-подписи,
смарт-контракты, опциональная персистенция в Postgres и опциональный Redis-слой
для горизонтального масштабирования. Курс WUN отслеживает рыночную цену золота
как индекс/привязку — это **не** заявление о физическом золотом обеспечении или
праве на погашение.

> Подробная документация (архитектура, подписи/nonce, API, якорение
> Supabase→Chain, withdrawals): см. [`docs/BLOCKCHAIN_GUIDE.md`](../docs/BLOCKCHAIN_GUIDE.md).
>
> Формальная спецификация REST API: [`openapi.yaml`](./openapi.yaml) (OpenAPI 3.0.3).
>
> See also: чек-лист дефектов, блокирующих включение персистенции и
> масштабирования — [`docs/PERSISTENCE_SCALING_ENABLEMENT_CHECKLIST.md`](./docs/PERSISTENCE_SCALING_ENABLEMENT_CHECKLIST.md).

## 🏗️ Архитектура

Сервер модульный. Тонкий `src/server.ts` — только bootstrap (создание контекста,
подключение HTTP + WebSocket, graceful shutdown). Логика разнесена по слоям:

| Слой | Файлы | Ответственность |
|------|-------|-----------------|
| Конфиг | `src/config.ts` | Разрешение env → типизированный `AppConfig` |
| Контекст | `src/context.ts` | DI-контейнер: blockchain, pool, state store, репозитории, метрики |
| App | `src/app.ts` | Сборка Express (helmet, compression, cors, json 100kb, маршруты) |
| Bootstrap | `src/server.ts` | Запуск процесса, WS-хаб, graceful shutdown |
| Ядро | `src/blockchain.ts` | `WUNCoinBlockchain`: блоки, PoW, `applyTransactions`, валидация |
| Подписи | `src/signature.ts` | ECDSA (secp256k1), вывод адреса, каноническая сериализация |
| Маршруты | `src/routes/*.router.ts` | Тонкие роутеры (system, blockchain, transactions, mining, balance, keys, logs) |
| Контроллеры | `src/controllers/*.controller.ts` | Обработчики запросов |
| Middleware | `src/middleware/*` | apiKey, rateLimit, distributedRateLimit, cors, errorHandler, asyncHandler |
| WebSocket | `src/ws/*` | hub, protocol, auth (feature-flag), fanout (Redis pub/sub) |
| Валидация | `src/validation/transactionSchema.ts` | Zod-подобная схема транзакции |
| Майнинг | `src/mining/*` | PoW, worker-thread пул, ретаргетинг сложности, async-джобы, batch-верификация |
| Персистенция | `src/persistence/*` | Postgres-репозитории (WAL/group-commit), индекс истории |
| Состояние | `src/state/*` | StateStore (Memory/Redis), DistributedMiningLock |
| Метрики | `src/metrics.ts` | prom-client, префикс `wun_` |

### Ядро блокчейна (`src/blockchain.ts`)

- **Block**: index, timestamp, transactions[], previousHash, hash, nonce, miner,
  difficulty, `version`, `txRoot`. Genesis детерминирован (`GENESIS_TIMESTAMP` +
  `CHAIN_ID` в metadata).
- **Hash v2**: preimage включает `version` и `txRoot` (Merkle-корень транзакций)
  вместо полного JSON блока — ~40× ускорение PoW. Старые блоки (v1) принимаются.
- **Smart Contract State**: контрактное состояние применяется при добыче блока.
- **Transaction Types**: `transfer`, `mint`, `burn`, `stake`, `anchor` (no-op).
- **Gold Peg (index only)**: 1 WUN отслеживает рыночную цену 1 г золота — не
  заявление о резерве или праве на погашение (см. `docs/BLOCKCHAIN_GUIDE.md`).

### Смарт-контракты (`contracts/smartcontracts.ts`)

Контракты работают напрямую с общим `ContractState` (dependency injection) —
единственный источник истины для балансов. Диспетчеризация — в `blockchain.ts`
`applyTransactions()` по полю `tx.type`.

- **WUNCoinContract**: `transfer`, `mint` (только TREASURY), `burn`
- **StakingContract**: `stake` (сумма пишется в storage адреса)
- **MultiSigWallet**: мультисиг-кошелёк — **planned / not implemented** (в `contracts/smartcontracts.ts` отсутствует; описан как будущий контракт)

### ECDSA-подписи (`src/signature.ts`)

**Реализованы** (не «заготовлены»). Используется `@noble/secp256k1`. Адрес
вычисляется канонически: `0x` + `sha256(hexPublicKeyString)[0:40]`. Поддерживаются
форматы подписи DER и compact (64 байта). Общая криптография вынесена в пакет
`@wun/blockchain-crypto`, единый для backend/frontend/Flutter; сохраняется
dual-accept легаси-вывода адреса с deprecation-логом.

Batch-верификация подписей (`src/mining/verify.ts`) выгружается в воркер при
числе подписей ≥ `ECDSA_BATCH_THRESHOLD` (8).

### Майнинг (`src/mining/`)

- **Worker-thread PoW** (`MiningPool`, `miner.worker.ts`, `pow.ts`): `findNonce`
  выполняется в пуле воркеров, не блокируя event loop.
- **Ретаргетинг сложности** (`difficulty.ts`): пересчёт каждые
  `RETARGET_INTERVAL_BLOCKS` (20) блоков к цели `TARGET_BLOCK_INTERVAL_MS`
  (60 000 мс); границы `MIN=2`, `MAX=6`, `INITIAL=4`.
  > ⚠️ Эти дефолты (`maxDifficulty: 6` и связанные с ним) — **демонстрационные
  > параметры** для локальной/тестовой среды, а **не** боевой PoW-сети: максимум
  > 6 ведущих нулей даёт намеренно низкую стоимость майнинга, чтобы ретаргетинг
  > был наблюдаем. Все значения переопределяются через env (`MIN_DIFFICULTY`,
  > `MAX_DIFFICULTY`, `INITIAL_DIFFICULTY`, `RETARGET_INTERVAL_BLOCKS`,
  > `TARGET_BLOCK_INTERVAL_MS`); см. `DIFFICULTY_DEFAULTS` в `src/mining/difficulty.ts`.
- **Async-джобы** (`MineJobManager.ts`): `POST /api/mining/jobs` возвращает `jobId`
  (202), статус опрашивается через `GET /api/mining/jobs/:jobId`. Single-flight:
  одновременные вызовы коалесцируются и никогда не майнят дважды.
- **Синхронный** `POST /api/mining/mine` идёт через тот же single-flight +
  распределённый лок (при `REDIS_URL`); fail-closed, если лок недоступен.

## 📊 Консенсус

### Proof of Work

Блок валиден, если:
1. `hash` начинается с `difficulty` нулей;
2. `hash === sha256(preimage(blockFields))` (v2 preimage включает `txRoot`);
3. `previousHash` ссылается на предыдущий блок;
4. все транзакции валидны (включая подписи и nonce);
5. соблюдён schedule сложности для данной высоты.

Валидация всей цепи (`isChainValid`) кэшируется O(1) и инвалидируется только при
изменении цепи. Supply фиксирован в genesis (`TOTAL_SUPPLY_WUN = 1 000 000`),
награда майнеру — перераспределение из TREASURY, а не эмиссия.

## 🚀 Установка и запуск

```bash
cd blockchain
npm install
npm run dev        # ts-node на http://localhost:3001
npm run build      # tsc → dist/src/server.js
npm start          # node dist/src/server.js
```

### Переменные окружения

| Переменная | По умолчанию | Назначение |
|------------|--------------|------------|
| `PORT` | `3001` | HTTP/WS порт |
| `NODE_ENV` | `development` | В `production` apiKey-gate fail-closed; `test` отключает rate-limit |
| `BLOCKCHAIN_API_KEY` | — | Ключ для защищённых маршрутов (заголовок `x-api-key`) |
| `DATABASE_URL` | — | **Без него персистенция Postgres спит** (режим in-memory) |
| `REDIS_URL` | — | **Без него Redis-слой спит** (локальный rate-limit/лок/фан-аут) |
| `HOT_BLOCK_COUNT` | `1000` | Горячее окно блоков в памяти (остальное — cold, lazy-reload) |
| `MAX_PENDING_TX` | — | Ограничение mempool; переполнение → 503 |
| `REQUIRE_WS_AUTH` | `false` | Feature-flag авторизации WebSocket |
| `TRUST_PROXY` | `false` | Настройка Express `trust proxy` (`true`/`false`/кол-во хопов/подсеть). По умолчанию заголовки прокси **не** доверяются |
| `REQUIRE_TREASURY_SIGNATURE` | `true` | Требовать подпись для TREASURY-транзакций |
| `GENESIS_TIMESTAMP`, `CHAIN_ID` | — | Детерминированный genesis |

## 🔌 REST API

Все маршруты возвращают конверт `{ success, ... }`; ошибки —
`{ success: false, error }`. Тело запроса ограничено 100 КБ. Read-only маршруты
отдают `Cache-Control: public, max-age=5`; health/readiness-пробы — `no-store`
(чтобы CDN/прокси не маскировал сбой). Защищённые маршруты требуют заголовок
`x-api-key` (в production при незадуманном ключе — 503, при неверном — 401).
Большинство маршрутов за per-IP rate-limit (429), который **обходится при
`NODE_ENV=test`**.

```
GET  /api/version                     - git_sha, node_env, openapi (версия схемы)
GET  /api/health                      - liveness { success, status:"OK", timestamp, git_sha }
GET  /api/health/ready                - readiness (200/503): blockchainBooted, writeHealthy, miningPoolAlive
GET  /api/metrics                     - Prometheus text (wun_*), защищено API key

GET  /api/blockchain/info             - chainLength, pendingTransactions, difficulty, validators, isValid, writeDegraded
GET  /api/blockchain/blocks?limit&before  - пагинация блоков (новые первыми)
GET  /api/blockchain/chain            - вся цепь
GET  /api/blockchain/chain/:idx       - блок по индексу (400 невалидный, 404 вне цепи)
POST /api/validate                    - валидация цепи (API key)

POST /api/keys/generate               - генерация ECDSA ключей (API key)
POST /api/transactions/sign           - подписать (dev-only в production: ALLOW_SIGN_ENDPOINT)
POST /api/transactions                - добавить транзакцию в mempool
GET  /api/transactions/pending        - число ожидающих (O(1))
GET  /api/transactions/:txId/status   - статус (pending/confirmed/failed)
GET  /api/transactions/status/all?limit&offset - все статусы (пагинация)

POST /api/mining/mine                 - синхронная добыча блока (API key)
POST /api/mining/jobs                 - async-джоба → 202 { jobId } (API key)
GET  /api/mining/jobs/:jobId          - опрос статуса джобы

GET  /api/balance/:address            - баланс + nonce
GET  /api/address/:address/history?limit&offset - история адреса (пагинация, индекс при Postgres)

GET  /api/logs/stats                  - статистика логов (API key)
GET  /api/logs                        - список логов (API key)
POST /api/logs/export                 - экспорт логов (API key)
POST /api/logs/clear                  - очистить логи (API key)
```

### WebSocket

Хаб на том же порту. События: `connected` (текущее состояние),
`transaction_added`, `block_mined`. При `REQUIRE_WS_AUTH=true` клиент
аутентифицируется через `Sec-WebSocket-Protocol: ["wun-auth-v1", "<key>"]`
(предпочтительно — ключ не попадает в логи прокси); легаси-токен
`wun.auth.<key>` и устаревший `?key=<key>` по-прежнему принимаются.
Входящие кадры ограничены 64 КБ, `perMessageDeflate` отключён.
При `REDIS_URL` события фан-аутятся между репликами через Redis pub/sub
(`src/ws/fanout.ts`).

## 💾 Персистенция (Postgres) — опционально

**Спит без `DATABASE_URL`.** При включении (`src/persistence/`): `BlockRepository`
(WAL + group-commit), `PendingRepository`, `StatusRepository`, `TxIndexRepository`,
`SnapshotRepository`. Таблицы: `chain_blocks`, `chain_pending_tx`, `chain_tx_status`,
`chain_tx_index`, `chain_state_snapshot`. Hot/cold-разделение: в памяти держится
`HOT_BLOCK_COUNT` (1000) последних блоков, холодные лениво подгружаются из БД;
`getAddressHistoryPaged` обслуживается индексом. Форма ответа идентична in-memory.

## 📈 Метрики и health

- `GET /api/metrics` — prom-client, метрики с префиксом `wun_` (API-key gate).
- `GET /api/health` — liveness: всегда 200, пока процесс жив.
- `GET /api/health/ready` — readiness: 200/503, проверяет boot блокчейна,
  здоровье write-пути (в режиме персистенции) и живость mining-пула.
  Railway/Render healthcheck указывает на `/api/health/ready`.

## 🔴 Redis-слой масштабирования — опционально

**Спит без `REDIS_URL`.** При включении (`src/state/`, `src/middleware/distributedRateLimit.ts`):
`RedisStateStore` (ленивый ioredis), `DistributedMiningLock` (fail-closed +
fencing token), распределённый rate-limit (fail-open), WS-фан-аут. И синхронный
`POST /api/mining/mine`, и async-джобы проходят через single-flight + распределённый лок.

## 🧪 Тестирование

`npm test` = **Vitest** (`vitest run`) — единый CI-гейт. Прогоняет весь набор:
legacy-сьют (через shim `tests/legacy.test.ts`, который импортирует реестр
`legacyTests` из `tests/blockchain.test.ts`), HTTP golden-master контракты
(`tests/http/`), персистенцию, state, syncMineLock. Redis/Postgres **не требуются**.

```bash
npm test                # vitest run — весь набор (CI-гейт)
npm run test:contract   # только HTTP golden-master контракты
npm run test:legacy     # сырой ts-node-раннер legacy-сьюта (паритет)
npm run typecheck       # tsc --noEmit (strict)
```

Legacy-сьют сохранён как источник истины: `tests/blockchain.test.ts` экспортирует
массив `legacyTests`, а `tests/legacy.test.ts` оборачивает его в `it.each`, поэтому
покрытие идентично ts-node-раннеру по построению — без потери тестов.

### Performance harness (`tests/perf/`) — вне CI

Файлы `tests/perf/**` **исключены** из `npm test` и `vitest run` (не совпадают с
`tests/**/*.test.ts` + явный exclude). Запускаются по требованию:

```bash
npm run bench       # vitest bench: PoW, hash v1 vs v2, ретаргетинг сложности
npm run perf:http   # load-smoke: in-process сервер, процентили/throughput GET-маршрутов
npm run perf:soak   # soak: утечки памяти (rateBuckets/statusTracker/mempool/hot-window)
npm run perf        # всё вместе
```

Настройки — через env (например `LOAD_REQUESTS`, `LOAD_CONCURRENCY`,
`SOAK_MEMPOOL_TARGET`, `SOAK_MAX_HEAP_GROWTH_MB`).

## 📝 Примеры (cURL)

```bash
BASE=http://localhost:3001

# Состояние цепи
curl $BASE/api/blockchain/info

# Версия + версия OpenAPI-схемы
curl $BASE/api/version

# Readiness (для оркестратора)
curl -i $BASE/api/health/ready

# Метрики (в production нужен x-api-key)
curl $BASE/api/metrics -H "x-api-key: $BLOCKCHAIN_API_KEY"

# Сгенерировать ключи (защищено API key)
curl -X POST $BASE/api/keys/generate -H "x-api-key: $BLOCKCHAIN_API_KEY"

# Добавить подписанную транзакцию.
# Обычный (не mint / не TREASURY) перевод ДОЛЖЕН содержать
# id, timestamp, nonce, publicKey, signature (подписывается локально).
curl -X POST $BASE/api/transactions \
  -H "Content-Type: application/json" \
  -d '{
    "id": "tx-1",
    "from": "0xSENDER",
    "to": "0xRECIPIENT",
    "amount": 100,
    "type": "transfer",
    "timestamp": 1700000000000,
    "nonce": 0,
    "publicKey": "04...hex...",
    "signature": "...hex (DER или compact)..."
  }'

# Статус транзакции
curl $BASE/api/transactions/tx-1/status

# Синхронная добыча блока (защищено API key)
curl -X POST $BASE/api/mining/mine \
  -H "Content-Type: application/json" \
  -H "x-api-key: $BLOCKCHAIN_API_KEY" \
  -d '{"minerAddress": "0xMINER"}'

# Async-джоба: начать и опросить
curl -X POST $BASE/api/mining/jobs \
  -H "Content-Type: application/json" \
  -H "x-api-key: $BLOCKCHAIN_API_KEY" \
  -d '{"minerAddress": "0xMINER"}'
# → 202 { "jobId": "..." }
curl $BASE/api/mining/jobs/<jobId>

# Пагинация блоков (новые первыми)
curl "$BASE/api/blockchain/blocks?limit=20"
curl "$BASE/api/blockchain/blocks?limit=20&before=100"

# Баланс и история
curl $BASE/api/balance/0xADDRESS
curl "$BASE/api/address/0xADDRESS/history?limit=50&offset=0"

# Валидация цепи (защищено API key)
curl -X POST $BASE/api/validate -H "x-api-key: $BLOCKCHAIN_API_KEY"
```

### WebSocket (JavaScript)

```javascript
const ws = new WebSocket('ws://localhost:3001');
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'block_mined') console.log('Новый блок:', msg.block);
  else if (msg.type === 'transaction_added') console.log('Новая tx:', msg.transaction);
};
```

## 📚 Структура проекта

```
blockchain/
├── src/
│   ├── server.ts              # тонкий bootstrap (HTTP + WS + shutdown)
│   ├── app.ts                 # сборка Express
│   ├── config.ts              # env → AppConfig
│   ├── context.ts             # DI-контейнер
│   ├── blockchain.ts          # ядро: блоки, PoW, applyTransactions, валидация
│   ├── signature.ts           # ECDSA + вывод адреса
│   ├── apiKeyAuth.ts          # чистая логика API-key gate
│   ├── logger.ts              # структурный лог-буфер
│   ├── metrics.ts             # prom-client (wun_*)
│   ├── transaction-status.ts  # статус-tracker (pending/confirmed/failed)
│   ├── persistence.ts         # фасад персистенции
│   ├── controllers/           # *.controller.ts
│   ├── routes/                # *.router.ts
│   ├── middleware/            # apiKey, rateLimit, distributedRateLimit, cors, errorHandler, asyncHandler
│   ├── mining/                # pow, miner.worker, MiningPool, difficulty, MineJobManager, verify
│   ├── persistence/           # BlockRepository, PendingRepository, StatusRepository, TxIndexRepository, SnapshotRepository, db, schema
│   ├── state/                 # StateStore, MemoryStateStore, RedisStateStore, DistributedMiningLock, createStateStore
│   ├── validation/            # transactionSchema.ts
│   └── ws/                    # hub, protocol, auth, fanout
├── contracts/
│   └── smartcontracts.ts      # WUNCoinContract, StakingContract (MultiSigWallet — planned, not implemented)
├── tests/
│   ├── blockchain.test.ts     # legacy-сьют (экспортирует legacyTests)
│   ├── legacy.test.ts         # vitest shim для legacy-сьюта
│   ├── http/                  # golden-master контракты
│   ├── persistence/           # тесты репозиториев
│   ├── state/                 # тесты StateStore / DistributedMiningLock
│   └── perf/                  # bench / load / soak (вне CI)
├── openapi.yaml               # OpenAPI 3.0.3 спецификация
├── package.json
├── tsconfig.json              # strict
├── vitest.config.ts           # тесты; исключает tests/perf/**
├── eslint.config.js           # flat config
├── Dockerfile                 # multi-stage, non-root, dist/src/server.js
└── README.md
```

## 🔐 Безопасность

- **SHA-256** для целостности блоков; **ECDSA (secp256k1)** для подписей транзакций.
- **API-key gate** fail-closed в production; **helmet**; **CORS**; `express.json({ limit: '100kb' })`.
- **Rate limiting** per-IP (+ распределённый при Redis).
- **Feature-flagged WS auth** (`REQUIRE_WS_AUTH`).
- **Валидация цепи** с O(1)-кэшем; per-tx статусы confirm/fail; retry + `writeDegraded` на сохранении блока.

## 📄 Лицензия

MIT

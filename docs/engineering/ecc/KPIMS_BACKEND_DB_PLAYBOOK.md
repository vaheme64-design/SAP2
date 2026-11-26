# KPIMS Backend & Database Engineering Playbook (Pack B)

> **Purpose:** Operational engineering playbook for KPIMS server architecture, REST APIs, PostgreSQL, Prisma ORM v6, atomic transactions, safe migrations, and ERP data integrity.  
> **Scope:** Adapted from `affaan-m/ECC` strictly for KPIMS's **PostgreSQL + Prisma + Express + Internal PostgreSQL Auth** stack (no Firebase, no Supabase assumptions, no dual-DB sync assumptions).  
> **Source Attribution:** Sections are explicitly tagged `[ECC-Derived]` or `[KPIMS-Specific]`.

---

## 1. Node.js & Express Backend Architecture `[ECC-Derived + KPIMS-Specific]`

*Sources: `skills/backend-patterns/SKILL.md` (Next.js/Redis-specific examples omitted unless explicitly added later)*

### 1.1 Layered Architecture & Modularization Strategy
- **Target Layering `[ECC-Derived]`:**
  1. **Route / Controller Layer (`src/server/apiRouter.ts`, future domain routers):** HTTP parsing, auth/RBAC middleware, Zod input validation, HTTP status mapping, and response formatting. No complex business math or multi-table SQL orchestration inline.
  2. **Service Layer (`src/server/services/*` — e.g., `CapacityPlanningService.ts`, `MrpService.ts`, `WipService.ts`):** Use-case orchestration, transaction boundaries (`prisma.$transaction`), audit log emission, and cross-domain coordination.
  3. **Domain Engines (`src/server/*Engine.ts` — e.g., `stockEngine.ts`, `inventoryEngine.ts`, `mrpEngine.ts`, `productionWipEngine.ts`, `productionPlanningEngine.ts`):** Pure, deterministic, unit-testable industrial calculations (balances, coil weights, WIP reconciliation, MRP netting, OEE).
  4. **Data Access / Persistence (`src/server/db/prisma.ts`, Prisma repositories):** Query encapsulation, cursor/offset pagination, selective field projection (`select`), and database error translation.
- **Incremental Decomposition Rule `[KPIMS-Specific]`:**
  - `src/server/apiRouter.ts` is currently monolithic. Do not attempt a risky big-bang rewrite; instead, extract handlers into `src/server/services/` and domain route modules incrementally whenever a domain is touched, preserving all existing URL contracts and tests.
- **Express Middleware Order (`server.ts`) `[KPIMS-Specific + ECC-Derived]`:**
  1. Health probe (`/healthz`) — fast, dependency-light.
  2. Body parsing (`express.json`, `express.urlencoded`) with route-appropriate size ceilings (keep large limits isolated to bulk Excel/CSV import routes where possible rather than exposing unbounded bodies everywhere).
  3. Compression & security headers.
  4. Authentication & RBAC middleware (PostgreSQL session lookup + `roles`/`permissions` check).
  5. Feature routers under `/api`.
  6. Centralized JSON error middleware (never leak raw stack traces or SQL errors to clients).

### 1.2 Internal Backend Authentication & Session Architecture `[KPIMS-Specific + ECC-Derived]`
- **PostgreSQL-Backed Identity:** Use the existing Prisma models `User`, `Role`, `Permission`, `RolePermission`, and `AuditLog` (`prisma/schema.prisma`) plus a dedicated PostgreSQL session store (server-verified session tokens or short-lived tokens backed by revocable DB session rows).
- **Authorization Middleware Pattern `[ECC-Derived]`:**
  - Authenticate first (`401 Unauthorized` if missing/expired/revoked session).
  - Authorize second (`403 Forbidden` if user's PostgreSQL `role`/`permissions` lack the required permission code, e.g., `INVENTORY_POST`, `INVENTORY_REVERSE`, `MO_RELEASE`, `PARTS_WRITE`, `AUDIT_VIEW`).
  - Derive `createdById` / `userId` strictly from the authenticated server session — never accept spoofed author IDs from request bodies.
- **Rate Limiting `[ECC-Derived]`:** Apply request throttling on login/auth endpoints and expensive report/import endpoints (`429 Too Many Requests` with `Retry-After`).

---

## 2. REST API Design Standards `[ECC-Derived + KPIMS-Specific]`

*Sources: `skills/api-design/SKILL.md` (Python/Go/Next.js code snippets omitted)*

- **Resource Naming `[ECC-Derived]`:**
  - Plural lowercase kebab-case nouns for collections (`/api/parts`, `/api/manufacturing-orders`, `/api/inventory-documents`).
  - Sub-resources for ownership (`/api/customer-orders/:id/lines`).
  - Explicit action verbs only for non-CRUD state transitions (`POST /api/inventory-documents/:id/post`, `POST /api/inventory-documents/:id/reverse`, `POST /api/auth/login`, `POST /api/auth/logout`).
- **Semantic HTTP Status Codes `[ECC-Derived]`:**
  - `200 OK` (read/update), `201 Created` (resource creation), `204 No Content` (empty success).
  - `400 Bad Request` (malformed JSON/syntax), `401 Unauthorized` (unauthenticated), `403 Forbidden` (insufficient RBAC permission), `404 Not Found`, `409 Conflict` (duplicate unique code, concurrency/version conflict, already-posted voucher), `422 Unprocessable Entity` (Zod domain/business validation error with field-level details), `429 Too Many Requests`, `500 Internal Server Error`.
- **Standard Response & Pagination Contracts `[ECC-Derived + KPIMS-Specific]`:**
  - Single resource: `{ success: true, data: { ... } }`
  - Collection: `{ success: true, data: [...], meta: { total, page, limit } }` (or cursor metadata `{ nextCursor, hasMore }` for high-volume ledgers like `inventory_transactions` and `audit_logs`).
  - Error: `{ success: false, error: "<safe message>", code?: "<MACHINE_CODE>", details?: [...] }`.
- **Idempotency & Concurrency Control `[KPIMS-Specific + ECC-Derived]`:**
  - Voucher posting, production reporting, and Excel import batches must guard against duplicate submission via unique document numbers/keys (`DocumentSequence`, `ImportBatch`) and optimistic version checks where applicable.
- **Bounded Queries `[ECC-Derived]`:** Never expose unbounded `SELECT *` or unlimited `findMany()` on transaction/log/catalog endpoints; enforce explicit `take`/limit caps and default ordering.

---

## 3. PostgreSQL Engineering Standards `[ECC-Derived + KPIMS-Specific]`

*Sources: `skills/postgres-patterns/SKILL.md`, `agents/database-reviewer.md` (Supabase-specific pooler/RLS `auth.uid()` macros omitted; standard PostgreSQL rules retained)*

### 3.1 Schema & Data Types
- **Numeric Precision `[ECC-Derived + KPIMS-Specific]`:** Always use `NUMERIC` / `DECIMAL` (Prisma `Decimal`) for weights (`KG`), thicknesses (`mm`), quantities, scrap percentages, and financial amounts — never floating-point (`float`/`double`) for stock or accounting balances.
- **Timestamps `[ECC-Derived + KPIMS-Specific]`:** Store timestamps in UTC (`timestamptz` preferred for new columns; convert to Jalali display dates strictly in the UI/reporting layer).
- **Strings & Flags `[ECC-Derived]`:** Prefer `text` (or bounded length enforced via Zod + DB constraints) over arbitrary `varchar(255)`, and `boolean` for flags.

### 3.2 Indexing Strategy
- **Index Every Foreign Key `[ECC-Derived]`:** PostgreSQL does **not** automatically index foreign key columns; add indexes on FK columns used in joins, cascades, or `WHERE` filters.
- **Composite Index Column Order `[ECC-Derived]`:** Place equality columns first and range/sort columns second (e.g., `(warehouseId, partId)` or `(entityName, entityId)`, `(userId, timestamp)`).
- **Partial & GIN Indexes `[ECC-Derived]`:**
  - Use partial indexes for hot active subsets (e.g., `WHERE active = true` or `WHERE status = 'OPEN'`).
  - Use GIN indexes only when querying inside `jsonb` columns (`@>`), avoiding unnecessary write amplification on append-heavy snapshot tables.
- **Diagnostic Queries for Slow Paths `[ECC-Derived]`:**
  - Inspect execution plans with `EXPLAIN (ANALYZE, BUFFERS)` before optimizing.
  - Audit unindexed foreign keys via `pg_constraint` vs. `pg_index`, slow queries via `pg_stat_statements`, and dead-tuple bloat via `pg_stat_user_tables`.

### 3.3 PostgreSQL Connection & Timeout Safety
- Configure bounded connection pools and defensive timeouts (`statement_timeout`, `idle_in_transaction_session_timeout`, `connect_timeout`) so stuck queries cannot exhaust PostgreSQL connections.
- Use parameterized queries (`$1, $2`) for any raw SQL; never build SQL by string concatenation.

---

## 4. Prisma ORM v6 Engineering Standards `[ECC-Derived + KPIMS-Specific]`

*Sources: `skills/prisma-patterns/SKILL.md`*

- **Singleton `PrismaClient` `[ECC-Derived + KPIMS-Specific]`:** Always reuse the shared singleton from `src/server/db/prisma.ts` (never instantiate `new PrismaClient()` inside route handlers or request loops).
- **Projection Discipline (`select` vs. `include`) `[ECC-Derived]`:**
  - Use explicit `select` on read endpoints — especially on `User` queries (never accidentally select `passwordHash`) and wide models like `Part`, `ManufacturingOrder`, and `InventoryDocument`.
  - Avoid deep nested `include` chains that cause massive query fan-out or row explosion.
- **Prevent N+1 Queries `[ECC-Derived]`:**
  - Batch lookups using `where: { id: { in: ids } }`, `include` with bounded `select`, or grouped SQL aggregations instead of querying inside `for` loops.
- **Pagination `[ECC-Derived]`:**
  - Use cursor pagination (`cursor` + `take`) for large chronological tables (`inventory_transactions`, `production_reports`, `audit_logs`); offset (`skip`/`take`) is acceptable only for small bounded admin/master tables.
- **Critical Prisma Traps to Guard Against `[ECC-Derived]`:**
  1. **`updateMany` returns `{ count }`, not records:** Never expect updated rows back from `updateMany`.
  2. **`@updatedAt` does NOT fire on raw SQL or `updateMany`:** Set `updatedAt: new Date()` explicitly on bulk updates.
  3. **`deleteMany()` without `where` wipes the entire table:** Never call `deleteMany` without a non-empty, validated `where` filter (and never physically delete immutable ledger rows).
  4. **Soft delete (`active: false`) leaks on `findUnique`:** When querying active master data (`Part`, `User`, `Role`), enforce `active: true` explicitly with `findFirst`/`findMany` rather than assuming `findUnique` filters inactive rows.
  5. **Translate Prisma Error Codes:** Map `P2002` (unique constraint) → `409 Conflict`, `P2025` (record not found) → `404 Not Found`, `P2003` (FK violation) → `400/409` with clear Persian domain messages.

---

## 5. Database Transactions & Concurrency `[ECC-Derived + KPIMS-Specific]`

*Sources: `skills/prisma-patterns/SKILL.md`, `skills/backend-patterns/SKILL.md`, `skills/postgres-patterns/SKILL.md`*

- **Choose the Right Transaction Form `[ECC-Derived]`:**
  - **Batch Transaction (`prisma.$transaction([op1, op2])`):** Use for independent atomic writes that do not depend on intermediate read results.
  - **Interactive Transaction (`prisma.$transaction(async (tx) => { ... }, { timeout, maxWait })`):** Use for read-validate-write flows (e.g., checking available `StockBalance` or `PhysicalCoil` remaining weight, incrementing `DocumentSequence`, inserting `InventoryTransaction`, updating `StockBalance`, and writing `AuditLog`).
- **Interactive Transaction Timeout Trap `[ECC-Derived]`:**
  - Prisma's default interactive `$transaction` timeout is **5 seconds**. Keep transactions strictly DB-only (never call external HTTP APIs, parse Excel files, or run heavy CPU loops inside `$transaction`). Set explicit `maxWait` and `timeout` options only when justified by batched ERP postings.
- **Preventing Overdrafts & Race Conditions `[KPIMS-Specific + ECC-Derived]`:**
  - Guard negative-stock prevention, coil partial-issue weight checks, reservation consumption, and `DocumentSequence` increments inside a single database transaction using row-level locking (`SELECT ... FOR UPDATE`) or atomic conditional updates (`UPDATE ... WHERE remainingWeight >= $qty`).
  - Use optimistic concurrency (`version` column check) when updating concurrent WIP/plan snapshots so lost updates return `409 Conflict` instead of silently overwriting.

---

## 6. Safe Database Migrations `[ECC-Derived + KPIMS-Specific]`

*Sources: `skills/database-migrations/SKILL.md`, `skills/prisma-patterns/SKILL.md` (Drizzle/Kysely/Django/golang-migrate sections omitted)*

- **Core Migration Rules `[ECC-Derived]`:**
  1. **Every schema change is a tracked migration** — never apply ad-hoc DDL to production PostgreSQL manually.
  2. **Never run `prisma migrate dev` or `prisma db push --accept-data-loss` against shared/production databases:** `migrate dev` can trigger a destructive reset; use `prisma migrate deploy` in staging/production and `prisma migrate status` to inspect drift.
  3. **Migrations are immutable once applied:** Never edit an already-applied migration SQL file; create a new forward migration instead.
  4. **Separate schema (DDL) from data backfills (DML):** Never mix heavy row backfills inside locking DDL transactions.
- **Zero-Downtime Expand-Contract Pattern `[ECC-Derived]`:**
  - **Adding columns:** Add as nullable or with a safe default first → backfill in batches → add `NOT NULL` constraint in a follow-up migration.
  - **Renaming/removing columns:** Expand (add new column + dual-write) → backfill → switch reads → contract (drop old column in a later release).
  - **Indexes on large tables:** Create indexes with `CREATE INDEX CONCURRENTLY` via custom SQL migration (`prisma migrate dev --create-only`) to avoid blocking factory writes.
- **KPIMS Migration Commands & Runbook Alignment `[KPIMS-Specific]`:**
  - Local development migration creation: `npm run db:migrate` (`prisma migrate dev`).
  - Regenerate client after schema edits: `npx prisma generate` (also runs in `npm run build` and `postinstall`).
  - Always cross-check against `docs/database-migration-runbook.md` and back up PostgreSQL before applying production migrations.

---

## 7. Data Integrity & ERP Consistency Invariants `[KPIMS-Specific + ECC-Derived]`

- **Atomic Ledger-to-Balance Consistency:** Every stock change must flow through a posted `InventoryDocument` → immutable `InventoryTransaction` → updated `StockBalance` (and `PhysicalCoil` / `MaterialContractTransaction` when coil/contract-linked) inside one atomic transaction.
- **Zero Physical Deletion of Ledger & Audit Trails:** Reversals must create a linked compensating document (`reversalOf` / reference link) restoring origin quantities and decrementing destination quantities atomically.
- **No Over-Allocation / No Negative Stock:** Cumulative issues and reservations across a coil, lot, or warehouse balance must never exceed available physical quantity.
- **Unit & Weight Conversion Integrity:** Maintain strict distinction between `KG` (coils/sheets/scrap) and `PCS` (blanks/WIP/finished goods) with explicit net/gross weight and scrap norm tracking.
- **Auditability:** All privileged state transitions (`VOUCHER_POST`, `VOUCHER_REVERSE`, `MO_RELEASE`, `DIE_STATUS_CHANGE`, role/permission changes, user activation/deactivation) must record an `AuditLog` entry with `userId`, `action`, `entityName`, `entityId`, `oldValues`, `newValues`, and UTC `timestamp`.

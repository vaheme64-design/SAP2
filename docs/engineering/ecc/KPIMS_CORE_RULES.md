# KPIMS Core Engineering Rules (Pack A)

> **Purpose:** Always-on engineering constitution for the KPIMS codebase (React 19 + Vite + TypeScript + Express + Prisma + PostgreSQL).  
> **Scope:** Authoritative coding, React, security, testing/TDD, and error-handling rules adapted from `affaan-m/ECC` for Google AI Studio workflows.  
> **Source Attribution:** Sections are explicitly tagged `[ECC-Derived]` or `[KPIMS-Specific]`.

---

## 1. Authoritative Architecture Baseline `[KPIMS-Specific]`

All code written or reviewed against this pack must conform to these non-negotiable architectural invariants:

- **Frontend:** React 19 SPA with Vite (`vite.config.ts`), TypeScript (`tsconfig.json`), Tailwind CSS v4, Persian RTL (`dir="rtl"`), Vazirmatn typography, and Jalali calendar formatting (`src/utils/jalali.ts`).
- **Backend:** Node.js + Express (`server.ts`, `src/server/apiRouter.ts`, domain engines under `src/server/`, services under `src/server/services/`, Zod validation under `src/server/validation/`).
- **Database & ORM:** PostgreSQL managed through Prisma ORM (`@prisma/client` / `prisma` v6.4.0, `prisma/schema.prisma`).
- **Authentication & RBAC:** Internal backend authentication; users, roles, permissions, and sessions are managed exclusively in PostgreSQL (`users`, `roles`, `permissions`, `role_permissions`, `audit_logs`).
- **Prohibited External Platform Assumptions:** Do **not** introduce, reference, or preserve Firebase (`firebase`, Firebase Auth, Firestore), Supabase-specific features, or dual-database synchronization assumptions.

---

## 2. Backend-Independent Coding Principles `[ECC-Derived]`

*Sources: `rules/common/coding-style.md`*

- **Immutability (Critical):** Never mutate objects or arrays in place; return new copies (`spread`, `.map()`, `.filter()`). In KPIMS, this prevents side-effect corruption across stock ledger, WIP reconciliation, and MRP calculations.
- **KISS / DRY / YAGNI:**
  - Prefer the simplest solution that satisfies verified requirements.
  - Extract shared helpers when duplication is real; do not create speculative abstractions, factories, or single-caller interfaces (deliberate storage/repository boundaries are acceptable when isolating domain logic from persistence).
- **File & Function Size Discipline:**
  - Prefer cohesive modules (~200–400 lines typical; 800 lines soft maintainability ceiling for new/refactored source files; test scripts and generated files are exempt).
  - Keep functions focused (<50 lines where practical) and avoid nesting deeper than 4 levels by using early returns.
- **Boundary Validation:** Validate every external boundary (HTTP request bodies/params/queries, Excel/CSV imports, environment variables) before passing data into core engines.
- **No Magic Numbers:** Replace unexplained thresholds, timeouts, and limits with named constants.

---

## 3. TypeScript Engineering Standards `[ECC-Derived + KPIMS-Specific]`

*Sources: `rules/typescript/coding-style.md`, `rules/typescript/patterns.md`, `skills/typescript-patterns/SKILL.md`*

- **Explicit Public Types, Inferred Locals `[ECC-Derived]`:**
  - Always annotate parameter and return types on exported functions, shared domain engines, service methods, and API response builders.
  - Let TypeScript infer obvious local variables.
- **Eliminate `any` `[ECC-Derived]`:**
  - Treat `any` as a defect in new code. Use `unknown` at untrusted boundaries and narrow with Zod schemas (`src/server/validation/index.ts`) or type guards.
- **Interfaces vs. Types `[ECC-Derived]`:**
  - Use `interface` for extensible object shapes and shared domain DTOs.
  - Use `type` for discriminated unions, intersections, mapped types, and state machines.
  - Prefer discriminated unions for workflow states (e.g., loading/success/error or document posting results).
- **Async Discipline `[ECC-Derived]`:**
  - Use `Promise.allSettled` for independent fan-out tasks where partial failure must be inspected.
  - Avoid unbounded concurrency; apply timeouts to external I/O and database calls.
- **Consistent API Envelope `[ECC-Derived + KPIMS-Specific]`:**
  - Standardize responses on KPIMS's verified envelope: `{ success: boolean; data?: T; error?: string; meta?: { total?: number; page?: number; limit?: number } }`.
- **Compiler Baseline `[KPIMS-Specific]`:**
  - Every change must pass `npm run lint` (`tsc --noEmit`) with zero errors under `tsconfig.json` (`moduleResolution: "bundler"`, `isolatedModules: true`, `noEmit: true`).
  - Do not introduce circular imports across `src/server/*` engines and `src/types/inventory.ts`.

---

## 4. React & Frontend Standards `[ECC-Derived + KPIMS-Specific]`

*Sources: `rules/react/coding-style.md`, `rules/react/patterns.md`, `skills/react-patterns/SKILL.md`, `skills/frontend-patterns/SKILL.md`, `rules/web/design-quality.md` (Next.js RSC/Server Action sections omitted)*

- **File & Naming Conventions `[ECC-Derived]`:**
  - `.tsx` for any file containing JSX; `.ts` for pure logic, utilities, types, and non-JSX hooks.
  - Components: `PascalCase` (`WipTrackingView.tsx`); custom hooks: `useCamelCase` (`usePersistedCollapse.ts`); contexts: `<Domain>Context` / `<Domain>Provider` / `use<Domain>`.
  - Handlers: `handleX` internally, `onX` as props; booleans: `isLoading`, `hasError`, `canEdit`.
- **Render Purity & Side Effects `[ECC-Derived]`:**
  - Render must be a pure function of props and state — derive totals, filtered lists, and flags during render (or `useMemo` when measurably expensive), never by mirroring state inside `useEffect`.
  - Complete every hook dependency array (`useEffect`, `useMemo`, `useCallback`) to prevent stale closures.
- **State Placement Decision Tree `[ECC-Derived]`:**
  1. Single-component UI state → `useState` / `useReducer`.
  2. Parent + direct children → lift state and pass props.
  3. Low-frequency cross-tree state (auth session, theme, locale) → React Context.
  4. Never misuse Context for high-frequency table/filter updates that cascade re-renders across the entire app.
- **Lists, Keys, Refs & Boundaries `[ECC-Derived]`:**
  - Never use array `index` as `key` for lists that can filter, sort, reorder, insert, or delete — use stable domain IDs (`part.id`, `doc.id`, `op.id`).
  - React 19 allows passing `ref` as a regular prop without `forwardRef`.
  - Wrap major route/workspace views in an Error Boundary so a single panel failure does not crash the entire ERP shell.
- **KPIMS UX & Visual Discipline `[KPIMS-Specific + ECC-Derived]`:**
  - Preserve Persian RTL layout, clear typographic/scale hierarchy, semantic status colors (overdue/bottleneck/warning/healthy), and intentional hover/focus/active states.
  - Preserve KPIMS's operator-first "at-a-glance vital metrics + collapse-all-first with persisted collapse state" pattern across monitoring and operational modules.
  - Avoid `window.alert` / `window.confirm` / `window.open`; use accessible in-app modals/dialogs and toast feedback.

---

## 5. Security Rules `[ECC-Derived + KPIMS-Specific]`

*Sources: `rules/common/security.md`, `rules/typescript/security.md`, `rules/react/security.md`*

- **Secrets & Environment Variables `[ECC-Derived + KPIMS-Specific]`:**
  - Never hardcode passwords, session signing secrets, database URLs, or API keys in source code.
  - Under Vite, only `VITE_*` variables are exposed to the client bundle — **never** place database credentials, auth secrets, or server keys in `VITE_*` variables.
  - Validate required server environment variables at startup and fail loudly if missing in production.
- **Internal PostgreSQL Auth & RBAC Enforcement `[KPIMS-Specific + ECC-Derived]`:**
  - Never trust client-side UI visibility or client-supplied role/userId fields to authorize mutations. Every protected Express route must authenticate the session on the server and verify PostgreSQL `roles` / `permissions` before mutating data.
  - Store session identifiers in `httpOnly`, `SameSite=Lax` (or `Strict`), `Secure` (in production) cookies — never store session tokens or credentials in `localStorage`.
  - Hash passwords with a strong adaptive password hash (e.g., `argon2` or `scrypt`/`bcrypt`) before storing in `users.passwordHash`; never log or return `passwordHash` in any API payload.
  - Prevent self-role escalation: only `ADMIN` (with explicit server-side permission check) may assign or modify user roles/permissions.
- **Input, Injection & XSS Hardening `[ECC-Derived + KPIMS-Specific]`:**
  - Validate all request inputs with Zod schemas (`src/server/validation/`) and reject unknown/ghost fields on privileged writes.
  - Prevent SQL injection strictly via Prisma typed queries or parameterized SQL (`$1, $2`). Never interpolate user input into SQL strings.
  - Never render unsanitized HTML (`dangerouslySetInnerHTML`) or spread unvalidated JSON directly into React state or ORM update payloads (prevents prototype pollution and mass assignment).
  - Preserve CSV/Excel formula injection sanitization (`sanitizeCsvValue`) on all exports/imports.
  - Enforce path/ID validation (`^[a-zA-Z0-9_-]+$` and bounded length) and strict payload size limits where appropriate.
- **Ledger Immutability `[KPIMS-Specific]`:**
  - Posted warehouse and production ledger records (`inventory_documents`, `inventory_transactions`, `audit_logs`) must never be physically deleted or have immutable timestamps (`createdAt`) altered; corrections must be issued strictly via linked reversal/compensating documents.
- **Security Stop Protocol `[ECC-Derived]`:**
  - If a `CRITICAL` security defect is detected (secret exposure, auth bypass, SQLi, RBAC escalation), stop feature work, fix the vulnerability first, rotate any exposed credentials, and scan sibling routes for the same flaw.

---

## 6. Testing & TDD Rules `[ECC-Derived + KPIMS-Specific]`

*Sources: `rules/common/testing.md`, `rules/typescript/testing.md`, `skills/tdd-workflow/SKILL.md`*

- **Red → Green → Refactor Discipline `[ECC-Derived]`:**
  1. Write or extend a failing test reproducing the requirement or bug (**RED**).
  2. Run the test and confirm it fails for the expected reason.
  3. Implement the smallest clean change to pass (**GREEN**).
  4. Refactor while keeping tests green.
- **Structure & Naming `[ECC-Derived]`:**
  - Follow Arrange-Act-Assert (AAA) structure.
  - Use behavior-focused test names (e.g., *"rejects cumulative coil issue exceeding remaining weight"*).
  - Test observable behavior and domain invariants, not private implementation details. Keep tests isolated and deterministic.
- **Mandatory Edge-Case Matrix `[ECC-Derived + KPIMS-Specific]`:**
  - Always test boundary conditions: zero/negative quantities, cumulative overdrafts, partial coil issue/return, transfer reversals, concurrent WIP updates, duplicate/idempotent imports, unauthorized role attempts, and invalid enum/ID inputs.
- **KPIMS Test Runner Preservation `[KPIMS-Specific]`:**
  - Do **not** force a migration to Jest, Vitest, or Playwright unless explicitly approved.
  - Preserve and extend KPIMS's existing `tsx` test suites defined in `package.json` and `scripts/`:
    - `npm test` runs:
      - `tsx scripts/test-inventory.ts`
      - `tsx scripts/test-wip-reconciliation.ts`
      - `tsx scripts/test-production-planning.ts`
      - `tsx scripts/test-management-reports.ts`
    - Additional targeted suites in `scripts/`: `test-first-operation-coil-wip.ts`, `test-inventory-http.ts`, `test-physical-coil-persistence.ts`, `test-planning-customer-orders-http.ts`, `test-relational-planning-read-model.ts`, `test-wip-production-ledger.ts`, `test-wip-snapshot-concurrency.ts`.
  - When fixing a bug or adding domain logic, add assertions to the matching `scripts/test-*.ts` file (or create a new `scripts/test-<domain>.ts`) and record RED → GREEN command output as evidence.

---

## 7. Error Handling Principles `[ECC-Derived + KPIMS-Specific]`

*Sources: `skills/error-handling/SKILL.md`, `rules/common/coding-style.md` (Python/Go/Next.js sections omitted)*

- **Fail Fast and Loudly `[ECC-Derived]`:** Never silently swallow exceptions. Empty `catch {}` blocks or `.catch(() => [])` fallbacks that mask real persistence/validation failures are prohibited unless the fallback is explicitly intentional, bounded, and logged with context.
- **Typed Domain Errors `[ECC-Derived]`:**
  - Prefer typed error classes (`AppError` subclasses with `code`, `statusCode`, and optional structured `details` — e.g., `ValidationError` 400/422, `UnauthorizedError` 401, `ForbiddenError` 403, `NotFoundError` 404, `ConflictError` 409) over raw string throws.
- **Separate User Messages from Server Diagnostics `[ECC-Derived + KPIMS-Specific]`:**
  - Return clear, safe Persian error messages to KPIMS UI clients via `{ success: false, error: "..." }` (never leak stack traces, SQL fragments, or credentials in HTTP responses).
  - Log full structured error context (`route`, `userId`, `entityId`, `errorCode`, stack) on the server.
- **Centralized Express Error Boundary `[KPIMS-Specific + ECC-Derived]`:**
  - Rely on Express error-handling middleware in `server.ts` so `/api/*` routes always return structured JSON (including `400` malformed JSON and `413` oversized payload) rather than HTML error pages.
- **Retry Discipline `[ECC-Derived]`:**
  - Retry only idempotent operations on transient transport failures using bounded exponential backoff; never blindly retry non-idempotent inventory/production postings without an idempotency key.

# KPIMS Verification, Review & Project Memory Kit (Pack C)

> **Purpose:** Operational workflows for verification gates, structured code & security reviews, Architecture Decision Records (ADRs), domain context governance, living documentation, and session handoffs in Google AI Studio.  
> **Runtime Reality:** Google AI Studio does **not** natively execute ECC hooks (`hooks/hooks.json`), slash commands (`/code-review`, `/save-session`), autonomous sub-agents, or `~/.claude/session-data/` daemons. Every procedure in this pack is adapted as an explicit, human-triggered Markdown workflow.  
> **Source Attribution:** Sections are explicitly tagged `[ECC-Derived]` or `[KPIMS-Specific]`.

---

## 1. Six-Phase Verification Workflow `[ECC-Derived + KPIMS-Specific]`

*Source: `skills/verification-loop/SKILL.md` (Python/hook/slash-command sections removed; bound to KPIMS `package.json` scripts)*

Run this verification loop after completing any feature, bug fix, or refactor before treating work as complete:

1. **Phase 1 — Type Check (`npm run lint`) `[KPIMS-Specific]`:**
   - Runs `tsc --noEmit`. Must exit with **0 errors**.
2. **Phase 2 — Build Verification (`npm run build`) `[KPIMS-Specific]`:**
   - Runs `prisma generate && vite build && esbuild server.ts --bundle --platform=node --format=esm --outfile=server.js --packages=external`.
   - If the build fails, **STOP** and fix before continuing.
3. **Phase 3 — Automated Test Suite (`npm test` + targeted `scripts/test-*.ts`) `[KPIMS-Specific]`:**
   - Run `npm test` (`test-inventory.ts`, `test-wip-reconciliation.ts`, `test-production-planning.ts`, `test-management-reports.ts`).
   - Also run any relevant domain/HTTP/concurrency script in `scripts/` (`test-inventory-http.ts`, `test-planning-customer-orders-http.ts`, `test-physical-coil-persistence.ts`, `test-wip-production-ledger.ts`, `test-wip-snapshot-concurrency.ts`, `test-first-operation-coil-wip.ts`, `test-relational-planning-read-model.ts`).
4. **Phase 4 — Security & Hygiene Grep `[ECC-Derived + KPIMS-Specific]`:**
   - Scan modified files for hardcoded secrets/passwords/tokens, accidental `VITE_` secret exposure, unparameterized SQL interpolation, empty `catch {}` blocks, and stray debug `console.log` statements.
   - Verify no Firebase dependencies or references were reintroduced.
5. **Phase 5 — Diff Review `[ECC-Derived]`:**
   - Inspect `git diff --stat` and changed files for unintended edits, scope creep, missing error handling, or schema/API contract drift.
6. **Phase 6 — Target Acceptance Separation `[ECC-Derived]`:**
   - Report local verification separately from target-environment acceptance (`VERIFIED` / `FAILED` / `NOT PERFORMED` / `NOT APPLICABLE`). Passing local build/tests does **not** prove staging/production deployment acceptance.

### Verification Report Template `[ECC-Derived]`
```text
VERIFICATION REPORT
===================
Types (npm run lint):   [PASS/FAIL] (X errors)
Build (npm run build):  [PASS/FAIL]
Tests (npm test):       [PASS/FAIL] (suites run + pass/fail count)
Security & Hygiene:     [PASS/FAIL] (X issues)
Diff Review:            [X files changed — scope verified]
Target Acceptance:      [VERIFIED / FAILED / NOT PERFORMED / NOT APPLICABLE]
Overall Verdict:        [READY / NOT READY]
Issues to Fix:
1. ...
```

---

## 2. Independent Code Review & Silent-Failure Checklist `[ECC-Derived + KPIMS-Specific]`

*Sources: `rules/common/code-review.md`, `agents/code-reviewer.md`, `agents/typescript-reviewer.md`, `agents/react-reviewer.md`, `agents/silent-failure-hunter.md`, `agents/database-reviewer.md`*

Because AI Studio does not automatically spawn independent reviewer sub-agents, run this as a **dedicated review pass** over the diff after implementation.

### 2.1 Severity Levels & Approval Criteria `[ECC-Derived]`
- **CRITICAL (Block):** Must be fixed before completion — hardcoded secrets, SQL injection, auth/RBAC bypass, ledger deletion/corruption, XSS, unvalidated privileged mutations, data-loss migrations.
- **HIGH (Warn / Fix before release):** Swallowed exceptions, missing rollback around multi-step DB writes, N+1 query loops, unbounded queries, React hook rule violations (stale closures, missing deps, index keys on mutable lists), functions >50 lines with deep nesting (>4), missing tests for new business logic.
- **MEDIUM (Info):** Unnecessary re-renders, O(n²) loops over large catalogs, missing memoization, suboptimal indexes.
- **LOW (Note):** Naming clarity, unexplained magic numbers, missing JSDoc on shared utilities.
- **Anti-Noise Filter `[ECC-Derived]`:** Do not fabricate issues to appear thorough. Skip style nitpicks or valid intentional patterns (e.g., explicit `void` fire-and-forget logging or test fixtures with hardcoded expectations).

### 2.2 Silent-Failure Hunt Checklist `[ECC-Derived]`
Check every modified `try/catch`, `.catch()`, and fallback path:
- [ ] No empty `catch {}` or `.catch(() => [])` hiding real DB, validation, or I/O failures.
- [ ] Every fallback logs structured context and surfaces warnings/errors to callers when degraded.
- [ ] Every multi-step PostgreSQL write runs inside a transaction with guaranteed rollback on error.
- [ ] Stack traces and error causes are preserved server-side (no generic error swallowing).

### 2.3 Review Output Format `[ECC-Derived]`
```text
[SEVERITY] Short Title
File: path/to/file.ts:line
Issue: Concrete defect and operational impact.
Fix: Minimal safe remediation.

## Review Summary
| Severity | Count | Status |
|---|---|---|
| CRITICAL | 0 | pass |
| HIGH     | 0 | pass |
| MEDIUM   | 0 | info |
| LOW      | 0 | note |
Verdict: APPROVE / WARNING / BLOCK
```

---

## 3. Security Review Workflow `[ECC-Derived + KPIMS-Specific]`

*Sources: `skills/security-review/SKILL.md` (Solana/blockchain section omitted), `agents/security-reviewer.md`, KPIMS `security_spec.md`*

Trigger a dedicated security review whenever touching authentication, sessions, RBAC (`roles`/`permissions`), `apiRouter.ts`, `server.ts`, Prisma queries, file imports/exports, or environment configuration.

### Mandatory Security Audit Checklist
1. **Authentication & Session Safety `[KPIMS-Specific + ECC-Derived]`:**
   - [ ] All protected routes verify internal PostgreSQL-backed sessions server-side (no client-only route gating).
   - [ ] Session cookies use `httpOnly`, `SameSite`, and `Secure` (production); no tokens in `localStorage`.
   - [ ] Passwords hashed with strong adaptive algorithm; `passwordHash` excluded from every query projection and API response.
2. **RBAC & Object-Level Authorization `[KPIMS-Specific + ECC-Derived]`:**
   - [ ] Route checks explicit PostgreSQL permission/role (e.g., `ADMIN`, `PRODUCTION_MANAGER`, `WAREHOUSE_KEEPER`, `QC_INSPECTOR`, `LINE_SUPERVISOR`, `OPERATOR`).
   - [ ] Non-admin users cannot escalate their own `roleId` or modify permissions.
   - [ ] `userId`/`createdById` derived strictly from authenticated session (blocks spoofed author UID).
3. **Input Validation & Injection Defense `[ECC-Derived + KPIMS-Specific]`:**
   - [ ] Request bodies/params validated with Zod schemas; ghost/extra fields stripped or rejected.
   - [ ] All SQL uses Prisma typed APIs or parameterized bindings (`$1, $2`).
   - [ ] Document/entity IDs validated for allowed characters and bounded length (no path traversal).
   - [ ] Excel/CSV imports bounded in size and sanitized against spreadsheet formula injection.
4. **Data & Ledger Invariants `[KPIMS-Specific]`:**
   - [ ] No physical `DELETE` route for posted `InventoryDocument` / `InventoryTransaction` / `AuditLog`.
   - [ ] Immutable fields (`createdAt`, posted voucher numbers) cannot be overwritten on update.
   - [ ] Error responses never expose internal SQL, stack traces, or secrets.
   - [ ] No Firebase or unintended third-party auth bypass remains active once internal auth cutover is complete.
5. **Dependency & Perimeter Hygiene `[ECC-Derived]`:**
   - [ ] Run `npm audit` when dependencies change and review high/critical advisories.
   - [ ] Confirm CORS, CSP, and rate-limiting settings match deployment topology.

---

## 4. Architecture Decision Records (ADRs) `[ECC-Derived + KPIMS-Specific]`

*Sources: `skills/architecture-decision-records/SKILL.md`, `agents/architect.md`*

Record hard-to-reverse technical decisions in numbered Markdown files under `docs/adr/` (create `docs/adr/README.md` as an index once the first ADR is authored).

### When to Create an ADR
- Choosing or replacing core infrastructure (e.g., internal PostgreSQL session strategy, removing legacy Firebase artifacts, splitting `apiRouter.ts`).
- Changing persistence guarantees (e.g., relational source-of-truth vs. snapshot tables, locking strategy for inventory/WIP concurrency).
- Introducing a new dependency, testing framework, or security model.

### Concise ADR Template `[ECC-Derived]`
```markdown
# ADR-NNNN: [Decision Title]

- **Status:** Proposed | Accepted | Superseded by ADR-XXXX
- **Date:** YYYY-MM-DD

## Context
What architectural pressure, requirement, or bug forced this decision?

## Decision
What concrete choice was made and what is explicitly out of scope?

## Alternatives Considered
- **Option A:** Summary — why rejected.
- **Option B:** Summary — why rejected.

## Consequences
- **Positive:** ...
- **Negative / Trade-offs:** ...
- **Risks & Mitigations:** ...
```

---

## 5. Project Context Management `[ECC-Derived + KPIMS-Specific]`

*Source: `skills/context-and-decisions/SKILL.md`*

Maintain a clear separation between **domain semantics** ("what business terms mean") and **architectural decisions** ("why a technical option was chosen"):

- **Domain Context Artifact (`docs/CONTEXT.md` or glossary section — created only when needed):**
  - Captures stable KPIMS manufacturing terms that frequently cause module-boundary errors (e.g., `PhysicalCoil` vs. `MaterialLot` vs. `StockBalance`; `KG` raw coil/sheet vs. `PCS` blank/WIP/finished good; `ProductionPlan` vs. `ManufacturingOrder` vs. `WorkOrder`; `InventoryDocument` vs. `InventoryTransaction`; reversal voucher vs. physical deletion; Jalali display date vs. UTC stored timestamp).
  - Never dump transient task logs, chat transcripts, or implementation trivia into the domain context file.
- **Decision Handoff Rule:** Whenever a discussion shifts from defining a business term to choosing a hard-to-reverse technical approach, record it as an ADR in `docs/adr/`, not inside the domain glossary.

---

## 6. Living Documentation Governance `[ECC-Derived + KPIMS-Specific]`

*Sources: `skills/living-docs-governance/SKILL.md`, `skills/docs-governance/SKILL.md`*

Prevent documentation rot by assigning clear, non-overlapping roles to KPIMS's existing `/docs/` files instead of spawning duplicate files:

| Role | Purpose | Canonical KPIMS File(s) |
| :--- | :--- | :--- |
| **Constitution** | Non-negotiable coding, security, and verification standards | `docs/engineering/ecc/KPIMS_CORE_RULES.md`, `KPIMS_BACKEND_DB_PLAYBOOK.md`, `KPIMS_VERIFY_AND_MEMORY.md`, `security_spec.md` |
| **System Map** | Current architecture, modules, schema, and runbooks | `docs/ARCHITECTURE.md`, `docs/DATABASE_DATA_DICTIONARY.md`, `docs/PLANNING_POSTGRESQL_PERSISTENCE.md`, `docs/WIP_INVENTORY_LEDGER_INTEGRATION.md`, `docs/database-migration-runbook.md` |
| **Decision History** | Hard-to-reverse technical trade-offs | `docs/adr/ADR-NNNN-*.md` (when established) |
| **Status / Handoff** | Active multi-session work state and blockers | Session handoff note (Section 7) |

### Governance Rules `[ECC-Derived]`
1. **Code & Tests Are Ground Truth:** Documentation is evidence and guidance, never executable truth; when docs disagree with `prisma/schema.prisma`, `package.json`, or `src/server/*`, verify against code first and update the drifted doc.
2. **Update Only the Affected Role:** After changing a schema table or API flow, update the corresponding System Map doc (e.g., `DATABASE_DATA_DICTIONARY.md` or `ARCHITECTURE.md`) rather than writing a new standalone summary file.
3. **Track Intentional Removals:** Explicitly record intentional removals (such as Firebase removal) in ADRs/context so future sessions do not accidentally recreate removed integrations.

---

## 7. Session Handoff Procedure (AI Studio Adapted) `[ECC-Derived + KPIMS-Specific]`

*Sources: `commands/save-session.md`, `commands/resume-session.md` (`~/.claude/session-data/` paths and slash commands replaced with portable Markdown handoff blocks)*

Because Google AI Studio sessions compact or reset without ECC's local filesystem hooks, produce this fixed handoff block at the end of any multi-turn engineering session (store in your task tracker or an optional repo-local handoff note if desired):

```markdown
# KPIMS Session Handoff — YYYY-MM-DD

## Objective
2–3 sentences describing the current feature/refactor and its business goal.

## Current State
- **Verified Working:** [list completed items + commands verified (`npm run lint`, `npm test`, `npm run build`)]
- **In Progress:** [exact file paths and remaining work]
- **Not Started:** [planned untouched items]

## Decisions Made
- [Decision] — [brief rationale / ADR reference]

## What Did NOT Work (Do Not Retry)
- [Failed approach] — [exact error/root cause] *(Write "None" if empty; never omit this section.)*

## Open Questions / Blockers
- [Unresolved requirement, schema question, or access dependency]

## Exact Next Step
[Single concrete, actionable starting instruction for the next session.]
```

### Resuming Protocol `[ECC-Derived]`
When starting a new AI Studio session with a handoff block:
1. Verify referenced files still exist on disk before editing.
2. Respect every entry under **What Did NOT Work** to avoid repeating dead ends.
3. Confirm the **Exact Next Step** with the user before making code or schema modifications.

# PostgreSQL / Prisma Migration Runbook

## Current status

The application schema is PostgreSQL-backed, but the repository does not yet contain a reviewed, committed Prisma migration history. CI therefore generates an **initial migration preview** from `prisma/schema.prisma`, applies it to a disposable PostgreSQL database, and uploads the SQL as the `prisma-initial-migration-preview` artifact.

This preview is a verification artifact, not yet an approved production migration.

## CI validation

The CI workflow performs the following database checks:

1. Validate `prisma/schema.prisma`.
2. Generate SQL from an empty database to the current Prisma schema.
3. Apply that generated SQL with `prisma migrate deploy` to a clean PostgreSQL 16 service.
4. Upload the generated SQL for review.
5. Run the application build, seed checks, and regression tests against the migrated database.

A successful CI run proves that the current schema can be created from scratch through Prisma Migrate. It does **not** prove that an existing database can safely adopt the migration.

## Before approving the initial migration

- Download and inspect the CI migration artifact.
- Review table, index, foreign-key, enum, default, and nullability changes against the actual deployed database.
- Identify any data transformations or destructive operations. Do not assume a schema-generated initial migration preserves existing data.
- Test the exact migration against a disposable copy of the target database.
- Take and verify a restorable backup before any production database operation.

## Existing database baseline (not an automatic deployment step)

The current application may already have tables created with `prisma db push`. Never run the initial migration against such a database as if it were empty: the generated `CREATE TABLE` statements would conflict with existing objects.

After the reviewed initial migration has been committed to `prisma/migrations`, and only after confirming that the existing database schema is equivalent to that migration:

1. Take a verified backup.
2. Confirm the migration directory name and the exact deployed database.
3. Mark the baseline as already applied with `prisma migrate resolve --applied <migration_directory_name>`.
4. Run `prisma migrate status` and verify that the database is up to date.
5. Do not use `migrate resolve` to conceal schema drift or missing objects. Reconcile differences explicitly first.

For a genuinely empty database, use `prisma migrate deploy` to create the schema from the committed migration history.

## Future schema changes

- Create and review migrations in a development database using `prisma migrate dev --name <descriptive_name>`.
- Commit the generated migration SQL together with the corresponding Prisma schema change.
- CI must apply the committed migrations to a clean PostgreSQL database using `prisma migrate deploy`; it must not regenerate the baseline as a substitute for committed history.
- Production deployment uses `prisma migrate deploy`, never `prisma migrate dev` or `prisma db push`.
- Prisma Migrate does not provide an automatic general-purpose rollback. Prefer a tested forward-fix migration; restore from a verified backup when a data/schema rollback is required.

## PostgreSQL `NULLS NOT DISTINCT` Constraint Protection (`stock_balances`)

`StockBalance` enforces composite uniqueness over `(partId, warehouseId, locationId, materialLotId, physicalCoilId, ownership, contractId, qualityStatus)` where four key columns (`locationId`, `materialLotId`, `physicalCoilId`, `contractId`) are nullable.

- **Prisma 6 limitation:** Prisma 6's `@@unique([...])` schema syntax cannot natively represent PostgreSQL 15+'s `NULLS NOT DISTINCT` clause. Standard PostgreSQL unique indexes treat `NULL != NULL`, which allows duplicate `stock_balances` rows whenever nullable key columns are `NULL`.
- **Authoritative DDL:** Migration `20261125070000_inventory_p0a_constraints_and_ledger_hardening` replaces `"stock_balances_partId_warehouseId_locationId_materialLotId__key"` with `CREATE UNIQUE INDEX ... NULLS NOT DISTINCT` (supported on PostgreSQL >= 15; live target is PostgreSQL 17.11).
- **Drift hazard:** Running `prisma migrate dev`, `prisma migrate diff`, or `prisma db push` can detect index-option drift and auto-generate SQL that drops and recreates `"stock_balances_partId_warehouseId_locationId_materialLotId__key"` **without** `NULLS NOT DISTINCT`.
- **Mandatory guardrails:**
  1. **Never** run `prisma db push` against staging or production databases.
  2. Inspect every newly generated migration SQL file and remove any accidental drop/recreate of `"stock_balances_partId_warehouseId_locationId_materialLotId__key"` that omits `NULLS NOT DISTINCT`.
  3. Run `npm run verify:migrations` locally and in CI on every schema or migration change. The verifier parses `prisma/migrations/*/migration.sql` chronologically and fails with a non-zero exit code if `NULLS NOT DISTINCT` is removed or downgraded.

## Scope of this stage

This stage establishes migration generation and clean-database validation. It does not authorize production migration, baseline resolution, or merging the working branch into `main`. Those require review of the generated SQL and a separate test against a copy of the real database.

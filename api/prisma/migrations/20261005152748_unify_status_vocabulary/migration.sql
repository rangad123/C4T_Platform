-- Unify status vocabulary across User, TesterProfile and Organisation to
-- the same four values: PENDING, ACTIVE, SUSPENDED, ARCHIVED.
--
-- RENAME VALUE / ADD VALUE are plain, non-destructive Postgres operations —
-- no rename-recreate-cast dance needed here, unlike the earlier migration
-- that removed TesterStatus values.
ALTER TYPE "UserStatus" RENAME VALUE 'PENDING_VERIFICATION' TO 'PENDING';
ALTER TYPE "UserStatus" RENAME VALUE 'DEACTIVATED' TO 'ARCHIVED';
ALTER TABLE "users" ALTER COLUMN "status" SET DEFAULT 'PENDING';

ALTER TYPE "TesterStatus" RENAME VALUE 'APPLIED' TO 'PENDING';
ALTER TYPE "TesterStatus" RENAME VALUE 'VERIFIED' TO 'ACTIVE';
ALTER TYPE "TesterStatus" ADD VALUE 'ARCHIVED';
ALTER TABLE "tester_profiles" ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- TesterProfile had no soft-delete column, unlike User/Organisation. Needed
-- for the same "hidden by default, reachable via an explicit filter"
-- behavior an archived tester now gets.
ALTER TABLE "tester_profiles" ADD COLUMN "deleted_at" TIMESTAMP(3);

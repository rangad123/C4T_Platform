-- Remove UNDER_REVIEW and REJECTED from TesterStatus.
--
-- Tester onboarding is fully automatic (email verification alone promotes
-- APPLIED -> VERIFIED); there is no upfront admin review to reject out of.
-- SUSPENDED remains as the one admin-triggered moderation action.
--
-- Safe: confirmed zero rows hold either value before writing this migration.
-- The USING cast below would fail loudly at migration time if that were ever
-- no longer true, which is the correct behavior.
ALTER TYPE "TesterStatus" RENAME TO "TesterStatus_old";
CREATE TYPE "TesterStatus" AS ENUM ('APPLIED', 'VERIFIED', 'SUSPENDED');
ALTER TABLE "tester_profiles" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "tester_profiles" ALTER COLUMN "status" TYPE "TesterStatus" USING ("status"::text::"TesterStatus");
ALTER TABLE "tester_profiles" ALTER COLUMN "status" SET DEFAULT 'APPLIED';
DROP TYPE "TesterStatus_old";

-- rejection_reason was only ever written when rejecting an application, which
-- can no longer happen.
ALTER TABLE "tester_profiles" DROP COLUMN "rejection_reason";

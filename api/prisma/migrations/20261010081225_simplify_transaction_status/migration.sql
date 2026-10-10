-- Collapse TransactionStatus from six values to two: PENDING, PAID.
--
-- The three-stage approve/release workflow (APPROVED, RELEASED) and the two
-- payout failure states (FAILED, CANCELLED) are gone. New rule: a
-- TESTER_EARNING row credits the wallet the moment it exists, regardless of
-- status; a TESTER_PAYOUT row only debits the wallet once it reaches PAID.
-- See `payoutBalance()` in `transactions.routes.ts`.
--
-- Existing rows at a removed value are remapped before the cast, since
-- unlike the TesterStatus precedent this one isn't starting from zero:
--   APPROVED / RELEASED -> PAID (further along than Pending; for an earning
--     this no longer changes any calculation either way).
--   FAILED / CANCELLED  -> PAID. There is no terminal-bad bucket left in a
--     two-value enum; remapping to PENDING would wrongly reopen a resolved,
--     unsuccessful payout as a live request blocking a new one, which is the
--     worse of the two inaccuracies.
UPDATE "transactions" SET "status" = 'PAID' WHERE "status" IN ('APPROVED', 'RELEASED', 'FAILED', 'CANCELLED');

ALTER TYPE "TransactionStatus" RENAME TO "TransactionStatus_old";
CREATE TYPE "TransactionStatus" AS ENUM ('PENDING', 'PAID');
ALTER TABLE "transactions" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "transactions" ALTER COLUMN "status" TYPE "TransactionStatus" USING ("status"::text::"TransactionStatus");
ALTER TABLE "transactions" ALTER COLUMN "status" SET DEFAULT 'PENDING';
DROP TYPE "TransactionStatus_old";

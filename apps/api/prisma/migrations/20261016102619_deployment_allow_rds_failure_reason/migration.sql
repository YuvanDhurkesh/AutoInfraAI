-- AlterTable
ALTER TABLE "deployments" ADD COLUMN     "allowRds" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "failureReason" TEXT;

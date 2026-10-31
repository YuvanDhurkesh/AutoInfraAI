-- AlterTable
ALTER TABLE "job_logs" ADD COLUMN     "seq" SERIAL NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "job_logs_seq_key" ON "job_logs"("seq");


-- Per-field origin map (SRS ENG-003 / Appendix E), written by ingestion.
-- field name -> { provenance, conversionMethod, evidence }
ALTER TABLE "jobs" ADD COLUMN "provenance" JSONB;

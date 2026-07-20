-- The send ledger is append-only: blocked and failed attempts are part of the
-- audit trail and must never be rewritten. Reuses promoter_forbid_mutation().

CREATE TRIGGER send_log_append_only
	BEFORE UPDATE OR DELETE ON "send_log"
	FOR EACH ROW EXECUTE FUNCTION promoter_forbid_mutation();

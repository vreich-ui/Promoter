-- The lesson store is append-only: what the machine learned is an audit trail
-- and must never be rewritten. A lesson later acted on gets a new row that
-- references it. Reuses promoter_forbid_mutation().

CREATE TRIGGER lesson_append_only
	BEFORE UPDATE OR DELETE ON "lesson"
	FOR EACH ROW EXECUTE FUNCTION promoter_forbid_mutation();

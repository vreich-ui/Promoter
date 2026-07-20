-- The behavioral event stream is append-only, like outcome and
-- policy_version. Reuses promoter_forbid_mutation() from 0001.

CREATE TRIGGER event_append_only
	BEFORE UPDATE OR DELETE ON "event"
	FOR EACH ROW EXECUTE FUNCTION promoter_forbid_mutation();

-- Append-only enforcement for `outcome` and `policy_version`.
-- A BEFORE UPDATE OR DELETE trigger raises an exception, so rows in these
-- tables can only ever be inserted.

CREATE OR REPLACE FUNCTION promoter_forbid_mutation() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'table % is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
		USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER outcome_append_only
	BEFORE UPDATE OR DELETE ON "outcome"
	FOR EACH ROW EXECUTE FUNCTION promoter_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER policy_version_append_only
	BEFORE UPDATE OR DELETE ON "policy_version"
	FOR EACH ROW EXECUTE FUNCTION promoter_forbid_mutation();

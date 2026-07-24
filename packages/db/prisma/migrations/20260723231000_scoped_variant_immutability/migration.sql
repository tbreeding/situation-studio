CREATE TRIGGER scoped_artifact_variants_immutable
BEFORE UPDATE OR DELETE ON "scoped_artifact_variants"
FOR EACH ROW EXECUTE FUNCTION studio_reject_immutable_mutation();

CREATE OR REPLACE FUNCTION studio_reject_sensitive_audit_payload()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.payload::text ~* '"[^"]*(password|secret|token|credential|authorization|cookie)[^"]*"[[:space:]]*:'
  THEN
    RAISE EXCEPTION 'sensitive audit payload key is forbidden'
      USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_events_sensitive_payload_guard
BEFORE INSERT ON "audit_events"
FOR EACH ROW EXECUTE FUNCTION studio_reject_sensitive_audit_payload();

"""Make the audit log append-only in the database itself (PostgreSQL only).

The model already refuses edits and deletes through the ORM (AuditLog.save /
.delete and AuditLogQuerySet). This trigger closes the gap below the ORM: any
UPDATE or DELETE on accounts_auditlog is rejected, except the single update
Django needs when a user account is deleted (on_delete=SET_NULL clears
user_id and must leave every other column untouched).

SQLite (local development and tests) has no equivalent and is skipped. The
database owner can still drop the trigger — this protects against application
bugs and a compromised app connection, not against the DBA.
"""
from django.db import migrations

CREATE = """
CREATE OR REPLACE FUNCTION accounts_auditlog_append_only() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'audit log entries cannot be deleted';
    END IF;
    IF NEW.user_id IS NULL
       AND NEW.id = OLD.id AND NEW.action = OLD.action
       AND NEW.entity_type = OLD.entity_type AND NEW.entity_id = OLD.entity_id
       AND NEW.description = OLD.description
       AND NEW.ip_address IS NOT DISTINCT FROM OLD.ip_address
       AND NEW.created_at = OLD.created_at THEN
        RETURN NEW;   -- the user account was deleted (on_delete=SET_NULL)
    END IF;
    RAISE EXCEPTION 'audit log entries cannot be edited';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS accounts_auditlog_append_only ON accounts_auditlog;
CREATE TRIGGER accounts_auditlog_append_only
    BEFORE UPDATE OR DELETE ON accounts_auditlog
    FOR EACH ROW EXECUTE FUNCTION accounts_auditlog_append_only();
"""

DROP = """
DROP TRIGGER IF EXISTS accounts_auditlog_append_only ON accounts_auditlog;
DROP FUNCTION IF EXISTS accounts_auditlog_append_only();
"""


def forwards(apps, schema_editor):
    if schema_editor.connection.vendor == "postgresql":
        schema_editor.execute(CREATE)


def backwards(apps, schema_editor):
    if schema_editor.connection.vendor == "postgresql":
        schema_editor.execute(DROP)


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0007_mfa_totp"),
    ]

    operations = [
        migrations.RunPython(forwards, backwards),
    ]

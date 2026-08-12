-- Authentication schema. Run: psql -U postgres -h localhost -d protogy -f auth_schema.sql
CREATE TABLE IF NOT EXISTS app_users (
    username      TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ
);
GRANT SELECT, INSERT, UPDATE ON app_users TO protogy_app;

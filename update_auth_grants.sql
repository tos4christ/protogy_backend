-- Run once on existing installs: psql -U postgres -h localhost -d protogy -f update_auth_grants.sql
GRANT DELETE ON app_users TO protogy_app;

-- Ephemeral CI only. The container bootstrap user is a superuser; permission
-- regressions must instead run as the same kind of owning role as deployment.
CREATE ROLE atelier_ci LOGIN PASSWORD 'isolated_ci_role_only'
  NOSUPERUSER NOCREATEROLE NOREPLICATION NOBYPASSRLS CREATEDB;
CREATE DATABASE atelier_ci OWNER atelier_ci;

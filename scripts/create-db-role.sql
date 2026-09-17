-- Creates database `farmenta` and the role the indexer connects as, on the Postgres server
-- it shares with lp-monitor-v2 (spec §13). Run once, as a superuser:
--
--   psql -U postgres -f scripts/create-db-role.sql
--
-- The role is created WITHOUT a password, so nothing secret passes through argv, shell
-- history or this file. It cannot log in until a superuser sets one interactively:
--
--   psql -U postgres -c '\password farmenta_indexer'
--
-- The role must not be able to read `lpmon`. Postgres grants CONNECT on every database to
-- PUBLIC by default, so creating a separate role is not enough: that default is revoked on
-- `lpmon` and handed back to the roles that already own things there.

CREATE ROLE farmenta_indexer LOGIN
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;

CREATE DATABASE farmenta OWNER farmenta_indexer;

-- `farmenta`: only its owner connects.
REVOKE ALL ON DATABASE farmenta FROM PUBLIC;

-- `lpmon`: keep every role that owns a table there, then close the PUBLIC door.
\connect lpmon
SELECT format('GRANT CONNECT ON DATABASE lpmon TO %I', owner)
FROM (
  SELECT DISTINCT tableowner AS owner FROM pg_tables
  WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
  UNION
  SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = 'lpmon'
) AS owners
\gexec
REVOKE CONNECT ON DATABASE lpmon FROM PUBLIC;

-- Proof for FAR-33. This must fail with
--   FATAL: permission denied for database "lpmon"
--
--   psql -h 127.0.0.1 -U farmenta_indexer -d lpmon -c 'select 1'     (prompts for the password)

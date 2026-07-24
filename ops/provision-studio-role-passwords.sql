\set ON_ERROR_STOP on

-- Run from the postgres maintenance database after grant-runtime-roles.sql.
-- Passwords are supplied through the process environment and never stored.
\getenv web_password SITUATION_STUDIO_WEB_DATABASE_PASSWORD
\getenv review_password SITUATION_STUDIO_REVIEW_DATABASE_PASSWORD
\getenv publisher_password SITUATION_STUDIO_PUBLISHER_DATABASE_PASSWORD
\getenv backup_inspector_password SITUATION_STUDIO_BACKUP_INSPECTOR_DATABASE_PASSWORD
\getenv backup_operator_password SITUATION_STUDIO_BACKUP_OPERATOR_DATABASE_PASSWORD

SELECT 1 / (
  length(:'web_password') >= 32
  AND length(:'review_password') >= 32
  AND length(:'publisher_password') >= 32
  AND length(:'backup_inspector_password') >= 32
  AND length(:'backup_operator_password') >= 32
)::integer AS password_length_guard;

SELECT format(
  'ALTER ROLE situation_studio_web PASSWORD %L',
  :'web_password'
)\gexec
SELECT format(
  'ALTER ROLE situation_studio_review_worker PASSWORD %L',
  :'review_password'
)\gexec
SELECT format(
  'ALTER ROLE situation_studio_publisher PASSWORD %L',
  :'publisher_password'
)\gexec
SELECT format(
  'ALTER ROLE situation_studio_backup_inspector PASSWORD %L',
  :'backup_inspector_password'
)\gexec
SELECT format(
  'ALTER ROLE situation_studio_backup_operator PASSWORD %L',
  :'backup_operator_password'
)\gexec

ALTER ROLE situation_studio_web SET statement_timeout = '30s';
ALTER ROLE situation_studio_review_worker SET statement_timeout = '2min';
ALTER ROLE situation_studio_publisher SET statement_timeout = '2min';
ALTER ROLE situation_studio_backup_inspector
  SET default_transaction_read_only = on;
ALTER ROLE situation_studio_backup_inspector SET statement_timeout = '30s';
ALTER ROLE situation_studio_backup_operator SET statement_timeout = '10min';

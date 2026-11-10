-- Reverse of 001_init.sql. Drops every object the forward migration created.
-- This destroys all data: it exists for rolling back a bad deploy on a fresh
-- environment, not as a routine operation.
DROP TABLE IF EXISTS studio_sessions;
DROP TABLE IF EXISTS roblox_accounts;
DROP TABLE IF EXISTS provider_credentials;
DROP TABLE IF EXISTS build_events;
DROP TABLE IF EXISTS builds;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS users;

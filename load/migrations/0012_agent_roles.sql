-- The health agent's two database roles.
--   ayuos_agent_ro: every tool query and every model-written query. Read-only
--     by default, 15 s statement limit, sees only the agent views (they run
--     with the owner's rights, so no grant on the raw schemas is needed).
--   ayuos_agent_rw: the agent's own logs and memory, nothing else.
-- Passwords are never written here: the app generates them, keeps them in the
-- macOS Keychain and sets them with ALTER ROLE at startup (agent/db.ts).
-- Grants are re-applied on every run because 0011 recreates the views.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ayuos_agent_ro') THEN
    CREATE ROLE ayuos_agent_ro LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ayuos_agent_rw') THEN
    CREATE ROLE ayuos_agent_rw LOGIN;
  END IF;
END $$;

ALTER ROLE ayuos_agent_ro SET default_transaction_read_only = on;
ALTER ROLE ayuos_agent_ro SET statement_timeout = '15s';
ALTER ROLE ayuos_agent_ro SET search_path = agent;
ALTER ROLE ayuos_agent_ro SET timezone = 'UTC';
ALTER ROLE ayuos_agent_rw SET statement_timeout = '15s';
ALTER ROLE ayuos_agent_rw SET search_path = agent;
ALTER ROLE ayuos_agent_rw SET timezone = 'UTC';

GRANT USAGE ON SCHEMA agent TO ayuos_agent_ro, ayuos_agent_rw;

-- Read role: every v_* view, plus the settings and offset tables that the
-- view functions (include_sandbox, local_ts) read with the caller's rights.
DO $$
DECLARE rel record;
BEGIN
  FOR rel IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'agent' AND c.relkind IN ('v', 'm') AND c.relname LIKE 'v\_%'
  LOOP
    EXECUTE format('GRANT SELECT ON agent.%I TO ayuos_agent_ro', rel.relname);
  END LOOP;
END $$;
GRANT SELECT ON agent.user_settings, agent.tz_history, agent.metric_catalog TO ayuos_agent_ro;
REVOKE ALL ON agent.conversations, agent.turns, agent.tool_runs, agent.feedback,
              agent.memory_facts, agent.example_library, agent.note_text, agent.note_chunks
  FROM ayuos_agent_ro;

-- Write role: INSERT/UPDATE/DELETE only on the agent-owned log and memory tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON agent.conversations, agent.turns, agent.tool_runs, agent.feedback,
                                        agent.memory_facts, agent.example_library TO ayuos_agent_rw;
GRANT SELECT ON agent.user_settings, agent.tz_history, agent.metric_catalog TO ayuos_agent_rw;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA agent TO ayuos_agent_rw;

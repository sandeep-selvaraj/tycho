// Never edit a shipped migration; add a new file.
export default /* sql */ `
-- What the harness last reported: 'running' (mid-turn) or 'idle' (waiting for the user), and as of when.
ALTER TABLE sessions ADD COLUMN activity TEXT;
ALTER TABLE sessions ADD COLUMN activity_at TEXT;

-- Placeholder conversations (Cursor writes one per opened chat tab) were ingested as empty sessions.
DELETE FROM sessions
WHERE title IS NULL AND parent_session_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.session_id = sessions.id)
  AND NOT EXISTS (SELECT 1 FROM tool_calls t WHERE t.session_id = sessions.id)
  AND NOT EXISTS (SELECT 1 FROM usage_events u WHERE u.session_id = sessions.id)
  AND NOT EXISTS (SELECT 1 FROM sessions c WHERE c.parent_session_id = sessions.id);
`;

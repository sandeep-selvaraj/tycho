// Never edit a shipped migration; add a new file.
export default /* sql */ `
-- What the harness last reported: 'running' (mid-turn) or 'idle' (waiting for the user), and as of when.
ALTER TABLE sessions ADD COLUMN activity TEXT;
ALTER TABLE sessions ADD COLUMN activity_at TEXT;
`;

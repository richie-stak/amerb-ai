const db = require('./db');

// Long-term memory: short facts a user asked AMERB AI to remember, shown to the model at the start
// of every conversation that user has. Kept deliberately small — every memory costs context-window
// space on every single message, so a cap stops it crowding out the actual conversation.
const MAX_MEMORIES_PER_USER = 50;
const MAX_MEMORY_LENGTH = 300;

function listMemories(userId) {
  return db
    .prepare('SELECT id, content, created_at FROM user_memories WHERE user_id = ? ORDER BY id ASC')
    .all(userId);
}

// Returns { memory } on success or { error } with a message fit to show the user (or the model).
function addMemory(userId, content) {
  const text = String(content || '').trim().replace(/\s+/g, ' ').slice(0, MAX_MEMORY_LENGTH);
  if (!text) return { error: 'Nothing to remember.' };

  const existing = listMemories(userId);
  const duplicate = existing.find((m) => m.content.toLowerCase() === text.toLowerCase());
  if (duplicate) return { memory: duplicate, duplicate: true };
  if (existing.length >= MAX_MEMORIES_PER_USER) {
    return { error: `Memory is full (${MAX_MEMORIES_PER_USER} items). Delete some in Workspace → Memory first.` };
  }

  const result = db.prepare('INSERT INTO user_memories (user_id, content) VALUES (?, ?)').run(userId, text);
  return { memory: db.prepare('SELECT id, content, created_at FROM user_memories WHERE id = ?').get(result.lastInsertRowid) };
}

// The system-prompt block for a user's memories, or null when they have none.
function memoryPrompt(userId) {
  const memories = listMemories(userId);
  if (!memories.length) return null;
  return (
    'Facts about the USER you are talking to (not about you), which they asked you to remember in earlier ' +
    'conversations. Use them where relevant, and refer to them as "you" (e.g. "You work in Credit"). ' +
    "Don't recite them back unprompted:\n" +
    memories.map((m) => `- The user: ${m.content}`).join('\n')
  );
}

module.exports = { listMemories, addMemory, memoryPrompt, MAX_MEMORIES_PER_USER };

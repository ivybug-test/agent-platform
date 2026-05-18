/** System prompt for the user-memory extraction LLM call. The user side
 *  of the conversation (recent messages, existing memories, tombstones)
 *  is composed by the caller and passed as the user role.
 *
 *  Phase α M2: every CREATE action now MUST carry sourceMessageId +
 *  evidenceQuote. The worker substring-validates evidenceQuote against
 *  the actual message identified by sourceMessageId before writing.
 *  Without these, fabricated facts can't be cited later, which is the
 *  whole point of the upgrade. */
export function buildExtractionPrompt(
  language: string,
  nowIso: string
): string {
  return `You analyze user messages to extract memorable facts about the user.

LANGUAGE (HIGHEST PRIORITY — follow before any other rule):
The user's recent messages are predominantly in ${language}. EVERY fact you
output MUST be written in ${language}. Do NOT translate. Do NOT use English
unless the user is writing in English.
Examples (match the user's language):
  - Chinese user: "喜欢吃辣", "住在深圳", "弟弟叫志龙"
  - English user: "Likes spicy food", "Lives in Shenzhen", "Has a brother named Zhilong"

TIME (SECOND HIGHEST PRIORITY):
Current time is ${nowIso}. Each recent message below has a [YYYY-MM-DD HH:mm]
prefix showing when it was sent, and a (msgId=...) marker identifying the
exact message.
- NEVER store relative phrases like "今天" / "昨天" / "刚才" / "中午" / "上周" /
  "yesterday" / "just now" inside the fact content. Resolve them into an
  absolute date based on the message's own timestamp and the current time.
- For facts that describe a specific event in time (e.g. "今天没吃午饭" → "2026-04-19 没吃午饭"),
  ALSO emit an \`eventAt\` field on the CREATE action as an ISO8601 timestamp
  (date is fine, e.g. "2026-04-19"; add time if the user was specific about
  "中午" etc.). For timeless facts (identity, preferences, relationships)
  leave eventAt omitted.
- Short-term statements that are ONLY meaningful for a few hours (e.g.
  "我饿了", "现在有点累") must be SKIPPED — they are not worth cross-session
  memory. If the same behaviour recurs across many days, a higher-level fact
  ("经常不吃午饭") will emerge from reinforcement; you don't need to seed it.

PROVENANCE (HARD CONSTRAINT — actions without it are rejected):
Every CREATE action MUST include both:
  - sourceMessageId: one of the (msgId=...) values from the recent messages
    below. This is the message that primarily evidences the fact.
  - evidenceQuote: a verbatim substring (≤120 chars) FROM THAT message that
    directly supports the fact. The substring must appear character-for-
    character inside the message body — DO NOT paraphrase, translate, or
    rewrite the quote. The backend substring-checks it; mismatches are
    dropped on the floor.
If no single message in the recent window cleanly supports a fact, DO NOT
emit a CREATE for it — that means you'd be guessing. UPDATE and DELETE
actions should also include sourceMessageId + evidenceQuote when the new
evidence comes from a recent message (it usually does); these aren't
strictly required but are strongly preferred.

RULES:
- Only extract facts that would be useful to remember across conversations
- DO NOT extract: greetings, test messages, emotional expressions, single-word responses, questions the user asked the AI, commands to the AI, transient states
- DO extract: personal info (name, age, location, language), preferences (food, music, hobbies), relationships (family, friends mentioned by name), significant events, opinions, ongoing situations
- Each fact must be a single clear statement in third person (e.g. "喜欢吃辣" / "Likes spicy food", NOT first person)
- If a new fact contradicts an existing memory, output an UPDATE action with the existing memory's id
- If a new fact is already captured by an existing memory, SKIP it. Be strict — if in doubt, SKIP rather than duplicate. The backend will still reinforce the existing memory on near-duplicate CREATEs, so skipping is safe.
- If a fact is genuinely new, output a CREATE action
- If an existing memory is clearly wrong based on new info, output a DELETE action

HARD CONSTRAINTS (violating these will be rejected):
- FORGOTTEN FACTS: The user has explicitly asked to forget some facts. They are listed under "Forgotten facts". NEVER re-create any fact that is semantically similar to a forgotten one, even if the conversation mentions it again. If unsure, skip.
- LOCKED MEMORIES: Memories marked [LOCKED] were set or confirmed by the user directly. You MUST NOT output UPDATE or DELETE actions for locked memory ids. You may output CREATE for genuinely new facts that do not conflict.
- PENDING MEMORIES: Memories marked [PENDING] were written by someone else about this user and are waiting for the user's confirmation. Treat them exactly like active memories for dedup purposes: if a new message would just restate a pending fact, SKIP (do not emit a duplicate CREATE). You MUST NOT output UPDATE or DELETE actions for pending memory ids either — the subject has to confirm or reject them through the UI.

OUTPUT FORMAT (strict JSON):
{
  "actions": [
    {"action": "create", "content": "...", "category": "identity|preference|relationship|event|opinion|context", "importance": "high|medium|low", "sourceMessageId": "<uuid from a (msgId=...) above>", "evidenceQuote": "verbatim substring from that message", "eventAt": "2026-04-19" },
    {"action": "update", "memoryId": "<uuid>", "content": "updated content", "category": "...", "importance": "...", "sourceMessageId": "<uuid>", "evidenceQuote": "..."},
    {"action": "delete", "memoryId": "<uuid>", "reason": "...", "sourceMessageId": "<uuid>", "evidenceQuote": "..."}
  ]
}
(eventAt is OPTIONAL and only appears on CREATE; omit it for timeless facts.
sourceMessageId + evidenceQuote are REQUIRED on CREATE, recommended on UPDATE/DELETE.)

If nothing worth remembering, return: {"actions": []}

CATEGORY GUIDE:
- identity: name, age, location, nationality, language, occupation, education
- preference: food, hobbies, interests, communication style preferences
- relationship: family members, friends, colleagues mentioned by name or role
- event: significant things that happened, decisions made, milestones — these almost always want eventAt
- opinion: views on topics, beliefs, values
- context: current projects, goals, ongoing situations

IMPORTANCE GUIDE:
- high: core identity (name, language), strong/repeated preferences, important relationships
- medium: mentioned preferences, events, moderate context
- low: one-time mentions, minor details, casual opinions. Time-stamped single-event facts default to low/medium — they'll gain strength naturally if they recur.`;
}

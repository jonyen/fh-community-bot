const SYSTEM_PROMPT_FIX = `You are a facilities/maintenance assistant. A user reported an issue. If this is a trivial issue with a common fix, suggest a short actionable fix the reporter can try themselves. If it requires professional attention, say so briefly. Keep it under 3 sentences.`;

const SYSTEM_PROMPT_DEDUP = `You are a duplicate issue detector. Given a new issue report and a list of existing open issues, determine if the new report is about the same problem as any existing issue. If it matches an existing issue, respond with ONLY the ID number. If it does not match any, respond with ONLY the word "none". Do not explain.`;

const SYSTEM_PROMPT_DIGEST = `Summarize these outstanding maintenance issues for a weekly update post in Slack. Group by priority/area if possible. Be concise and actionable. Use Slack formatting (bold with *, bullet lists).`;

const SYSTEM_PROMPT_CLASSIFY = `You are a strict facilities/maintenance request classifier. Determine if a message is a genuine maintenance or facilities issue report — something specific that is broken, leaking, malfunctioning, dirty, or needing repair or replacement.

Respond "no" for:
- Greetings, small talk, or test messages (e.g. "hi", "hello", "test", "hey")
- General questions, chitchat, or off-topic messages
- Vague messages with no identifiable maintenance issue

Respond "yes" ONLY if the message describes a specific physical/facilities problem.

Respond with ONLY "yes" or "no". Do not explain.`;

export function createOllamaService(client) {
  async function suggestFix(issueDescription) {
    try {
      const res = await client.chat.completions.create({
        model: "gemma3:1b",
        messages: [
          { role: "system", content: SYSTEM_PROMPT_FIX },
          { role: "user", content: issueDescription },
        ],
        max_tokens: 256,
      });
      return res.choices[0].message.content;
    } catch {
      return null;
    }
  }

  async function checkDuplicate(newDescription, openIssues) {
    try {
      const issueList = openIssues
        .map((i) => `ID ${i.id}: ${i.description}`)
        .join("\n");

      const res = await client.chat.completions.create({
        model: "gemma3:1b",
        messages: [
          { role: "system", content: SYSTEM_PROMPT_DEDUP },
          {
            role: "user",
            content: `New report: "${newDescription}"\n\nExisting open issues:\n${issueList}`,
          },
        ],
        max_tokens: 32,
      });

      const answer = res.choices[0].message.content.trim().toLowerCase();
      if (answer === "none") return null;
      const matchedId = answer.match(/\d+/)?.[0];
      return matchedId && openIssues.some((i) => i.id === matchedId)
        ? matchedId
        : null;
    } catch {
      return null;
    }
  }

  async function generateDigest(openIssues) {
    try {
      const res = await client.chat.completions.create({
        model: "gemma3:1b",
        messages: [
          { role: "system", content: SYSTEM_PROMPT_DIGEST },
          { role: "user", content: JSON.stringify(openIssues) },
        ],
        max_tokens: 1024,
      });
      return res.choices[0].message.content;
    } catch {
      return null;
    }
  }

  function isObviouslyNotMaintenance(text) {
    const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
    const junkPatterns = [
      /^(test|testing|tset|tsetign)$/,
      /^(hi|hello|hey|yo|sup|hola|howdy)$/,
      /^(ok|okay|yes|no|yep|nope|sure|thanks|ty|thx)$/,
      /^(lol|lmao|haha|heh|hmm|wow|bruh|nice)$/,
      /^(ping|pong|check|checking)$/,
      /^just (a )?test(ing)?$/,
      /^is (this|it) (working|on|live|up)(\?)?$/,
      /^(does this work|are you there|hello world|foo ?bar|asdf+|aaa+)$/,
    ];
    return junkPatterns.some((p) => p.test(normalized));
  }

  async function isMaintenanceRequest(text) {
    if (isObviouslyNotMaintenance(text)) return false;

    try {
      const res = await client.chat.completions.create({
        model: "gemma3:1b",
        messages: [
          { role: "system", content: SYSTEM_PROMPT_CLASSIFY },
          { role: "user", content: text },
        ],
        max_tokens: 8,
      });
      return res.choices[0].message.content.trim().toLowerCase().startsWith("yes");
    } catch {
      // If classification fails, assume it's a valid request to avoid blocking real issues
      return true;
    }
  }

  return { suggestFix, checkDuplicate, generateDigest, isMaintenanceRequest };
}

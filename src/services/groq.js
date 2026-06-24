const SYSTEM_PROMPT_FIX = `You are a facilities/maintenance assistant. A user reported an issue. If this is a trivial issue with a common fix, suggest a short actionable fix the reporter can try themselves. If it requires professional attention, say so briefly. Keep it under 3 sentences. Do not suggest submitting a work order or contacting management — that is already being handled.`;

const SYSTEM_PROMPT_DEDUP = `You are a duplicate issue detector. Given a new issue report and a list of existing open issues, determine if the new report is about the same problem as any existing issue. If it matches an existing issue, respond with ONLY the ID number. If it does not match any, respond with ONLY the word "none". Do not explain.`;


const SYSTEM_PROMPT_CLASSIFY = `You are a strict facilities/maintenance request classifier. Determine if a message is a genuine maintenance or facilities issue report — something specific that is broken, leaking, malfunctioning, dirty, or needing repair or replacement.

Respond "no" for:
- Greetings, small talk, or test messages (e.g. "hi", "hello", "test", "hey")
- General questions, chitchat, or off-topic messages
- Vague messages with no identifiable maintenance issue

Respond "yes" ONLY if the message describes a specific physical/facilities problem.

Respond with ONLY "yes" or "no". Do not explain.`;

const SYSTEM_PROMPT_RESERVATION = `You convert a community member's message in a reservations channel into JSON. The reference date is provided. Output ONLY a JSON object with keys: intent, target (the room or resource name as written, or null), date (YYYY-MM-DD or null), startTime (e.g. "7:00 PM" or null), endTime (or null), what (short purpose or null), who (group/person or null).

Choose intent:
- "reserve": the person wants to BOOK a room (e.g. "book the MPR friday 7-10pm", "can I reserve the childcare room saturday for cleaning").
- "check": the person asks whether a room is FREE/AVAILABLE for a SPECIFIC time they have in mind. Only use "check" when a specific time or time range is given or clearly intended (e.g. "is the MPR free friday 7-10pm?", "is the staff suite open at 2pm tuesday?").
- "list": the person wants to SEE what is scheduled — whether or when a room is being used over a day or a period, with NO specific booking time (e.g. "is the MPR being used this weekend?", "what's booked in the MPR friday", "anything in the childcare room next week?", "when is the staff suite used?").
- "history": the person asks who/when/where a resource was LAST used or who has it (e.g. "who used the speaker set last?", "when was Tech Set 1 last used?", "where's the popcorn machine?"). target is the resource name.
- "none": the message is not about reservations (greetings, thanks, off-topic chat).

Resolve relative dates ("friday", "this weekend", "next week") against the reference date; if a single date cannot capture it, use the nearest relevant date or null. Output no prose, only JSON.`;

export function createGroqService(client) {
  async function suggestFix(issueDescription) {
    try {
      const res = await client.chat.completions.create({
        model: "llama-3.3-70b-versatile",
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
        model: "llama-3.3-70b-versatile",
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
        model: "llama-3.3-70b-versatile",
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

  async function parseReservationRequest(text, referenceDateIso) {
    try {
      const res = await client.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: SYSTEM_PROMPT_RESERVATION },
          { role: "user", content: `Reference date: ${referenceDateIso}\nMessage: ${text}` },
        ],
        max_tokens: 256,
      });
      const raw = res.choices[0].message.content.trim();
      const jsonStart = raw.indexOf("{");
      const jsonEnd = raw.lastIndexOf("}");
      if (jsonStart === -1 || jsonEnd === -1) return null;
      return JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
    } catch {
      return null;
    }
  }

  return { suggestFix, checkDuplicate, isMaintenanceRequest, parseReservationRequest };
}

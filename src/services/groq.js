const SYSTEM_PROMPT_FIX = `You are a facilities/maintenance assistant. A user reported an issue. If this is a trivial issue with a common fix, suggest a short actionable fix the reporter can try themselves. If it requires professional attention, say so briefly. Keep it under 3 sentences. Do not suggest submitting a work order or contacting management — that is already being handled.`;

const SYSTEM_PROMPT_DEDUP = `You are a duplicate issue detector. Given a new issue report and a list of existing open issues, determine if the new report is about the same problem as any existing issue. If it matches an existing issue, respond with ONLY the ID number. If it does not match any, respond with ONLY the word "none". Do not explain.`;


const SYSTEM_PROMPT_CLASSIFY = `You are a strict facilities/maintenance request classifier. Determine if a message is a genuine maintenance or facilities issue report — something specific that is broken, leaking, malfunctioning, dirty, or needing repair or replacement.

Respond "no" for:
- Greetings, small talk, or test messages (e.g. "hi", "hello", "test", "hey")
- General questions, chitchat, or off-topic messages
- Vague messages with no identifiable maintenance issue

Respond "yes" ONLY if the message describes a specific physical/facilities problem.

Respond with ONLY "yes" or "no". Do not explain.`;

const SYSTEM_PROMPT_RESERVATION = `You convert a community member's message in a community OneStop channel into JSON. The reference date is provided. Output ONLY a JSON object with keys: intent, target (the room or resource name as written, or null), date (YYYY-MM-DD or null), startTime (e.g. "7:00 PM" or null), endTime (or null), what (short purpose or null), who (group/person or null).

Choose intent:
- "reserve": the person wants to BOOK a room (e.g. "book the MPR friday 7-10pm", "can I reserve the childcare room saturday for cleaning").
- "check": the person asks whether a room is FREE/AVAILABLE for a SPECIFIC time they have in mind. Only use "check" when a specific time or time range is given or clearly intended (e.g. "is the MPR free friday 7-10pm?", "is the staff suite open at 2pm tuesday?").
- "list": the person wants to SEE what is scheduled — whether/when/who is using a room over a day or period, or right now, with NO specific booking time they want to reserve (e.g. "is the MPR being used this weekend?", "who is using the MPR now?", "who's in the staff suite right now?", "what's booked in the MPR friday", "anything in the childcare room next week?"). Present-tense "who is using X now / right now" is "list" (set date to today, no startTime/endTime).
- "history": the person asks who/when/where a resource was LAST used or who has it (e.g. "who used the speaker set last?", "when was Tech Set 1 last used?", "where's the popcorn machine?"). target is the resource name.
- "info": the person asks for OneStop REFERENCE information that is NOT a room/resource booking or schedule — door/lock codes, links, zoom links, duty rotations ("who's on lockup this week?"), interhigh sites ("where does IH Cabin John meet?"), cleaning assignments, categories, or who is in charge of something (e.g. "what's the door code?", "zoom link for AYM?", "who runs the travel workspace?"). Room/resource availability or scheduling stays check/list/reserve/history; off-topic chatter stays none.
- "none": the message is not about reservations (greetings, thanks, off-topic chat).

Resolve relative dates ("friday", "this weekend", "next week") against the reference date; if a single date cannot capture it, use the nearest relevant date or null. Output no prose, only JSON.`;

const SYSTEM_PROMPT_CHOICE = `The user was shown a numbered list of options and asked to pick. Given the options and the user's reply, decide which options they mean. The reply may be a number ("1"), a name ("tech set 2"), an ordinal ("the first one"), several ("1 and 3", "the first two"), or all of them ("all", "everything", "all of them"). Output ONLY JSON: {"selection": [<the exact option strings the user means, copied verbatim from the list>]}. If they mean all options, include every option. If the reply does not clearly select any option, return an empty array. Output only JSON.`;

const SYSTEM_PROMPT_INFO = `You answer questions for an FH community ("OneStop") using ONLY the provided OneStop reference data. Quote the specific value(s) that answer the question (e.g. a code, a link, a name). If the answer is not present in the data, reply exactly: "I don't see that in OneStop." Never invent, guess, or use outside knowledge. Keep the answer short.`;

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

  // Given the options the bot offered in a disambiguation question and the
  // user's reply, return the subset of options the user means (one, several, or
  // all). Returns [] when the reply doesn't clearly select any. The returned
  // strings are validated back against `options` (exact, case-insensitive).
  async function chooseCandidates(options, reply) {
    if (!Array.isArray(options) || options.length === 0) return [];
    try {
      const res = await client.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: SYSTEM_PROMPT_CHOICE },
          {
            role: "user",
            content: `Options:\n${options.map((o, i) => `${i + 1}. ${o}`).join("\n")}\n\nReply: ${reply}`,
          },
        ],
        max_tokens: 256,
      });
      const raw = res.choices[0].message.content.trim();
      const jsonStart = raw.indexOf("{");
      const jsonEnd = raw.lastIndexOf("}");
      if (jsonStart === -1 || jsonEnd === -1) return [];
      const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
      const selection = Array.isArray(parsed.selection) ? parsed.selection : [];
      // validate each pick back to a real option (exact, case-insensitive)
      return selection
        .map((s) => options.find((o) => o.toLowerCase() === String(s).toLowerCase()))
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  async function answerInfoQuestion(question, corpus) {
    try {
      const res = await client.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: SYSTEM_PROMPT_INFO },
          { role: "user", content: `OneStop data:\n${corpus}\n\nQuestion: ${question}` },
        ],
        max_tokens: 400,
      });
      return res.choices[0].message.content.trim();
    } catch {
      return "Can't reach OneStop right now.";
    }
  }

  return { suggestFix, checkDuplicate, isMaintenanceRequest, parseReservationRequest, chooseCandidates, answerInfoQuestion };
}

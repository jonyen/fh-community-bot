const SYSTEM_PROMPT_DEDUP = `You are a duplicate issue detector. Given a new issue report and a list of existing open issues, determine if the new report is about the same problem as any existing issue. If it matches an existing issue, respond with ONLY the ID number. If it does not match any, respond with ONLY the word "none". Do not explain.`;

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

  return { checkDuplicate, parseReservationRequest, chooseCandidates, answerInfoQuestion };
}

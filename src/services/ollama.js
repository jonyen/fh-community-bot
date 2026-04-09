const SYSTEM_PROMPT_FIX = `You are a facilities/maintenance assistant. A user reported an issue. If this is a trivial issue with a common fix, suggest a short actionable fix the reporter can try themselves. If it requires professional attention, say so briefly. Keep it under 3 sentences.`;

const SYSTEM_PROMPT_DEDUP = `You are a duplicate issue detector. Given a new issue report and a list of existing open issues, determine if the new report is about the same problem as any existing issue. If it matches an existing issue, respond with ONLY the ID number. If it does not match any, respond with ONLY the word "none". Do not explain.`;

const SYSTEM_PROMPT_DIGEST = `Summarize these outstanding maintenance issues for a weekly update post in Slack. Group by priority/area if possible. Be concise and actionable. Use Slack formatting (bold with *, bullet lists).`;

const SYSTEM_PROMPT_CLASSIFY = `You are a facilities/maintenance request classifier. Determine if a message is a maintenance or facilities issue report (e.g. something broken, leaking, malfunctioning, dirty, needing repair or replacement). Respond with ONLY "yes" if it is a maintenance request, or "no" if it is not. Do not explain.`;

export function createOllamaService(client) {
  async function suggestFix(issueDescription) {
    try {
      const res = await client.chat.completions.create({
        model: "gemma3:27b",
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
        model: "gemma3:27b",
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
        model: "gemma3:27b",
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

  async function isMaintenanceRequest(text) {
    try {
      const res = await client.chat.completions.create({
        model: "gemma3:27b",
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

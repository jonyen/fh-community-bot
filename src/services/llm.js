import { log, metric } from "../lib/logger.js";

// Claude on Amazon Bedrock. The Lambda's own IAM role authorises the calls,
// so there is no API key to store or let go stale. The model id is an
// inference profile set by the LLM_MODEL_ID environment variable, so moving
// to a newer model is a config change.
//
// Every call here fails soft (null), so a dead model looks exactly like a
// model with no opinion: that is how Groq retiring Llama 3.3 went unnoticed.
// Each failure therefore emits LlmCallFailed, which alarms in Slack.
export const DEFAULT_MODEL = "us.anthropic.claude-haiku-4-5-20251001-v1:0";

const SYSTEM_PROMPT_DEDUP = `You are a duplicate issue detector. Given a new issue report and a list of existing open issues, determine if the new report is about the same problem as any existing issue. If it matches an existing issue, respond with ONLY the ID number. If it does not match any, respond with ONLY the word "none". Do not explain.`;

const SYSTEM_PROMPT_TRIAGE = `You triage maintenance reports for a community building. Given one report, output ONLY a JSON object: {"type": <type or null>, "severity": <severity or null>}.

The values are pre-filled into a form the reporter is about to submit, so a wrong value is worse than no value — people accept a filled-in field without reading it. Use null for anything the report does not make clear.

Never use "Other" for a report you cannot place; use null. "Other" is only for a report that clearly describes something none of the other types cover.

Severity:
- "Critical": someone's safety is at risk, or something the building depends on is unusable — flooding, sewage, fire, smoke, a gas smell, exposed live wiring, someone trapped, no heat or no water.
- "Medium": it stops something being used normally but is not dangerous.
- "Minor": cosmetic or an inconvenience; it can wait.
Judge the situation described, not how upset the reporter sounds. If the report does not say enough to place it, use null.

Output only the JSON object, no prose.`;

const SYSTEM_PROMPT_LANDLORD = `You turn a maintenance report written by a tenant's members, often casually in a group chat, into a service request for the building's landlord. Output ONLY a JSON object: {"title": <string>, "description": <string>}.

- title: a short, specific summary of the problem, under 80 characters, no trailing period. Example: "Leaking faucet in 2nd floor women's restroom".
- description: clear, polite, factual prose a maintenance technician can act on. Say what is wrong, where, and since when, using only details in the report.

Rules:
- Never add facts the report does not state: no guessed locations, causes, dates or urgency.
- Keep every concrete detail the report gives: room, floor, fixture, symptoms, timing, what was already tried.
- Drop chat filler, jokes, slang, emoji, @-mentions, people's names and complaints about the landlord.
- Do not add a greeting, sign-off, severity, urgency or reporter line.

Output only the JSON object, no prose.`;

export function createLlmService(client, { model = DEFAULT_MODEL } = {}) {
  // One request, text back. Throws on API errors and on a reply with no
  // text, after counting it as a failure.
  async function complete(call, system, userContent, maxTokens) {
    try {
      const res = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: userContent }],
      });
      const text = (res.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      if (!text) throw new Error(`empty reply (stop_reason ${res.stop_reason})`);
      return text;
    } catch (err) {
      metric("LlmCallFailed", 1, { dimensions: { Flow: "llm" }, fields: { call, model } });
      log.error("LLM call failed", { call, error: err });
      throw err;
    }
  }

  async function checkDuplicate(newDescription, openIssues) {
    try {
      const issueList = openIssues
        .map((i) => `ID ${i.id}: ${i.description}`)
        .join("\n");

      const answer = (
        await complete(
          "checkDuplicate",
          SYSTEM_PROMPT_DEDUP,
          `New report: "${newDescription}"\n\nExisting open issues:\n${issueList}`,
          64
        )
      ).toLowerCase();
      if (answer === "none") return null;
      const matchedId = answer.match(/\d+/)?.[0];
      return matchedId && openIssues.some((i) => i.id === matchedId)
        ? matchedId
        : null;
    } catch {
      return null;
    }
  }

  // Read the issue type and severity out of a report so the form can come up
  // pre-filled. Returns { type, severity } with either field null when the
  // model won't commit, or null overall when the call fails — the caller needs
  // to tell "the model says it can't tell" apart from "the model never
  // answered". Both labels are validated back against the lists the form
  // actually offers, so a hallucinated category is dropped rather than shown.
  async function classifyIssueReport(text, { types, severities }) {
    if (!String(text || "").trim()) return { type: null, severity: null };
    try {
      const raw = await complete(
        "classifyIssueReport",
        SYSTEM_PROMPT_TRIAGE,
        `Types: ${types.join(", ")}\nSeverities: ${severities.join(", ")}\n\nReport: ${text}`,
        128
      );
      const jsonStart = raw.indexOf("{");
      const jsonEnd = raw.lastIndexOf("}");
      if (jsonStart === -1 || jsonEnd === -1) return null;
      const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
      const pick = (value, allowed) =>
        allowed.find((a) => a.toLowerCase() === String(value ?? "").toLowerCase()) || null;
      return {
        type: pick(parsed.type, types),
        severity: pick(parsed.severity, severities),
      };
    } catch {
      return null;
    }
  }

  // Rewrites a report into a title and description fit to send the landlord.
  // Returns null when the call fails or the reply isn't usable, so the caller
  // can fall back to the report as written.
  async function writeLandlordTicket(text, { type } = {}) {
    if (!String(text || "").trim()) return null;
    try {
      const raw = await complete(
        "writeLandlordTicket",
        SYSTEM_PROMPT_LANDLORD,
        `${type ? `Issue type: ${type}\n\n` : ""}Report: ${text}`,
        1024
      );
      const jsonStart = raw.indexOf("{");
      const jsonEnd = raw.lastIndexOf("}");
      if (jsonStart === -1 || jsonEnd === -1) return null;
      const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
      const title = String(parsed.title ?? "").trim();
      const description = String(parsed.description ?? "").trim();
      if (!title || !description) return null;
      return { title, description };
    } catch {
      return null;
    }
  }

  return {
    checkDuplicate,
    classifyIssueReport,
    writeLandlordTicket,
  };
}

import { ISSUE_TYPES, SEVERITIES } from "../lib/maintenance-form.js";
import { classifyIssue as classifyByKeyword } from "../lib/issue-classify.js";

// Reads the issue type and severity out of the reporter's own words so the
// form comes up pre-filled.
//
// The model does the reading. `llmService` is anything exposing
// classifyIssueReport(text, { types, severities }) — swapping Groq for another
// provider means writing that one method, not touching this file or its
// callers.
//
// The keyword table is a fallback for when the model is unreachable, not a
// second opinion: a model that answers with a null is saying it can't tell,
// and that judgement is the whole point of the feature. Overriding it with a
// keyword guess would put exactly the wrong value in front of the reporter.
export function createIssueClassifierService(llmService) {
  async function classify(text) {
    const empty = { type: null, severity: null };
    if (!String(text || "").trim()) return empty;

    if (llmService?.classifyIssueReport) {
      try {
        const result = await llmService.classifyIssueReport(text, {
          types: ISSUE_TYPES,
          severities: SEVERITIES,
        });
        if (result) return { type: result.type ?? null, severity: result.severity ?? null };
      } catch (err) {
        console.error("classifyIssueReport failed:", err.message);
      }
    }

    return classifyByKeyword(text);
  }

  return { classify };
}

function normalize(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
}

function getKeywords(text) {
  const stopWords = new Set(["the", "a", "an", "is", "in", "on", "at", "to", "for", "of", "and", "or", "not", "it", "my", "our", "this", "that", "again", "still", "very", "just", "been", "has", "have", "was", "are", "but", "with"]);
  const conditionWords = new Set(["broken", "broke", "leaking", "leak", "leaks", "clogged", "stuck", "jammed", "noisy", "loud", "damaged", "cracked", "loose", "missing", "dirty", "stained", "worn", "rusty", "moldy", "wet", "flooded", "overflowing", "running", "dripping", "squeaky", "wobbly", "peeling", "chipped", "dented", "scratched", "flickering", "dead", "stopped", "working", "works", "work", "needs", "need", "repair", "fix", "fixed", "replace", "replaced", "broken", "busted", "faulty", "defective", "malfunctioning"]);
  return normalize(text)
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w) && !conditionWords.has(w));
}

function keywordOverlap(a, b) {
  const setA = new Set(getKeywords(a));
  const wordsB = getKeywords(b);
  if (setA.size === 0 || wordsB.length === 0) return 0;
  const matches = wordsB.filter((w) => setA.has(w)).length;
  return matches / Math.min(setA.size, wordsB.length);
}

const KEYWORD_THRESHOLD = 0.5;

export function createDedupService(groqService) {
  async function findDuplicate(newDescription, openIssues) {
    if (openIssues.length === 0) return null;

    // Pass 1: keyword overlap
    let bestMatch = null;
    let bestScore = 0;
    for (const issue of openIssues) {
      const score = keywordOverlap(newDescription, issue.description);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = issue;
      }
    }

    if (bestScore >= KEYWORD_THRESHOLD && bestMatch) {
      return { id: bestMatch.id, confident: true };
    }

    // Pass 2: AI check (last 20)
    const recent = openIssues.slice(-20);
    const matchedId = await groqService.checkDuplicate(newDescription, recent);
    if (matchedId) {
      return { id: matchedId, confident: false };
    }

    return null;
  }

  return { findDuplicate };
}

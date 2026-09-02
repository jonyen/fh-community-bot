import { ISSUE_TYPES, SEVERITIES } from "./maintenance-form.js";

// Best-effort read of the type and severity out of the reporter's own words so
// the form comes up pre-filled. Deliberately conservative: a guess is only
// offered when one category clearly beats every other, so a report that reads
// ambiguously ("water pouring out of the AC unit") leaves the dropdown empty
// rather than seeding a wrong answer the reporter has to notice and undo.
//
// Keyword matching, not an LLM call: this runs on the path that posts the form
// in the thread, where a second round-trip to Groq would show up as a visible
// delay, and where a wrong guess is worse than no guess.

const TYPE_KEYWORDS = {
  Lighting: [
    "light", "lights", "lighting", "light bulb", "light bulbs", "lightbulb",
    "lightbulbs", "bulb", "bulbs", "lamp", "lamps", "lamppost", "fluorescent",
    "sconce", "sconces", "chandelier", "floodlight", "floodlights",
    "exit sign", "exit signs", "night light", "ballast", "light switch",
    "light fixture", "light fixtures", "no lighting",
  ],
  Elevator: ["elevator", "elevators", "escalator", "escalators"],
  "Pest Control": [
    "pest", "pests", "pest control", "exterminator", "infestation", "infested",
    "roach", "roaches", "cockroach", "cockroaches", "mouse", "mice", "rat",
    "rats", "rodent", "rodents", "ant", "ants", "termite", "termites",
    "bed bug", "bed bugs", "bedbug", "bedbugs", "wasp", "wasps", "wasp nest",
    "hornet", "hornets", "bee", "bees", "beehive", "spider", "spiders",
    "silverfish", "gnat", "gnats", "fruit flies", "flies", "mosquito",
    "mosquitos", "mosquitoes", "flea", "fleas", "maggots", "bug", "bugs",
    "insect", "insects", "squirrel", "squirrels", "raccoon", "raccoons",
    "possum", "opossum",
  ],
  Electrical: [
    "electrical", "electric", "electricity", "outlet", "outlets", "socket",
    "sockets", "breaker", "breakers", "circuit breaker", "circuit", "fuse",
    "fuse box", "wiring", "wire", "wires", "voltage", "no power",
    "power outage", "power is out", "power went out", "lost power",
    "power out", "sparking", "sparks", "sparked", "shocked me",
    "electric shock", "electrocuted", "exposed wire", "exposed wires",
    "live wire", "extension cord", "short circuit", "shorting out",
  ],
  Plumbing: [
    "plumbing", "plumber", "toilet", "toilets", "sink", "sinks", "faucet",
    "faucets", "drain", "drains", "drainage", "pipe", "pipes", "leak",
    "leaks", "leaking", "leaky", "shower", "showers", "showerhead", "bathtub",
    "tub", "urinal", "urinals", "clog", "clogs", "clogged", "backed up",
    "overflowing", "overflowed", "sewage", "sewer", "septic", "flush",
    "flushing", "won t flush", "water heater", "hot water", "no hot water",
    "water pressure", "water main", "water leak", "running water",
    "garbage disposal", "sump pump", "spigot", "hose bib", "dripping",
    "standing water",
  ],
  HVAC: [
    "hvac", "heat", "heating", "heater", "no heat", "furnace", "boiler",
    "thermostat", "air conditioning", "air conditioner", "air conditioned",
    "ac unit", "ac", "a c unit", "ventilation", "vent", "vents", "duct",
    "ducts", "ductwork", "radiator", "radiators", "cooling", "chiller",
    "air handler", "too hot", "too cold", "freezing in", "stuffy", "humidity",
    "airflow", "no air", "blowing hot air", "blowing cold air", "condenser",
    "swamp cooler",
  ],
  Janitorial: [
    "janitorial", "janitor", "custodial", "custodian", "trash", "garbage",
    "garbage can", "garbage cans", "trash can", "trash cans", "litter",
    "dumpster", "dumpsters", "recycling", "cleaning", "needs cleaning",
    "not been cleaned", "dirty", "filthy", "mess", "messy", "spill",
    "spilled", "vomit", "vacuum", "vacuuming", "mop", "mopped", "sweep",
    "swept", "paper towels", "toilet paper", "soap dispenser", "hand soap",
    "graffiti", "cobwebs", "dust", "dusty", "smells bad", "odor",
  ],
  // "Other" is never guessed - it is the answer you pick when nothing fits,
  // and that judgement belongs to the reporter, not to a keyword table.
};

const SEVERITY_KEYWORDS = {
  Critical: [
    "emergency", "urgent", "urgently", "asap", "immediately", "right away",
    "dangerous", "danger", "hazard", "hazardous", "unsafe", "safety hazard",
    "flood", "flooding", "flooded", "fire", "smoke", "smells like gas",
    "gas leak", "sparking", "sparks", "exposed wire", "exposed wires",
    "live wire", "electrocuted", "sewage", "burst", "trapped", "stuck inside",
    "someone is stuck", "injured", "injury", "critical", "severe",
    "no heat", "no power", "no hot water", "out of service", "unusable",
    "can t use", "cannot use", "whole building", "entire building",
  ],
  Medium: ["medium", "medium priority", "moderate", "moderately"],
  Minor: [
    "minor", "small", "slight", "slightly", "cosmetic", "tiny", "a little",
    "no rush", "no hurry", "not urgent", "non urgent", "low priority",
    "whenever", "when you get a chance", "when someone has time",
    "eventually", "nothing urgent", "not a big deal", "not a huge deal",
  ],
};

// Lowercase, fold punctuation to spaces, and pad with spaces so every keyword
// can be matched as a whole-word span. "A/C" and "won't" survive as "a c" and
// "won t", which is why the tables above spell them that way.
function normalize(text) {
  return ` ${String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()} `;
}

// Longest keyword first, so "water heater" is scored as Plumbing and the
// "heater" inside it is not also scored as HVAC.
function buildIndex(table) {
  return Object.entries(table)
    .flatMap(([label, keywords]) => keywords.map((keyword) => ({ label, keyword })))
    .sort((a, b) => b.keyword.length - a.keyword.length);
}

const TYPE_INDEX = buildIndex(TYPE_KEYWORDS);
const SEVERITY_INDEX = buildIndex(SEVERITY_KEYWORDS);

function score(text, index) {
  // Matched spans are blanked out (not deleted) so the word boundaries around
  // them stay intact for the keywords still to be tried.
  let remaining = normalize(text);
  const scores = new Map();

  for (const { label, keyword } of index) {
    const span = ` ${keyword} `;
    let hit = false;
    let at = remaining.indexOf(span);
    while (at !== -1) {
      hit = true;
      remaining =
        remaining.slice(0, at + 1) +
        " ".repeat(keyword.length) +
        remaining.slice(at + 1 + keyword.length);
      at = remaining.indexOf(span);
    }
    if (hit) scores.set(label, (scores.get(label) || 0) + 1);
  }

  return scores;
}

// A guess only counts when a single label outscores every other one. A tie
// means the message pulls in two directions, which is exactly the "hard to
// tell" case - return null and let the reporter choose.
function bestLabel(scores) {
  let best = null;
  let bestScore = 0;
  let runnerUp = 0;

  for (const [label, value] of scores) {
    if (value > bestScore) {
      runnerUp = bestScore;
      bestScore = value;
      best = label;
    } else if (value > runnerUp) {
      runnerUp = value;
    }
  }

  return bestScore > runnerUp ? best : null;
}

export function classifyIssueType(text) {
  const guess = bestLabel(score(text, TYPE_INDEX));
  return ISSUE_TYPES.includes(guess) ? guess : null;
}

export function classifySeverity(text) {
  const guess = bestLabel(score(text, SEVERITY_INDEX));
  return SEVERITIES.includes(guess) ? guess : null;
}

export function classifyIssue(text) {
  return { type: classifyIssueType(text), severity: classifySeverity(text) };
}

// src/lib/bball-categorize.js
// Turns a roll-call's reactions into an In / Out / Maybe roster. In beats Out
// beats Maybe when one person used several emoji.

const IN_EMOJI = new Set(["basketball", "+1", "white_check_mark"]);
const OUT_EMOJI = new Set(["x", "-1", "nope"]);

function slotFor(name) {
  // Skin-tone and other modifiers arrive as "name::modifier".
  const base = (name || "").split("::")[0];
  if (IN_EMOJI.has(base)) return "in";
  if (OUT_EMOJI.has(base)) return "out";
  return "maybe";
}

export function categorize(reactions, botUserId) {
  const byUser = new Map();

  for (const { name, users = [] } of reactions) {
    const slot = slotFor(name);
    for (const user of users) {
      if (user === botUserId) continue;
      const current = byUser.get(user);
      if (!current) {
        byUser.set(user, slot);
        continue;
      }
      if (current === "in") continue;
      if (current === "out" && slot === "in") byUser.set(user, "in");
      if (current === "maybe" && (slot === "in" || slot === "out")) {
        byUser.set(user, slot);
      }
    }
  }

  const result = { in: [], out: [], maybe: [] };
  for (const [user, slot] of byUser) result[slot].push(user);
  return result;
}

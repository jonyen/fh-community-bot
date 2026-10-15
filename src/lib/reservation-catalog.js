// src/lib/reservation-catalog.js
// Every bookable thing across the three backends, so the parser can be told
// exactly what exists and every answer can be checked back against it.
import { ROOMS } from "./rooms-catalog.js";

export const CATEGORY_NAMES = {
  rooms: "Rooms", kitchen: "Kitchen", tech: "Tech", sports: "Sports", outreach: "Outreach", accessories: "Accessories", vehicles: "Vehicles",
};

// Who a member should ask when Google refuses their account (no edit access
// to a sheet, or not allowed to book a resource). From the OneStop Links tab.
export const CATEGORY_OWNERS = {
  rooms: "Management", kitchen: "Arie Chen", tech: "Alan Chow",
  sports: "Joe Pagan", outreach: "Joe Pagan", accessories: "the equipment team",
};

// Vehicles each have their own coordinator (OneStop Links tab).
const ITEM_OWNERS = { Airstream: "Brandon Lenz", "CP Transit": "Mark Yeh" };

export function ownerFor(item) {
  return ITEM_OWNERS[item.label] || CATEGORY_OWNERS[item.category] || "the equipment team";
}

export function buildCatalog({ rooms, kitchen, rms }) {
  return [
    ...(rooms ? ROOMS.map((r) => ({ label: r.name, category: "rooms", backend: "rooms" })) : []),
    ...(kitchen ? [{ label: "Kitchen", category: "kitchen", backend: "kitchen" }] : []),
    ...(rms || []),
  ];
}

export function findItem(catalog, label) {
  const key = String(label || "").trim().toLowerCase();
  return catalog.find((e) => e.label.toLowerCase() === key) || null;
}

export function catalogPromptText(catalog) {
  return Object.entries(CATEGORY_NAMES)
    .map(([id, name]) => [name, catalog.filter((e) => e.category === id).map((e) => e.label)])
    .filter(([, labels]) => labels.length > 0)
    .map(([name, labels]) => `${name}: ${labels.join(", ")}`)
    .join("\n");
}

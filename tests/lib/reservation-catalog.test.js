// tests/lib/reservation-catalog.test.js
import { describe, it, expect } from "vitest";
import { buildCatalog, findItem, catalogPromptText, CATEGORY_OWNERS, CATEGORY_NAMES, ownerFor } from "../../src/lib/reservation-catalog.js";

const RMS = [
  { label: "Tech Set 1", category: "tech", backend: "rms", calendarId: "t1" },
  { label: "Kickball", category: "sports", backend: "rms", calendarId: "k" },
];

describe("reservation catalog", () => {
  it("joins rooms, kitchen and RMS entries", () => {
    const cat = buildCatalog({ rooms: true, kitchen: true, rms: RMS });
    expect(findItem(cat, "mpr")).toEqual({ label: "MPR", category: "rooms", backend: "rooms" });
    expect(findItem(cat, "Kitchen")).toEqual({ label: "Kitchen", category: "kitchen", backend: "kitchen" });
    expect(findItem(cat, "tech set 1")).toEqual(RMS[0]);
    expect(findItem(cat, "projector")).toBeNull();
  });
  it("leaves out backends that are not configured", () => {
    const cat = buildCatalog({ rooms: false, kitchen: false, rms: RMS });
    expect(findItem(cat, "MPR")).toBeNull();
    expect(findItem(cat, "Kitchen")).toBeNull();
  });
  it("lists items per category for the prompt", () => {
    const text = catalogPromptText(buildCatalog({ rooms: true, kitchen: true, rms: RMS }));
    expect(text).toContain("Rooms: L120, MPR");
    expect(text).toContain("Kitchen: Kitchen");
    expect(text).toContain("Tech: Tech Set 1");
    expect(text).toContain("Sports: Kickball");
  });
});

describe("CATEGORY_OWNERS", () => {
  it("names who to ask for each category", () => {
    expect(CATEGORY_OWNERS).toEqual({
      rooms: "Management", kitchen: "Arie Chen", tech: "Alan Chow",
      sports: "Joe Pagan", outreach: "Joe Pagan", accessories: "the equipment team",
    });
  });
});

describe("vehicles", () => {
  const VEH = [
    { label: "Airstream", category: "vehicles", backend: "rms", calendarId: "a" },
    { label: "CP Transit", category: "vehicles", backend: "rms", calendarId: "t" },
  ];
  it("is a category the prompt lists", () => {
    expect(CATEGORY_NAMES.vehicles).toBe("Vehicles");
    expect(catalogPromptText(buildCatalog({ rooms: false, kitchen: false, rms: VEH }))).toBe("Vehicles: Airstream, CP Transit");
  });
  it("names each vehicle's own owner, and category owners otherwise", () => {
    expect(ownerFor(VEH[0])).toBe("Brandon Lenz");
    expect(ownerFor(VEH[1])).toBe("Mark Yeh");
    expect(ownerFor({ label: "Tech Set 1", category: "tech" })).toBe("Alan Chow");
    expect(ownerFor({ label: "X", category: "unknown" })).toBe("the equipment team");
  });
});


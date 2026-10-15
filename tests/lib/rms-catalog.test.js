// tests/lib/rms-catalog.test.js
import { describe, it, expect } from "vitest";
import { buildRmsCatalog, calendarLink } from "../../src/lib/rms-catalog.js";

const RC = {
  "DMV Tech Equipment-G-Tech Set 1": "tech1@resource.calendar.google.com",
  "DMV Sports Equipment-G-Kickball": "kick@resource.calendar.google.com",
  "DMV Sports Equipment-G-Cube Cooler": "cube-s@resource.calendar.google.com",
  "DMV Outreach Supplies-G-Sub soccer": "sub-o@resource.calendar.google.com",
  "DMV Accessories-Sub Soccer": "sub-a@resource.calendar.google.com",
  "DMV Accessories-1-Large chest cooler": "chest@resource.calendar.google.com",
  "DMV Accessories-Cube Cooler 1": "cube1@resource.calendar.google.com",
  "DMV Venues-3-FH MPR (100)": "mpr@resource.calendar.google.com",
  "DMV-Vehicles-Airstream": "air@resource.calendar.google.com",
  "DMV-Vehicles-CP Transit": "transit@resource.calendar.google.com",
};

describe("buildRmsCatalog", () => {
  it("labels and categorises bookable groups, including vehicles, and drops venues", () => {
    const cat = buildRmsCatalog(RC);
    expect(cat).toContainEqual({ label: "Tech Set 1", category: "tech", backend: "rms", calendarId: "tech1@resource.calendar.google.com" });
    expect(cat).toContainEqual({ label: "Kickball", category: "sports", backend: "rms", calendarId: "kick@resource.calendar.google.com" });
    expect(cat).toContainEqual({ label: "Large chest cooler", category: "accessories", backend: "rms", calendarId: "chest@resource.calendar.google.com" });
    expect(cat).toContainEqual({ label: "Airstream", category: "vehicles", backend: "rms", calendarId: "air@resource.calendar.google.com" });
    expect(cat).toContainEqual({ label: "CP Transit", category: "vehicles", backend: "rms", calendarId: "transit@resource.calendar.google.com" });
    expect(cat.some((e) => /MPR/.test(e.label))).toBe(false);
  });
  it("disambiguates duplicate labels with the group name", () => {
    const labels = buildRmsCatalog(RC).map((e) => e.label);
    expect(labels).toContain("Sub soccer (Outreach)");
    expect(labels).toContain("Sub Soccer (Accessories)");
    expect(labels).toContain("Cube Cooler");
    expect(labels).toContain("Cube Cooler 1");
  });
  it("tolerates a missing or bad config", () => {
    expect(buildRmsCatalog(undefined)).toEqual([]);
    expect(buildRmsCatalog("nope")).toEqual([]);
  });
});

describe("calendarLink", () => {
  it("opens the resource calendar", () => {
    expect(calendarLink("a@b")).toBe("https://calendar.google.com/calendar/u/0/r?cid=a%40b");
  });
});

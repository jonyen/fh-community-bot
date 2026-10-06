import { describe, it, expect, vi } from "vitest";
import {
  createRentManagerTwaService,
  buildServiceIssueForm,
  classifySubmitResponse,
  formatOpenDate,
} from "../../src/services/rentManagerTwa.js";

function response({ status = 200, body = "", location, cookies = [] } = {}) {
  const headers = new Headers();
  if (location) headers.set("location", location);
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(status >= 300 && status < 400 ? null : body, { status, headers });
}

function fakePortal(routes) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, init) => {
    const { pathname } = new URL(url);
    const key = `${init.method || "GET"} ${pathname}`;
    calls.push({ key, init });
    const route = routes[key];
    if (!route) throw new Error(`unexpected request ${key}`);
    return typeof route === "function" ? route(init) : response(route);
  });
  return { fetchImpl, calls };
}

const LOGGED_IN = {
  "GET /": { body: "<form id=\"loginform\">", cookies: ["ASP.NET_SessionId=abc; path=/; HttpOnly"] },
  "POST /Shared/Login": { status: 302, location: "/Shared/Home", cookies: ["TWAAuth=xyz; path=/"] },
  "GET /Shared/Home": { body: "<title>Tenant Web Access - Dashboard</title>" },
};

function service(fetchImpl) {
  return createRentManagerTwaService({
    baseUrl: "https://portal.test",
    username: "u@example.com",
    password: "pw",
    phone: "(555)555-0100",
    fetchImpl,
    now: () => new Date("2026-10-06T19:08:50Z"),
  });
}

describe("formatOpenDate", () => {
  it("renders the portal's M/D/YYYY h:mm:ss AM format in local time", () => {
    expect(formatOpenDate(new Date("2026-10-06T19:08:50Z"), "America/New_York")).toBe("10/6/2026 3:08:50 PM");
  });
});

describe("buildServiceIssueForm", () => {
  it("maps a known type straight onto the portal's dropdown", () => {
    const form = buildServiceIssueForm({
      type: "Plumbing", title: "ignored", description: "sink", phone: "p", allowEntry: false, openDate: "d",
    });
    expect(form.get("Title")).toBe("Plumbing");
    expect(form.get("PredefinedTitles")).toBe("Plumbing");
    expect(form.get("IsAllowedToEnter")).toBe("False");
    expect(form.get("PreferredStartTime")).toBe("1/1/0001 12:00:00 AM");
  });

  it("uses the free-text title for Other", () => {
    const form = buildServiceIssueForm({
      type: "Other", title: "Door won't latch", description: "d", phone: "p", allowEntry: true, openDate: "d",
    });
    expect(form.get("PredefinedTitles")).toBe("Other");
    expect(form.get("Title")).toBe("Door won't latch");
    expect(form.get("otherOptionTitle")).toBe("Door won't latch");
    expect(form.get("IsAllowedToEnter")).toBe("True");
  });

  it("adds the attachment hidden fields the portal widget would", () => {
    const form = buildServiceIssueForm({
      type: "HVAC", description: "d", phone: "p", openDate: "d",
      attachments: [{ fileId: 42, fileName: "a.jpg", thumbnailUrl: "t", description: "Photo" }],
    });
    expect(form.get("Attachment0")).toBe("42");
    expect(form.get("DescAttachment0")).toBe("Photo");
    expect(form.get("History0")).toBe("1");
    expect(form.get("FileName0")).toBe("a.jpg");
  });
});

describe("classifySubmitResponse", () => {
  it("treats a redirect to the issue list as created", () => {
    expect(classifySubmitResponse({ url: "https://x/Maintenance/ServiceIssue/List", body: "" }).status).toBe("created");
  });
  it("treats the confirmed re-render as created", () => {
    expect(classifySubmitResponse({ url: "https://x/Maintenance/ServiceIssue/Add", body: "var isConfirmed = true;" }).status).toBe("created");
  });
  it("reports validation errors as failed", () => {
    const body = '<span class="field-validation-error" data-valmsg-for="Phone">The Phone field is required.</span>';
    expect(classifySubmitResponse({ url: "https://x/Add", body })).toEqual({
      status: "failed", reason: "The Phone field is required.",
    });
  });
  it("calls an unrecognised page unknown rather than failed", () => {
    expect(classifySubmitResponse({ url: "https://x/Add", body: "var isConfirmed = false;" }).status).toBe("unknown");
  });
});

describe("createRentManagerTwaService", () => {
  it("logs in, follows the redirect and keeps the cookies", async () => {
    const { fetchImpl, calls } = fakePortal(LOGGED_IN);
    await service(fetchImpl).login();
    const loginPost = calls.find((c) => c.key === "POST /Shared/Login");
    expect(loginPost.init.headers.Cookie).toBe("ASP.NET_SessionId=abc");
    expect(new URLSearchParams(loginPost.init.body).get("Username")).toBe("u@example.com");
    const home = calls.find((c) => c.key === "GET /Shared/Home");
    expect(home.init.headers.Cookie).toBe("ASP.NET_SessionId=abc; TWAAuth=xyz");
  });

  it("throws when the portal shows the login form again", async () => {
    const { fetchImpl } = fakePortal({
      ...LOGGED_IN,
      "POST /Shared/Login": { body: '<form id="loginform">Invalid username or password' },
    });
    await expect(service(fetchImpl).login()).rejects.toThrow(/login failed/);
  });

  it("uploads photos, submits the issue and reports it created", async () => {
    let submitted;
    const { fetchImpl } = fakePortal({
      ...LOGGED_IN,
      "POST /Maintenance/ServiceIssue/UploadAttachment": () =>
        Response.json({ Successful: true, Model: [{ FileID: 7, FileName: "leak.jpg", ThumbnailURL: "/t/7" }] }),
      "POST /Maintenance/ServiceIssue/Add": (init) => {
        submitted = new URLSearchParams(init.body);
        return response({ status: 302, location: "/Maintenance/ServiceIssue/List" });
      },
      "GET /Maintenance/ServiceIssue/List": { body: "list" },
    });

    const result = await service(fetchImpl).submitServiceIssue({
      type: "Plumbing",
      title: "sink",
      description: "sink leaking",
      photos: [
        { buffer: Buffer.from("img"), name: "leak.jpg", mimeType: "image/jpeg" },
        { buffer: Buffer.from("img"), name: "clip.heic", mimeType: "image/heic" },
      ],
    });

    expect(result).toEqual({ status: "created", attachedPhotos: 1, skippedPhotos: 1 });
    expect(submitted.get("Description")).toBe("sink leaking");
    expect(submitted.get("Phone")).toBe("(555)555-0100");
    expect(submitted.get("OpenDate")).toBe("10/6/2026 3:08:50 PM");
    expect(submitted.get("Attachment0")).toBe("7");
  });
});

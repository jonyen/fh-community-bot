// Files service issues with the landlord (CREA LLC) through Rent Manager's
// Tenant Web Access portal. Rent Manager's REST API would be the clean route,
// but CREA's instance returns "You do not have licensing for this product" on
// every endpoint, so this drives the portal's own HTML forms over plain HTTP.
//
// The portal's forms carry no anti-forgery token and validate only in the
// browser, so a cookie jar and form posts are all it takes — no headless
// browser. Each submission logs in fresh: portal sessions expire after 15
// minutes and a Lambda container may sit idle far longer than that.

const DEFAULT_BASE_URL = "https://creallc.twa.rentmanager.com";
const MAX_REDIRECTS = 5;
const TITLE_MAX = 225; // server-side max length of the Issue field
const ALLOWED_PHOTO_TYPES = new Set(["image/gif", "image/jpeg", "image/png"]);
const MAX_PHOTO_BYTES = 5_000_000;

// The portal's own "Issue" dropdown. The bot's issue types were copied from it,
// so a report's type maps across unchanged.
export const TWA_ISSUE_TITLES = [
  "Lighting",
  "Elevator",
  "Other",
  "Pest Control",
  "Electrical",
  "Plumbing",
  "HVAC",
  "Janitorial",
];

function createCookieJar() {
  const cookies = new Map();
  return {
    store(res) {
      const setCookies = res.headers.getSetCookie?.() ?? [];
      for (const raw of setCookies) {
        const pair = raw.split(";")[0];
        const eq = pair.indexOf("=");
        if (eq <= 0) continue;
        cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    },
    header() {
      return [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    },
  };
}

// "10/6/2026 3:08:50 PM" — the format the portal renders into its hidden
// OpenDate field, in the portal's local time.
export function formatOpenDate(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );
  return `${parts.month}/${parts.day}/${parts.year} ${parts.hour}:${parts.minute}:${parts.second} ${parts.dayPeriod}`;
}

export function buildServiceIssueForm({ type, title, description, phone, allowEntry, attachments = [], openDate }) {
  const predefined = TWA_ISSUE_TITLES.includes(type) ? type : "Other";
  const resolvedTitle = (predefined === "Other" ? title || "Other" : predefined).slice(0, TITLE_MAX);

  const form = new URLSearchParams({
    OpenDate: openDate,
    Phone: phone,
    Title: resolvedTitle,
    PredefinedTitles: predefined,
    otherOptionTitle: predefined === "Other" ? resolvedTitle : predefined,
    Description: description,
    PropertyHasPet: "False",
    HasPets: "False",
    IsAllowedToEnter: allowEntry ? "True" : "False",
    IsSchedule: "False",
    IsAllowScheduling: "False",
    PreferredStartTime: "1/1/0001 12:00:00 AM",
    PreferredEndTime: "1/1/0001 12:00:00 AM",
    Alternate1StartTime: "",
    Alternate1EndTime: "",
    Alternate2StartTime: "",
    Alternate2EndTime: "",
  });

  // Mirrors the hidden inputs the portal's attachment widget injects. All
  // photos share one description, so they form a single history group (1).
  attachments.forEach((a, i) => {
    form.append(`Attachment${i}`, String(a.fileId));
    form.append(`DescAttachment${i}`, a.description);
    form.append(`History${i}`, "1");
    form.append(`ThumbnailURL${i}`, a.thumbnailUrl || "");
    form.append(`FileName${i}`, a.fileName);
  });

  return form;
}

// Classifies the page the portal returns after an Add post. Not yet observed
// against a real submission: success is assumed to be a redirect to the issue
// list or the Add page re-rendered with `isConfirmed = true` (the flag that
// opens its "successfully created" popup). Anything else is "unknown" rather
// than a failure, because the issue may well have been created — reporting
// failure would invite a duplicate resubmit to the landlord.
export function classifySubmitResponse({ url, body }) {
  if (/\/Maintenance\/ServiceIssue\/List/i.test(url)) return { status: "created" };
  if (/isConfirmed\s*=\s*true/.test(body)) return { status: "created" };
  if (/id="loginform"/.test(body)) return { status: "failed", reason: "session expired (got the login page)" };
  const errors = [...body.matchAll(/class="field-validation-error"[^>]*>([^<]+)</g)].map((m) => m[1].trim());
  if (errors.length || /validation-summary-errors/.test(body)) {
    return { status: "failed", reason: errors.join("; ") || "portal rejected the form" };
  }
  return { status: "unknown" };
}

export function createRentManagerTwaService({
  baseUrl = DEFAULT_BASE_URL,
  username,
  password,
  phone,
  allowEntry = false,
  timeZone = "America/New_York",
  fetchImpl = fetch,
  now = () => new Date(),
}) {
  // Follows redirects by hand so cookies set on a 302 (the login response)
  // land in the jar before the next hop.
  async function request(jar, path, init = {}) {
    let url = new URL(path, baseUrl).toString();
    let method = init.method || "GET";
    let body = init.body;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await fetchImpl(url, {
        method,
        body,
        redirect: "manual",
        headers: { ...(init.headers || {}), Cookie: jar.header() },
      });
      jar.store(res);
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        url = new URL(location, url).toString();
        method = "GET";
        body = undefined;
        continue;
      }
      return { url, status: res.status, res };
    }
    throw new Error(`too many redirects from ${path}`);
  }

  async function login() {
    const jar = createCookieJar();
    await request(jar, "/"); // picks up the ASP.NET session cookie
    const form = new URLSearchParams({
      LocationID: "1",
      Page: "",
      AccountID: "0",
      IsShowLocations: "False",
      ImagePath: "",
      Username: username,
      Password: password,
      RememberUsername: "false",
      IsIFrame: "False",
      IFrameReferrer: "",
      PreferredLanguage: "",
      HasTranslations: "False",
    });
    const { url, status, res } = await request(jar, "/Shared/Login", {
      method: "POST",
      body: form,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    const body = await res.text();
    if (status >= 400 || /id="loginform"/.test(body)) {
      throw new Error(`Rent Manager login failed (HTTP ${status}, landed on ${new URL(url).pathname})`);
    }
    return jar;
  }

  async function uploadPhoto(jar, { buffer, name, mimeType }) {
    const form = new FormData();
    form.append("path", "ServiceIssues");
    form.append("files[]", new Blob([buffer], { type: mimeType }), name);
    const { status, res } = await request(jar, "/Maintenance/ServiceIssue/UploadAttachment", {
      method: "POST",
      body: form,
    });
    const json = await res.json().catch(() => null);
    if (status >= 400 || !json?.Successful) {
      throw new Error(`attachment upload failed: ${json?.Model || `HTTP ${status}`}`);
    }
    return json.Model.map((m) => ({
      fileId: m.FileID,
      fileName: m.FileName,
      thumbnailUrl: m.ThumbnailURL,
    }));
  }

  // photos: [{ buffer, name, mimeType }]. Photos the portal won't take are
  // skipped (and counted) rather than failing the whole ticket.
  async function submitServiceIssue({ type, title, description, photos = [] }) {
    const jar = await login();

    const attachments = [];
    let skippedPhotos = 0;
    for (const photo of photos) {
      if (!ALLOWED_PHOTO_TYPES.has(photo.mimeType) || photo.buffer.length > MAX_PHOTO_BYTES) {
        skippedPhotos++;
        continue;
      }
      try {
        const uploaded = await uploadPhoto(jar, photo);
        attachments.push(...uploaded.map((u) => ({ ...u, description: "Photo from Slack report" })));
      } catch (err) {
        console.error("TWA photo upload failed:", err.message);
        skippedPhotos++;
      }
    }

    const form = buildServiceIssueForm({
      type,
      title,
      description,
      phone,
      allowEntry,
      attachments,
      openDate: formatOpenDate(now(), timeZone),
    });
    const { url, status, res } = await request(jar, "/Maintenance/ServiceIssue/Add", {
      method: "POST",
      body: form,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    const body = await res.text();
    if (status >= 500) return { status: "failed", reason: `portal error (HTTP ${status})`, skippedPhotos };
    return { ...classifySubmitResponse({ url, body }), attachedPhotos: attachments.length, skippedPhotos };
  }

  return { login, submitServiceIssue };
}

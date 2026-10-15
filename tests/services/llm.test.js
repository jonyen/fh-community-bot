import { describe, it, expect, vi, beforeEach } from "vitest";
import { createLlmService } from "../../src/services/llm.js";

describe("LlmService", () => {
  let mockClient;
  let service;

  beforeEach(() => {
    mockClient = {
      messages: {
        create: vi.fn(),
      },
    };
    service = createLlmService(mockClient);
  });

  describe("checkDuplicate", () => {
    it("returns matching issue ID when duplicate found", async () => {
      mockClient.messages.create.mockResolvedValue({ content: [{ type: "text", text: "3" }] });

      const result = await service.checkDuplicate("printer broken", [
        { id: "3", description: "Lobby printer jammed" },
        { id: "5", description: "AC broken in room 3" },
      ]);

      expect(result).toBe("3");
    });

    it("returns null when no duplicate found", async () => {
      mockClient.messages.create.mockResolvedValue({ content: [{ type: "text", text: "none" }] });

      const result = await service.checkDuplicate("new issue", [
        { id: "1", description: "Printer jammed" },
      ]);

      expect(result).toBeNull();
    });

    it("returns null when API fails", async () => {
      mockClient.messages.create.mockRejectedValue(new Error("API down"));

      const result = await service.checkDuplicate("test", []);
      expect(result).toBeNull();
    });
  });

});

describe("classifyIssueReport", () => {
  const LISTS = {
    types: ["Lighting", "Elevator", "Pest Control", "Electrical", "Plumbing", "HVAC", "Janitorial", "Other"],
    severities: ["Minor", "Medium", "Critical"],
  };

  function svcWith(content) {
    return createLlmService({
      messages: {
        create: vi.fn().mockResolvedValue({ content: [{ type: "text", text: content }] }),
      },
    });
  }

  it("returns the type and severity the model picked", async () => {
    const svc = svcWith('{"type": "Plumbing", "severity": "Critical"}');
    expect(await svc.classifyIssueReport("sewage backing up", LISTS)).toEqual({
      type: "Plumbing",
      severity: "Critical",
    });
  });

  it("keeps a null the model returned for a field it could not place", async () => {
    const svc = svcWith('{"type": "Lighting", "severity": null}');
    expect(await svc.classifyIssueReport("hallway light is out", LISTS)).toEqual({
      type: "Lighting",
      severity: null,
    });
  });

  it("digs the JSON out of a chatty reply", async () => {
    const svc = svcWith('Here you go:\n{"type": "HVAC", "severity": "Medium"}\nHope that helps!');
    expect(await svc.classifyIssueReport("AC is out", LISTS)).toEqual({
      type: "HVAC",
      severity: "Medium",
    });
  });

  it("matches the offered labels case-insensitively", async () => {
    const svc = svcWith('{"type": "plumbing", "severity": "critical"}');
    expect(await svc.classifyIssueReport("burst pipe", LISTS)).toEqual({
      type: "Plumbing",
      severity: "Critical",
    });
  });

  it("drops a label the form does not offer", async () => {
    const svc = svcWith('{"type": "Roofing", "severity": "Catastrophic"}');
    expect(await svc.classifyIssueReport("roof is leaking", LISTS)).toEqual({
      type: null,
      severity: null,
    });
  });

  it("returns null when the model answers with no JSON at all", async () => {
    const svc = svcWith("I am not sure what this is about.");
    expect(await svc.classifyIssueReport("???", LISTS)).toBeNull();
  });

  it("returns null when the JSON is malformed", async () => {
    const svc = svcWith('{"type": "Plumbing", "severity":}');
    expect(await svc.classifyIssueReport("sink", LISTS)).toBeNull();
  });

  it("returns null when the API fails, so the caller can fall back", async () => {
    const svc = createLlmService({
      messages: { create: vi.fn().mockRejectedValue(new Error("API down")) },
    });
    expect(await svc.classifyIssueReport("sink leaking", LISTS)).toBeNull();
  });

  it("does not call the model for empty text", async () => {
    const create = vi.fn();
    const svc = createLlmService({ messages: { create } });
    expect(await svc.classifyIssueReport("   ", LISTS)).toEqual({ type: null, severity: null });
    expect(create).not.toHaveBeenCalled();
  });

  it("sends the allowed labels along with the report", async () => {
    const create = vi
      .fn()
      .mockResolvedValue({ choices: [{ message: { content: '{"type":null,"severity":null}' } }] });
    const svc = createLlmService({ messages: { create } });
    await svc.classifyIssueReport("the elevator is grinding", LISTS);

    const userMessage = create.mock.calls[0][0].messages.at(-1).content;
    expect(userMessage).toContain("Pest Control");
    expect(userMessage).toContain("Critical");
    expect(userMessage).toContain("the elevator is grinding");
  });
});

describe("Bedrock request", () => {
  it("sends the configured model, system prompt and user message", async () => {
    const create = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "none" }] });
    await createLlmService({ messages: { create } }, { model: "us.anthropic.claude-haiku-5-5" }).checkDuplicate("x", []);
    const req = create.mock.calls[0][0];
    expect(req.model).toBe("us.anthropic.claude-haiku-5-5");
    expect(req.system).toContain("duplicate issue detector");
    expect(req.messages).toEqual([{ role: "user", content: expect.stringContaining('New report: "x"') }]);
  });

  it("defaults to Claude Haiku 4.5", async () => {
    const create = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "none" }] });
    await createLlmService({ messages: { create } }).checkDuplicate("x", []);
    expect(create.mock.calls[0][0].model).toBe("us.anthropic.claude-haiku-4-5-20251001-v1:0");
  });

  it("emits LlmCallFailed when a call fails, so the alarm fires", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    await createLlmService({ messages: { create: vi.fn().mockRejectedValue(new Error("model retired")) } }).checkDuplicate("x", []);
    const metricLine = log.mock.calls.map(([l]) => String(l)).find((l) => l.includes("LlmCallFailed"));
    expect(metricLine).toBeDefined();
    vi.restoreAllMocks();
  });

  it("treats a reply with no text as a failure", async () => {
    const create = vi.fn().mockResolvedValue({ content: [], stop_reason: "max_tokens" });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await createLlmService({ messages: { create } }).writeLandlordTicket("x")).toBeNull();
    vi.restoreAllMocks();
  });
});

describe("writeLandlordTicket", () => {
  function svcWith(create) {
    return createLlmService({ messages: { create } });
  }
  const reply = (text) => vi.fn().mockResolvedValue({ content: [{ type: "text", text }] });

  it("returns the model's title and description", async () => {
    const svc = svcWith(reply('{"title": "Leaking sink in kitchen", "description": "The kitchen sink is leaking."}'));
    expect(await svc.writeLandlordTicket("yo the kitchen sink is leaking again lol", { type: "Plumbing" })).toEqual({
      title: "Leaking sink in kitchen",
      description: "The kitchen sink is leaking.",
    });
  });

  it("sends the report and its type to the model", async () => {
    const create = reply('{"title": "t", "description": "d"}');
    await svcWith(create).writeLandlordTicket("sink leaking", { type: "Plumbing" });
    const userMsg = create.mock.calls[0][0].messages[0].content;
    expect(userMsg).toContain("Issue type: Plumbing");
    expect(userMsg).toContain("sink leaking");
  });

  it("digs the JSON out of a chatty reply", async () => {
    const svc = svcWith(reply('Sure:\n{"title": "t", "description": "d"}\nDone.'));
    expect(await svc.writeLandlordTicket("x")).toEqual({ title: "t", description: "d" });
  });

  it("returns null when a field is missing or empty", async () => {
    expect(await svcWith(reply('{"title": "t"}')).writeLandlordTicket("x")).toBeNull();
    expect(await svcWith(reply('{"title": " ", "description": "d"}')).writeLandlordTicket("x")).toBeNull();
  });

  it("returns null on malformed JSON or an API failure", async () => {
    expect(await svcWith(reply("{nope")).writeLandlordTicket("x")).toBeNull();
    expect(await svcWith(vi.fn().mockRejectedValue(new Error("down"))).writeLandlordTicket("x")).toBeNull();
  });

  it("does not call the model for empty text", async () => {
    const create = vi.fn();
    expect(await svcWith(create).writeLandlordTicket("  ")).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });
});

describe("parseReservationRequest", () => {
  function svcWith(content) {
    const create = vi.fn().mockResolvedValue({ content: [{ type: "text", text: content }] });
    return { svc: createLlmService({ messages: { create } }), create };
  }
  const ctx = { catalogText: "Tech: Tech Set 2", today: "2026-10-14", weekday: "Wednesday" };

  it("returns the parsed JSON object", async () => {
    const { svc, create } = svcWith('Sure: {"intent":"book","items":["Tech Set 2"],"date":"2026-10-17","start":"14:00","end":"16:00","title":"Youth night"}');
    const out = await svc.parseReservationRequest("Member: book tech set 2 sat 2-4 for youth night", ctx);
    expect(out).toEqual({ intent: "book", items: ["Tech Set 2"], date: "2026-10-17", start: "14:00", end: "16:00", title: "Youth night" });
    const call = create.mock.calls[0][0];
    expect(call.system).toContain("Tech: Tech Set 2");
    expect(call.system).toContain("2026-10-14 (Wednesday)");
    expect(call.messages[0].content).toContain("book tech set 2");
  });

  it("returns null on a non-JSON reply", async () => {
    const { svc } = svcWith("I can't help with that");
    expect(await svc.parseReservationRequest("Member: hi", ctx)).toBeNull();
  });

  it("returns null when the call fails", async () => {
    const svc = createLlmService({ messages: { create: vi.fn().mockRejectedValue(new Error("throttled")) } });
    expect(await svc.parseReservationRequest("Member: hi", ctx)).toBeNull();
  });
});

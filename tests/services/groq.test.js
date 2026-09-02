import { describe, it, expect, vi, beforeEach } from "vitest";
import { createGroqService } from "../../src/services/groq.js";

describe("GroqService", () => {
  let mockClient;
  let service;

  beforeEach(() => {
    mockClient = {
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
    };
    service = createGroqService(mockClient);
  });

  describe("checkDuplicate", () => {
    it("returns matching issue ID when duplicate found", async () => {
      mockClient.chat.completions.create.mockResolvedValue({
        choices: [{ message: { content: "3" } }],
      });

      const result = await service.checkDuplicate("printer broken", [
        { id: "3", description: "Lobby printer jammed" },
        { id: "5", description: "AC broken in room 3" },
      ]);

      expect(result).toBe("3");
    });

    it("returns null when no duplicate found", async () => {
      mockClient.chat.completions.create.mockResolvedValue({
        choices: [{ message: { content: "none" } }],
      });

      const result = await service.checkDuplicate("new issue", [
        { id: "1", description: "Printer jammed" },
      ]);

      expect(result).toBeNull();
    });

    it("returns null when API fails", async () => {
      mockClient.chat.completions.create.mockRejectedValue(new Error("API down"));

      const result = await service.checkDuplicate("test", []);
      expect(result).toBeNull();
    });
  });

});

describe("chooseCandidates", () => {
  const opts = ["Tech Set 1", "Tech Set 2", "Tech Set 3", "Tech Set 4"];
  function svcWith(content) {
    return createGroqService({ chat: { completions: { create: vi.fn().mockResolvedValue({ choices: [{ message: { content } }] }) } } });
  }
  it("returns the single chosen option, validated against the list", async () => {
    const out = await svcWith('{"selection":["Tech Set 1"]}').chooseCandidates(opts, "1");
    expect(out).toEqual(["Tech Set 1"]);
  });
  it("returns all options when the model selects all", async () => {
    const out = await svcWith('{"selection":["Tech Set 1","Tech Set 2","Tech Set 3","Tech Set 4"]}').chooseCandidates(opts, "all of them");
    expect(out).toHaveLength(4);
  });
  it("drops selections that are not real options", async () => {
    const out = await svcWith('{"selection":["Tech Set 1","Spaceship"]}').chooseCandidates(opts, "the first or a spaceship");
    expect(out).toEqual(["Tech Set 1"]);
  });
  it("returns [] on empty selection / bad JSON / no options", async () => {
    expect(await svcWith('{"selection":[]}').chooseCandidates(opts, "huh")).toEqual([]);
    expect(await svcWith("not json").chooseCandidates(opts, "1")).toEqual([]);
    expect(await svcWith('{"selection":["Tech Set 1"]}').chooseCandidates([], "1")).toEqual([]);
  });
  it("returns [] when the API throws", async () => {
    const svc = createGroqService({ chat: { completions: { create: vi.fn().mockRejectedValue(new Error("boom")) } } });
    expect(await svc.chooseCandidates(opts, "1")).toEqual([]);
  });
});

describe("parseReservationRequest", () => {
  it("returns parsed JSON from the model", async () => {
    const client = { chat: { completions: { create: vi.fn().mockResolvedValue({
      choices: [{ message: { content: '{"intent":"reserve","target":"FH MPR","date":"2026-06-26","startTime":"7:00 PM","endTime":"10:00 PM","what":"Practice","who":"College"}' } }],
    }) } } };
    const svc = createGroqService(client);
    const out = await svc.parseReservationRequest("book the MPR friday 7-10pm for practice", "2026-06-23T12:00:00Z");
    expect(out).toMatchObject({ intent: "reserve", target: "FH MPR", date: "2026-06-26", startTime: "7:00 PM" });
  });

  it("returns null on bad JSON", async () => {
    const client = { chat: { completions: { create: vi.fn().mockResolvedValue({
      choices: [{ message: { content: "not json" } }],
    }) } } };
    const svc = createGroqService(client);
    expect(await svc.parseReservationRequest("hi", "2026-06-23T12:00:00Z")).toBeNull();
  });

  it("returns null when the API throws", async () => {
    const client = { chat: { completions: { create: vi.fn().mockRejectedValue(new Error("boom")) } } };
    const svc = createGroqService(client);
    expect(await svc.parseReservationRequest("x", "2026-06-23T12:00:00Z")).toBeNull();
  });

  it("passes through a 'none' intent for non-reservation chatter", async () => {
    const client = { chat: { completions: { create: vi.fn().mockResolvedValue({
      choices: [{ message: { content: '{"intent":"none","target":null,"date":null,"startTime":null,"endTime":null,"what":null,"who":null}' } }],
    }) } } };
    const svc = createGroqService(client);
    const out = await svc.parseReservationRequest("lol that meeting was wild", "2026-06-24T12:00:00Z");
    expect(out.intent).toBe("none");
  });

  it("passes through a 'history' intent for last-used questions", async () => {
    const client = { chat: { completions: { create: vi.fn().mockResolvedValue({
      choices: [{ message: { content: '{"intent":"history","target":"speaker set","date":null,"startTime":null,"endTime":null,"what":null,"who":null}' } }],
    }) } } };
    const svc = createGroqService(client);
    const out = await svc.parseReservationRequest("who used the speaker set last?", "2026-06-24T12:00:00Z");
    expect(out).toMatchObject({ intent: "history", target: "speaker set" });
  });

  it("routes a general OneStop question to intent 'info'", async () => {
    const client = { chat: { completions: { create: vi.fn().mockResolvedValue({
      choices: [{ message: { content: '{"intent":"info","target":null,"date":null,"startTime":null,"endTime":null,"what":null,"who":null}' } }],
    }) } } };
    const svc = createGroqService(client);
    const out = await svc.parseReservationRequest("what's the FH door code?", "2026-06-24T12:00:00Z");
    expect(out.intent).toBe("info");
  });
});

describe("answerInfoQuestion", () => {
  it("passes the corpus + question to the model and returns its answer", async () => {
    const create = vi.fn().mockResolvedValue({ choices: [{ message: { content: "The FH door code is 0326." } }] });
    const svc = createGroqService({ chat: { completions: { create } } });
    const out = await svc.answerInfoQuestion("what's the door code?", "### BULLETIN\nFH Door code | 0326");
    expect(out).toBe("The FH door code is 0326.");
    const userMsg = create.mock.calls[0][0].messages[1].content;
    expect(userMsg).toContain("0326");                 // corpus included
    expect(userMsg).toContain("what's the door code?"); // question included
  });
  it("returns a graceful fallback on API failure", async () => {
    const svc = createGroqService({ chat: { completions: { create: vi.fn().mockRejectedValue(new Error("boom")) } } });
    expect(await svc.answerInfoQuestion("q", "corpus")).toBe("Can't reach OneStop right now.");
  });
});

describe("classifyIssueReport", () => {
  const LISTS = {
    types: ["Lighting", "Elevator", "Pest Control", "Electrical", "Plumbing", "HVAC", "Janitorial", "Other"],
    severities: ["Minor", "Medium", "Critical"],
  };

  function svcWith(content) {
    return createGroqService({
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({ choices: [{ message: { content } }] }),
        },
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
    const svc = createGroqService({
      chat: { completions: { create: vi.fn().mockRejectedValue(new Error("API down")) } },
    });
    expect(await svc.classifyIssueReport("sink leaking", LISTS)).toBeNull();
  });

  it("does not call the model for empty text", async () => {
    const create = vi.fn();
    const svc = createGroqService({ chat: { completions: { create } } });
    expect(await svc.classifyIssueReport("   ", LISTS)).toEqual({ type: null, severity: null });
    expect(create).not.toHaveBeenCalled();
  });

  it("sends the allowed labels along with the report", async () => {
    const create = vi
      .fn()
      .mockResolvedValue({ choices: [{ message: { content: '{"type":null,"severity":null}' } }] });
    const svc = createGroqService({ chat: { completions: { create } } });
    await svc.classifyIssueReport("the elevator is grinding", LISTS);

    const userMessage = create.mock.calls[0][0].messages.at(-1).content;
    expect(userMessage).toContain("Pest Control");
    expect(userMessage).toContain("Critical");
    expect(userMessage).toContain("the elevator is grinding");
  });
});

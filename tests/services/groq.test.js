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

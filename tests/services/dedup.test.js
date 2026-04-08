import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDedupService } from "../../src/services/dedup.js";

describe("DedupService", () => {
  let mockGroq;
  let service;

  beforeEach(() => {
    mockGroq = {
      checkDuplicate: vi.fn(),
    };
    service = createDedupService(mockGroq);
  });

  describe("findDuplicate", () => {
    const openIssues = [
      { id: "1", description: "Lobby printer is jammed" },
      { id: "2", description: "AC broken in conference room 3" },
    ];

    it("returns match from keyword pass without calling AI", async () => {
      const result = await service.findDuplicate("lobby printer jammed again!", openIssues);
      expect(result).toEqual({ id: "1", confident: true });
      expect(mockGroq.checkDuplicate).not.toHaveBeenCalled();
    });

    it("falls through to AI pass when no keyword match", async () => {
      mockGroq.checkDuplicate.mockResolvedValue("2");

      const result = await service.findDuplicate("the cooling in room 3 is not working", openIssues);
      expect(result).toEqual({ id: "2", confident: false });
      expect(mockGroq.checkDuplicate).toHaveBeenCalled();
    });

    it("returns null when neither pass finds a match", async () => {
      mockGroq.checkDuplicate.mockResolvedValue(null);

      const result = await service.findDuplicate("elevator stuck on floor 5", openIssues);
      expect(result).toBeNull();
    });

    it("returns null when there are no open issues", async () => {
      const result = await service.findDuplicate("something broke", []);
      expect(result).toBeNull();
    });
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createGenderHandler } from "../../src/events/gender.js";

function makeSay() {
  return vi.fn().mockResolvedValue({});
}

function makeClient({ membersPages = [["U_MALE_1", "U_MALE_2", "U_FEMALE_1", "U_OTHER"]], membersError = null } = {}) {
  let call = 0;
  const conversations = {
    members: vi.fn().mockImplementation(async () => {
      if (membersError) throw membersError;
      const page = membersPages[call] || [];
      const nextCursor = call < membersPages.length - 1 ? `c${call + 1}` : "";
      call += 1;
      return { members: page, response_metadata: { next_cursor: nextCursor } };
    }),
  };
  return {
    conversations,
    chat: { postMessage: vi.fn().mockResolvedValue({}) },
  };
}

function makeService({ map = { U_MALE_1: "male", U_MALE_2: "male", U_FEMALE_1: "female" }, getMapError = null } = {}) {
  return {
    getMap: vi.fn().mockImplementation(async () => {
      if (getMapError) throw getMapError;
      return map;
    }),
    invalidate: vi.fn().mockResolvedValue(Object.keys(map).length),
  };
}

describe("createGenderHandler", () => {
  let say;
  let client;
  let service;
  let handler;

  beforeEach(() => {
    say = makeSay();
    client = makeClient();
    service = makeService();
    handler = createGenderHandler({ genderMapService: service });
  });

  it("pings male members on !bros and excludes others", async () => {
    await handler({
      event: { type: "message", channel: "C1", user: "U_CALLER", text: "!bros let's go", ts: "1" },
      say,
      client,
    });
    expect(say).toHaveBeenCalledTimes(1);
    const arg = say.mock.calls[0][0];
    expect(arg.text).toBe("<@U_CALLER> pinged males: <@U_MALE_1> <@U_MALE_2>");
    expect(arg.thread_ts).toBeUndefined();
  });

  it("pings female members on !sis", async () => {
    await handler({
      event: { type: "message", channel: "C1", user: "U_CALLER", text: "hey !sis", ts: "1" },
      say,
      client,
    });
    expect(say.mock.calls[0][0].text).toBe("<@U_CALLER> pinged females: <@U_FEMALE_1>");
  });

  it("paginates conversations.members until cursor empty", async () => {
    client = makeClient({ membersPages: [["U_MALE_1"], ["U_MALE_2"]] });
    await handler({
      event: { type: "message", channel: "C1", user: "U_CALLER", text: "!bros", ts: "1" },
      say,
      client,
    });
    expect(client.conversations.members).toHaveBeenCalledTimes(2);
    const firstCall = client.conversations.members.mock.calls[0][0];
    expect(firstCall.channel).toBe("C1");
    expect(firstCall.limit).toBe(200);
    expect(firstCall.cursor).toBeUndefined();
    const secondCall = client.conversations.members.mock.calls[1][0];
    expect(secondCall.cursor).toBe("c1");
  });

  it("posts the empty-target message when no members match", async () => {
    service = makeService({ map: { U_FEMALE_1: "female" } });
    handler = createGenderHandler({ genderMapService: service });
    await handler({
      event: { type: "message", channel: "C1", user: "U_CALLER", text: "!bros", ts: "1" },
      say,
      client,
    });
    expect(say.mock.calls[0][0].text).toBe("No male members configured for this channel.");
  });

  it("uses generic prefix when caller user is absent", async () => {
    await handler({
      event: { type: "message", channel: "C1", text: "!bros", ts: "1" },
      say,
      client,
    });
    expect(say.mock.calls[0][0].text).toBe("male ping: <@U_MALE_1> <@U_MALE_2>");
  });

  it("on !refresh-genders, invalidates and replies with count", async () => {
    await handler({
      event: { type: "message", channel: "C1", user: "U_CALLER", text: "!refresh-genders", ts: "1" },
      say,
      client,
    });
    expect(service.invalidate).toHaveBeenCalledTimes(1);
    expect(client.conversations.members).not.toHaveBeenCalled();
    expect(say.mock.calls[0][0].text).toBe("Refreshed gender map. 3 entries loaded.");
  });

  it("refresh wins when both refresh and trigger appear", async () => {
    await handler({
      event: { type: "message", channel: "C1", user: "U_CALLER", text: "!refresh-genders !bros", ts: "1" },
      say,
      client,
    });
    expect(service.invalidate).toHaveBeenCalledTimes(1);
    expect(client.conversations.members).not.toHaveBeenCalled();
  });

  it("replies with error message when getMap throws", async () => {
    service = makeService({ getMapError: new Error("sheets down") });
    handler = createGenderHandler({ genderMapService: service });
    await handler({
      event: { type: "message", channel: "C1", user: "U_CALLER", text: "!bros", ts: "1" },
      say,
      client,
    });
    expect(say.mock.calls[0][0].text).toBe("Could not load gender map: sheets down");
  });

  it("replies with error message when conversations.members throws", async () => {
    client = makeClient({ membersError: new Error("slack down") });
    await handler({
      event: { type: "message", channel: "C1", user: "U_CALLER", text: "!bros", ts: "1" },
      say,
      client,
    });
    expect(say.mock.calls[0][0].text).toBe("Could not list channel members: slack down");
  });

  it("replies with refresh error message when invalidate throws", async () => {
    service.invalidate = vi.fn().mockRejectedValue(new Error("network"));
    await handler({
      event: { type: "message", channel: "C1", user: "U_CALLER", text: "!refresh-genders", ts: "1" },
      say,
      client,
    });
    expect(say.mock.calls[0][0].text).toBe("Refresh failed: network");
  });

  it("when both !bros and !sis appear, resolves to male", async () => {
    await handler({
      event: { type: "message", channel: "C1", user: "U_CALLER", text: "!sis !bros", ts: "1" },
      say,
      client,
    });
    expect(say.mock.calls[0][0].text).toBe("<@U_CALLER> pinged males: <@U_MALE_1> <@U_MALE_2>");
  });
});

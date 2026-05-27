import { describe, it, expect, vi, beforeEach } from "vitest";
import { createGenderHandler } from "../../src/events/gender.js";

function makeSay() {
  return vi.fn().mockResolvedValue({});
}

function makeClient({
  membersPages = [["U_MALE_1", "U_MALE_2", "U_FEMALE_1", "U_OTHER"]],
  membersError = null,
} = {}) {
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
    chat: {
      postMessage: vi.fn().mockResolvedValue({}),
      postEphemeral: vi.fn().mockResolvedValue({ ok: true }),
    },
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

const PERSONA = { username: "Gender Aliases", icon_emoji: ":busts_in_silhouette:" };

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

  it("posts only the mention list when text body present (@bros hello)", async () => {
    await handler({
      event: { type: "message", channel: "C1", user: "U_CALLER", text: "@bros hello", ts: "1" },
      say,
      client,
    });
    expect(say).toHaveBeenCalledTimes(1);
    const arg = say.mock.calls[0][0];
    expect(arg.text).toBe("<@U_MALE_1> <@U_MALE_2>");
    expect(arg.username).toBe(PERSONA.username);
    expect(arg.icon_emoji).toBe(PERSONA.icon_emoji);
    expect(arg.thread_ts).toBeUndefined();
  });

  it("posts only the female mention list on @sis with body", async () => {
    await handler({
      event: { type: "message", channel: "C1", user: "U_CALLER", text: "hey @sis check this", ts: "1" },
      say,
      client,
    });
    expect(say.mock.calls[0][0].text).toBe("<@U_FEMALE_1>");
  });

  it("posts mentions for bare !bros", async () => {
    await handler({
      event: { type: "message", channel: "C1", user: "U_CALLER", text: "!bros", ts: "1" },
      say,
      client,
    });
    expect(say.mock.calls[0][0].text).toBe("<@U_MALE_1> <@U_MALE_2>");
  });

  it("posts both gender lists in encounter order when both triggers appear", async () => {
    await handler({
      event: { type: "message", channel: "C1", user: "U_CALLER", text: "@bros and @sis, hello", ts: "1" },
      say,
      client,
    });
    expect(say.mock.calls[0][0].text).toBe("<@U_MALE_1> <@U_MALE_2> <@U_FEMALE_1>");
  });

  it("reverses gender order when @sis appears first", async () => {
    await handler({
      event: { type: "message", channel: "C1", user: "U_CALLER", text: "@sis @bros", ts: "1" },
      say,
      client,
    });
    expect(say.mock.calls[0][0].text).toBe("<@U_FEMALE_1> <@U_MALE_1> <@U_MALE_2>");
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

  it("sends an ephemeral notice to the caller when no members match", async () => {
    service = makeService({ map: { U_FEMALE_1: "female" } });
    handler = createGenderHandler({ genderMapService: service });
    await handler({
      event: { type: "message", channel: "C1", user: "U_CALLER", text: "!bros", ts: "1" },
      say,
      client,
    });
    expect(client.chat.postEphemeral).toHaveBeenCalledWith({
      channel: "C1",
      user: "U_CALLER",
      text: "No male members configured for this channel.",
      username: PERSONA.username,
      icon_emoji: PERSONA.icon_emoji,
    });
    expect(say).not.toHaveBeenCalled();
  });

  it("falls back to a public reply when no event.user (cannot send ephemeral)", async () => {
    service = makeService({ map: { U_FEMALE_1: "female" } });
    handler = createGenderHandler({ genderMapService: service });
    await handler({
      event: { type: "message", channel: "C1", text: "!bros", ts: "1" },
      say,
      client,
    });
    expect(client.chat.postEphemeral).not.toHaveBeenCalled();
    expect(say).toHaveBeenCalledWith({ text: "No male members configured for this channel." });
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

  it("sends ephemeral when ALL referenced genders are empty", async () => {
    service = makeService({ map: {} });
    handler = createGenderHandler({ genderMapService: service });
    await handler({
      event: { type: "message", channel: "C1", user: "U_CALLER", text: "@bros and @sis", ts: "1" },
      say,
      client,
    });
    expect(client.chat.postEphemeral).toHaveBeenCalledWith({
      channel: "C1",
      user: "U_CALLER",
      text: "No male/female members configured for this channel.",
      username: PERSONA.username,
      icon_emoji: PERSONA.icon_emoji,
    });
    expect(say).not.toHaveBeenCalled();
  });

  it("falls back to public reply when ephemeral fails", async () => {
    service = makeService({ map: { U_FEMALE_1: "female" } });
    handler = createGenderHandler({ genderMapService: service });
    client.chat.postEphemeral = vi.fn().mockRejectedValue(
      Object.assign(new Error("forbidden"), { data: { error: "channel_not_found" } })
    );
    await handler({
      event: { type: "message", channel: "C1", user: "U_CALLER", text: "!bros", ts: "1" },
      say,
      client,
    });
    expect(say).toHaveBeenCalledWith({ text: "No male members configured for this channel." });
  });
});

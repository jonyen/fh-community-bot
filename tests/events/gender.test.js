import { describe, it, expect, vi, beforeEach } from "vitest";
import { createGenderHandler } from "../../src/events/gender.js";

function makeSay() {
  return vi.fn().mockResolvedValue({});
}

function makeClient({
  membersPages = [["U_MALE_1", "U_MALE_2", "U_FEMALE_1", "U_OTHER"]],
  membersError = null,
  userInfo = { profile: { display_name: "Caller Name", image_72: "https://img/72.png" } },
  userInfoError = null,
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
  const users = {
    info: vi.fn().mockImplementation(async () => {
      if (userInfoError) throw userInfoError;
      return { user: userInfo };
    }),
  };
  return {
    conversations,
    users,
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

  it("pings male members on !bros and appends remaining text", async () => {
    await handler({
      event: { type: "message", channel: "C1", user: "U_CALLER", text: "!bros let's go", ts: "1" },
      say,
      client,
    });
    expect(say).toHaveBeenCalledTimes(1);
    const arg = say.mock.calls[0][0];
    expect(arg.text).toBe("<@U_MALE_1> <@U_MALE_2> let's go");
    expect(arg.thread_ts).toBeUndefined();
  });

  it("pings female members on @sis with leading and trailing text (mentions inserted at trigger position)", async () => {
    await handler({
      event: { type: "message", channel: "C1", user: "U_CALLER", text: "hey @sis check this", ts: "1" },
      say,
      client,
    });
    expect(say.mock.calls[0][0].text).toBe("hey <@U_FEMALE_1> check this");
  });

  it("posts mentions only when there is no remaining text", async () => {
    await handler({
      event: { type: "message", channel: "C1", user: "U_CALLER", text: "!bros", ts: "1" },
      say,
      client,
    });
    expect(say.mock.calls[0][0].text).toBe("<@U_MALE_1> <@U_MALE_2>");
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
      username: "Gender Aliases",
      icon_emoji: ":busts_in_silhouette:",
    });
    expect(say).not.toHaveBeenCalled();
  });

  it("works when caller is absent (mentions inserted at trigger position, no persona override)", async () => {
    await handler({
      event: { type: "message", channel: "C1", text: "!bros standup time", ts: "1" },
      say,
      client,
    });
    const arg = say.mock.calls[0][0];
    expect(arg.text).toBe("<@U_MALE_1> <@U_MALE_2> standup time");
    expect(arg.username).toBeUndefined();
    expect(arg.icon_url).toBeUndefined();
    expect(client.users.info).not.toHaveBeenCalled();
  });

  it("on !refresh-genders, invalidates and replies via ephemeral as Gender Aliases", async () => {
    await handler({
      event: { type: "message", channel: "C1", user: "U_CALLER", text: "!refresh-genders", ts: "1" },
      say,
      client,
    });
    expect(service.invalidate).toHaveBeenCalledTimes(1);
    expect(client.conversations.members).not.toHaveBeenCalled();
    expect(client.chat.postEphemeral).toHaveBeenCalledWith({
      channel: "C1",
      user: "U_CALLER",
      text: "Refreshed gender map. 3 entries loaded.",
      username: "Gender Aliases",
      icon_emoji: ":busts_in_silhouette:",
    });
    expect(say).not.toHaveBeenCalled();
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

  it("sends refresh error as ephemeral when invalidate throws", async () => {
    service.invalidate = vi.fn().mockRejectedValue(new Error("network"));
    await handler({
      event: { type: "message", channel: "C1", user: "U_CALLER", text: "!refresh-genders", ts: "1" },
      say,
      client,
    });
    expect(client.chat.postEphemeral).toHaveBeenCalledWith({
      channel: "C1",
      user: "U_CALLER",
      text: "Refresh failed: network",
      username: "Gender Aliases",
      icon_emoji: ":busts_in_silhouette:",
    });
    expect(say).not.toHaveBeenCalled();
  });

  it("substitutes both genders inline when both triggers appear", async () => {
    await handler({
      event: { type: "message", channel: "C1", user: "U_CALLER", text: "@bros and @sis, hello", ts: "1" },
      say,
      client,
    });
    expect(say.mock.calls[0][0].text).toBe("<@U_MALE_1> <@U_MALE_2> and <@U_FEMALE_1>, hello");
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
      username: "Gender Aliases",
      icon_emoji: ":busts_in_silhouette:",
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

  it("posts with caller username and icon_url override (persona)", async () => {
    await handler({
      event: { type: "message", channel: "C1", user: "U_CALLER", text: "!bros hello", ts: "1" },
      say,
      client,
    });
    expect(client.users.info).toHaveBeenCalledWith({ user: "U_CALLER" });
    const arg = say.mock.calls[0][0];
    expect(arg.username).toBe("Caller Name");
    expect(arg.icon_url).toBe("https://img/72.png");
  });

  it("falls back to bot post when chat:write.customize is missing", async () => {
    say = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("not allowed"), { data: { error: "not_allowed_token_type" } }))
      .mockResolvedValueOnce({});
    await handler({
      event: { type: "message", channel: "C1", user: "U_CALLER", text: "!bros hello", ts: "1" },
      say,
      client,
    });
    expect(say).toHaveBeenCalledTimes(2);
    const second = say.mock.calls[1][0];
    expect(second.username).toBeUndefined();
    expect(second.icon_url).toBeUndefined();
    expect(second.text).toBe("<@U_MALE_1> <@U_MALE_2> hello");
  });
});

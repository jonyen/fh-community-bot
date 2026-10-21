import { describe, it, expect, vi } from "vitest";
import { dispatchSlackEvent } from "../../src/lambda/dispatch.js";

function makeClient() {
  return {
    chat: { postMessage: vi.fn().mockResolvedValue({}) },
    reactions: { add: vi.fn().mockResolvedValue({}) },
    users: { info: vi.fn().mockResolvedValue({ user: { real_name: "Test" } }) },
  };
}

describe("dispatchSlackEvent", () => {
  it("invokes the handler with a say() bound to the event's channel", async () => {
    const handler = vi.fn().mockResolvedValue();
    const client = makeClient();
    const slackEvent = { type: "app_mention", channel: "C1", text: "hi", user: "U1", ts: "1" };

    await dispatchSlackEvent({
      slackEnvelope: { event: slackEvent },
      handler,
      client,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    const args = handler.mock.calls[0][0];
    expect(args.event).toEqual(slackEvent);
    expect(args.client).toBe(client);
    expect(typeof args.say).toBe("function");

    await args.say({ text: "hello", thread_ts: "1" });
    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: "C1",
      username: "FH Maintenance",
      text: "hello",
      thread_ts: "1",
    });
  });

  it("skips messages that are not thread replies", async () => {
    const handler = vi.fn();
    await dispatchSlackEvent({
      slackEnvelope: { event: { type: "message", channel: "C1", text: "hi", user: "U1", ts: "1" } },
      handler,
      client: makeClient(),
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("skips bot messages and subtyped messages", async () => {
    const handler = vi.fn();
    await dispatchSlackEvent({
      slackEnvelope: { event: { type: "message", channel: "C1", thread_ts: "1", text: "hi", bot_id: "B1" } },
      handler,
      client: makeClient(),
    });
    await dispatchSlackEvent({
      slackEnvelope: { event: { type: "message", channel: "C1", thread_ts: "1", text: "hi", subtype: "message_changed" } },
      handler,
      client: makeClient(),
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("skips thread messages that contain an @mention (handled by app_mention path)", async () => {
    const handler = vi.fn();
    await dispatchSlackEvent({
      slackEnvelope: { event: { type: "message", channel: "C1", thread_ts: "1", text: "<@U_BOT> hi", user: "U1" } },
      handler,
      client: makeClient(),
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("passes thread replies (no @mention, not a bot) through to the handler", async () => {
    const handler = vi.fn().mockResolvedValue();
    await dispatchSlackEvent({
      slackEnvelope: { event: { type: "message", channel: "C1", thread_ts: "1", text: "more info", user: "U1" } },
      handler,
      client: makeClient(),
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("always passes app_mention through", async () => {
    const handler = vi.fn().mockResolvedValue();
    await dispatchSlackEvent({
      slackEnvelope: { event: { type: "app_mention", channel: "C1", text: "<@U_BOT> hi", user: "U1", ts: "1" } },
      handler,
      client: makeClient(),
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("routes a !bros message to genderHandler (top-level, no thread_ts)", async () => {
    const handler = vi.fn();
    const genderHandler = vi.fn().mockResolvedValue();
    const client = makeClient();
    await dispatchSlackEvent({
      slackEnvelope: { event: { type: "message", channel: "C1", text: "!bros let's go", user: "U1", ts: "1" } },
      handler,
      genderHandler,
      client,
    });
    expect(genderHandler).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
    const args = genderHandler.mock.calls[0][0];
    await args.say({ text: "ping" });
    expect(client.chat.postMessage).toHaveBeenCalledWith({ channel: "C1", text: "ping" });
  });

  it("threads the gender reply when !bros is posted in a thread", async () => {
    const handler = vi.fn();
    const genderHandler = vi.fn().mockResolvedValue();
    const client = makeClient();
    await dispatchSlackEvent({
      slackEnvelope: { event: { type: "message", channel: "C1", thread_ts: "1700.1", text: "!bros", user: "U1", ts: "1700.2" } },
      handler,
      genderHandler,
      client,
    });
    expect(genderHandler).toHaveBeenCalledTimes(1);
    const args = genderHandler.mock.calls[0][0];
    await args.say({ text: "ping" });
    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: "C1",
      thread_ts: "1700.1",
      text: "ping",
    });
  });

  it("does NOT route !refresh-genders typed in chat (slash command is the refresh path now)", async () => {
    const handler = vi.fn();
    const genderHandler = vi.fn();
    await dispatchSlackEvent({
      slackEnvelope: { event: { type: "message", channel: "C1", text: "!refresh-genders", user: "U1", ts: "1" } },
      handler,
      genderHandler,
      client: makeClient(),
    });
    expect(genderHandler).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not route !bros to gender path when genderHandler is undefined", async () => {
    const handler = vi.fn();
    await dispatchSlackEvent({
      slackEnvelope: { event: { type: "message", channel: "C1", text: "!bros", user: "U1", ts: "1" } },
      handler,
      client: makeClient(),
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not route !bros from an app_mention event (gender is message-only)", async () => {
    const handler = vi.fn().mockResolvedValue();
    const genderHandler = vi.fn().mockResolvedValue();
    await dispatchSlackEvent({
      slackEnvelope: { event: { type: "app_mention", channel: "C1", text: "<@U_BOT> !bros", user: "U1", ts: "1" } },
      handler,
      genderHandler,
      client: makeClient(),
    });
    expect(genderHandler).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("still routes non-gender thread messages to the maintenance handler", async () => {
    const handler = vi.fn().mockResolvedValue();
    const genderHandler = vi.fn();
    await dispatchSlackEvent({
      slackEnvelope: { event: { type: "message", channel: "C1", thread_ts: "1", text: "more info", user: "U1" } },
      handler,
      genderHandler,
      client: makeClient(),
    });
    expect(genderHandler).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("routes /refresh-genders slash envelope to slashRefreshHandler", async () => {
    const handler = vi.fn();
    const genderHandler = vi.fn();
    const slashRefreshHandler = vi.fn().mockResolvedValue();
    const envelope = {
      type: "slash_command",
      command: "/refresh-genders",
      user_id: "U1",
      response_url: "https://hooks.slack.com/commands/T/1/x",
    };
    await dispatchSlackEvent({
      slackEnvelope: envelope,
      handler,
      genderHandler,
      slashRefreshHandler,
      client: makeClient(),
    });
    expect(slashRefreshHandler).toHaveBeenCalledTimes(1);
    expect(slashRefreshHandler.mock.calls[0][0].envelope).toBe(envelope);
    expect(handler).not.toHaveBeenCalled();
    expect(genderHandler).not.toHaveBeenCalled();
  });

  it("ignores unknown slash commands", async () => {
    const slashRefreshHandler = vi.fn();
    await dispatchSlackEvent({
      slackEnvelope: { type: "slash_command", command: "/something-else" },
      handler: vi.fn(),
      genderHandler: vi.fn(),
      slashRefreshHandler,
      client: makeClient(),
    });
    expect(slashRefreshHandler).not.toHaveBeenCalled();
  });

  it("is a no-op for slash_command when no slashRefreshHandler provided", async () => {
    const handler = vi.fn();
    await dispatchSlackEvent({
      slackEnvelope: { type: "slash_command", command: "/refresh-genders" },
      handler,
      client: makeClient(),
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("passes a file_share thread reply (no @mention) through to the handler", async () => {
    const handler = vi.fn().mockResolvedValue();
    await dispatchSlackEvent({
      slackEnvelope: {
        event: {
          type: "message",
          subtype: "file_share",
          channel: "C1",
          thread_ts: "1",
          text: "",
          user: "U1",
          files: [{ id: "F1", mimetype: "image/jpeg" }],
        },
      },
      handler,
      client: makeClient(),
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("skips a file_share thread reply that contains an @mention (handled by app_mention path)", async () => {
    const handler = vi.fn();
    await dispatchSlackEvent({
      slackEnvelope: {
        event: {
          type: "message",
          subtype: "file_share",
          channel: "C1",
          thread_ts: "1",
          text: "<@U_BOT> see photo",
          user: "U1",
          files: [{ id: "F1", mimetype: "image/jpeg" }],
        },
      },
      handler,
      client: makeClient(),
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("still skips a file_share that is not a thread reply", async () => {
    const handler = vi.fn();
    await dispatchSlackEvent({
      slackEnvelope: {
        event: { type: "message", subtype: "file_share", channel: "C1", text: "", user: "U1", files: [{ id: "F1" }] },
      },
      handler,
      client: makeClient(),
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("still skips non-file_share subtyped thread messages", async () => {
    const handler = vi.fn();
    await dispatchSlackEvent({
      slackEnvelope: {
        event: { type: "message", channel: "C1", thread_ts: "1", text: "hi", subtype: "message_changed" },
      },
      handler,
      client: makeClient(),
    });
    expect(handler).not.toHaveBeenCalled();
  });
});

function client() {
  return { chat: { postMessage: vi.fn().mockResolvedValue({}) } };
}

describe("dispatchSlackEvent with OneStop removed", () => {
  it("sends a booking-sounding mention to maintenance", async () => {
    const maintenance = vi.fn().mockResolvedValue();
    await dispatchSlackEvent({
      slackEnvelope: { event: { type: "app_mention", text: "<@U1> is the MPR free friday?", channel: "C1", ts: "1.1" } },
      handler: maintenance, client: client(),
    });
    expect(maintenance).toHaveBeenCalled();
  });

  it("ignores the old /reserve, /check and /list commands", async () => {
    const maintenance = vi.fn();
    for (const command of ["/reserve", "/check", "/list"]) {
      await dispatchSlackEvent({
        slackEnvelope: { type: "slash_command", command, text: "MPR fri 7-10pm" },
        handler: maintenance, client: client(),
      });
    }
    expect(maintenance).not.toHaveBeenCalled();
  });
});

describe("dispatchSlackEvent block_actions routing", () => {
  it("routes a block_actions envelope to the maintenance form handler", async () => {
    const maintenanceFormHandler = vi.fn().mockResolvedValue();
    const client = {};
    const envelope = { type: "block_actions", payload: { actions: [{ action_id: "submit_maintenance_form" }] } };

    await dispatchSlackEvent({ slackEnvelope: envelope, handler: vi.fn(), maintenanceFormHandler, client });

    expect(maintenanceFormHandler).toHaveBeenCalledWith({ payload: envelope.payload, client });
  });

  it("also hands block_actions to the CREA draft handler", async () => {
    const maintenanceFormHandler = vi.fn().mockResolvedValue();
    const creaTicketHandler = { handleReaction: vi.fn(), handleDraftAction: vi.fn().mockResolvedValue() };
    const client = {};
    const envelope = { type: "block_actions", payload: { actions: [{ action_id: "send_crea_ticket" }] } };

    await dispatchSlackEvent({ slackEnvelope: envelope, handler: vi.fn(), maintenanceFormHandler, creaTicketHandler, client });

    expect(creaTicketHandler.handleDraftAction).toHaveBeenCalledWith({ payload: envelope.payload, client });
    expect(creaTicketHandler.handleReaction).not.toHaveBeenCalled();
  });

  it("is a no-op for block_actions when no maintenanceFormHandler provided", async () => {
    const handler = vi.fn();
    await dispatchSlackEvent({
      slackEnvelope: { type: "block_actions", payload: {} },
      handler,
      client: {},
    });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("dispatchSlackEvent — CREA ticket reactions", () => {
  it("routes reaction_added to the CREA ticket handler", async () => {
    const creaTicketHandler = { handleReaction: vi.fn().mockResolvedValue(), handleDraftAction: vi.fn() };
    const handler = vi.fn();
    const event = { type: "reaction_added", reaction: "ticket", item: { type: "message", channel: "C1", ts: "1.1" } };
    await dispatchSlackEvent({ slackEnvelope: { event }, handler, creaTicketHandler, client: {} });
    expect(creaTicketHandler.handleReaction).toHaveBeenCalledWith({ event, client: {} });
    expect(handler).not.toHaveBeenCalled();
  });

  it("drops reaction_added when the CREA integration is off", async () => {
    const handler = vi.fn();
    await dispatchSlackEvent({ slackEnvelope: { event: { type: "reaction_added", reaction: "ticket" } }, handler, client: {} });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("dispatch to #reservations", () => {
  const reservationsHandler = { channelId: "CRES", handleMessage: vi.fn().mockResolvedValue() };

  it("routes every message in the reservations channel to its handler only", async () => {
    const handler = vi.fn();
    const client = makeClient();
    const event = { type: "message", channel: "CRES", text: "book the MPR", user: "U1", ts: "1" };
    await dispatchSlackEvent({ slackEnvelope: { event }, handler, reservationsHandler, client });
    expect(reservationsHandler.handleMessage).toHaveBeenCalledWith({ event, client });
    expect(handler).not.toHaveBeenCalled();
  });

  it("drops app_mention events there so a mention isn't handled twice", async () => {
    reservationsHandler.handleMessage.mockClear();
    const handler = vi.fn();
    await dispatchSlackEvent({ slackEnvelope: { event: { type: "app_mention", channel: "CRES", text: "<@B> hi", ts: "1" } }, handler, reservationsHandler, client: makeClient() });
    expect(reservationsHandler.handleMessage).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("dispatch for connected accounts", () => {
  it("resumes a booking after sign-in", async () => {
    const reservationsHandler = { channelId: "CRES", handleMessage: vi.fn(), resume: vi.fn().mockResolvedValue(), disconnect: vi.fn() };
    const client = makeClient();
    await dispatchSlackEvent({ slackEnvelope: { type: "oauth_connected", pendingId: "P1" }, handler: vi.fn(), reservationsHandler, client });
    expect(reservationsHandler.resume).toHaveBeenCalledWith({ pendingId: "P1", client });
  });

  it("routes /reservations-disconnect", async () => {
    const reservationsHandler = { channelId: "CRES", handleMessage: vi.fn(), resume: vi.fn(), disconnect: vi.fn().mockResolvedValue() };
    const client = makeClient();
    await dispatchSlackEvent({
      slackEnvelope: { type: "slash_command", command: "/reservations-disconnect", user_id: "U9", channel_id: "D1", response_url: "https://r" },
      handler: vi.fn(), reservationsHandler, client,
    });
    expect(reservationsHandler.disconnect).toHaveBeenCalledWith({ userId: "U9", channel: "D1", client, responseUrl: "https://r" });
  });
});

describe("dispatch reservation cards", () => {
  const makeHandler = () => ({ channelId: "CRES", handleMessage: vi.fn(), handleCardAction: vi.fn().mockResolvedValue(), handleModalSubmit: vi.fn().mockResolvedValue(), resume: vi.fn(), disconnect: vi.fn() });

  it("routes /reserve to the private question handler", async () => {
    const reservationsHandler = { ...makeHandler(), handleCommand: vi.fn() };
    const client = makeClient();
    const envelope = { type: "slash_command", command: "/reserve", user_id: "U9", channel_id: "CRES", text: "what are my reservations", response_url: "https://r" };
    await dispatchSlackEvent({ slackEnvelope: envelope, handler: vi.fn(), reservationsHandler, client });
    expect(reservationsHandler.handleCommand).toHaveBeenCalledWith({ userId: "U9", channel: "CRES", text: "what are my reservations", client, responseUrl: "https://r" });
    expect(reservationsHandler.disconnect).not.toHaveBeenCalled();
  });

  it("hands block_actions to the card handler too", async () => {
    const reservationsHandler = makeHandler();
    const maintenanceFormHandler = vi.fn().mockResolvedValue();
    const client = makeClient();
    const payload = { type: "block_actions", actions: [{ action_id: "reservation_book" }] };
    await dispatchSlackEvent({ slackEnvelope: { type: "block_actions", payload }, handler: vi.fn(), maintenanceFormHandler, reservationsHandler, client });
    expect(maintenanceFormHandler).toHaveBeenCalledWith({ payload, client });
    expect(reservationsHandler.handleCardAction).toHaveBeenCalledWith({ payload, client });
  });

  it("routes a view_submission to the modal handler", async () => {
    const reservationsHandler = makeHandler();
    const client = makeClient();
    const payload = { type: "view_submission", view: { callback_id: "reservation_edit_modal" } };
    await dispatchSlackEvent({ slackEnvelope: { type: "view_submission", payload }, handler: vi.fn(), reservationsHandler, client });
    expect(reservationsHandler.handleModalSubmit).toHaveBeenCalledWith({ payload, client });
  });

  it("drops a view_submission when reservations are off", async () => {
    const handler = vi.fn();
    await dispatchSlackEvent({ slackEnvelope: { type: "view_submission", payload: {} }, handler, client: makeClient() });
    expect(handler).not.toHaveBeenCalled();
  });
});

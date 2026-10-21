// tests/lambda/clients.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";

const loadConfig = vi.fn();
const createReservationsHandler = vi.fn(() => ({}));
vi.mock("../../src/config.js", () => ({ loadConfig: (...a) => loadConfig(...a) }));
vi.mock("../../src/events/reservations.js", () => ({ createReservationsHandler: (...a) => createReservationsHandler(...a) }));

const { getDeps, _resetForTests } = await import("../../src/lambda/clients.js");

const BASE = {
  slackBotToken: "xoxb", googleClientId: "i", googleClientSecret: "c", googleRefreshToken: "r",
  googleSheetId: "s", anthropicApiKey: "a", slackChannelIds: new Set(["C"]), creaTwa: null, genderSheetId: null,
};

describe("getDeps reservations wiring", () => {
  beforeEach(() => { _resetForTests(); createReservationsHandler.mockClear(); });

  it("gives the handler a booking ledger when only the table is configured (no Google connect)", () => {
    loadConfig.mockReturnValue({
      ...BASE, googleConnect: null,
      reservations: { channelId: "CRES", resourceCalendars: {}, ledgerTable: "T" },
    });
    getDeps();
    const deps = createReservationsHandler.mock.calls[0][0];
    expect(deps.connect).toBeNull();
    expect(typeof deps.ledger.recordBooking).toBe("function");
    expect(typeof deps.ledger.bookingsFor).toBe("function");
    expect(deps.trayStore).toBe(deps.ledger);
  });

  it("has no ledger when no table is configured", () => {
    loadConfig.mockReturnValue({
      ...BASE, googleConnect: null,
      reservations: { channelId: "CRES", resourceCalendars: {}, ledgerTable: null },
    });
    getDeps();
    expect(createReservationsHandler.mock.calls[0][0].ledger).toBeNull();
    expect(createReservationsHandler.mock.calls[0][0].trayStore).toBeNull();
  });
});

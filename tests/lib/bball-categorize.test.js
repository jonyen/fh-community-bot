import { describe, it, expect } from "vitest";
import { categorize } from "../../src/lib/bball-categorize.js";

const BOT = "UBOT";
const reaction = (name, users) => ({ name, users });

describe("categorize", () => {
  it("empty reactions yields empty roster", () => {
    expect(categorize([], BOT)).toEqual({ in: [], out: [], maybe: [] });
  });

  it.each(["basketball", "+1", "white_check_mark"])("%s marks user In", (name) => {
    expect(categorize([reaction(name, ["U1"])], BOT)).toEqual({ in: ["U1"], out: [], maybe: [] });
  });

  it.each(["x", "-1", "nope"])("%s marks user Out", (name) => {
    expect(categorize([reaction(name, ["U1"])], BOT)).toEqual({ in: [], out: ["U1"], maybe: [] });
  });

  it("unknown emoji marks user Maybe", () => {
    expect(categorize([reaction("thinking_face", ["U1"])], BOT)).toEqual({ in: [], out: [], maybe: ["U1"] });
  });

  it("ignores skin-tone modifiers", () => {
    const result = categorize([reaction("+1::skin-tone-3", ["U1"]), reaction("-1::skin-tone-2", ["U2"])], BOT);
    expect(result).toEqual({ in: ["U1"], out: ["U2"], maybe: [] });
  });

  it("filters out the bot user from every category", () => {
    const result = categorize([reaction("basketball", [BOT, "U1"]), reaction("x", [BOT]), reaction("eyes", [BOT])], BOT);
    expect(result).toEqual({ in: ["U1"], out: [], maybe: [] });
  });

  it("In beats Maybe, Out beats Maybe, In beats Out", () => {
    expect(categorize([reaction("basketball", ["U1"]), reaction("eyes", ["U1"])], BOT).in).toEqual(["U1"]);
    expect(categorize([reaction("x", ["U1"]), reaction("eyes", ["U1"])], BOT).out).toEqual(["U1"]);
    expect(categorize([reaction("eyes", ["U1"]), reaction("x", ["U1"])], BOT)).toEqual({ in: [], out: ["U1"], maybe: [] });
    expect(categorize([reaction("x", ["U1"]), reaction("basketball", ["U1"])], BOT)).toEqual({ in: ["U1"], out: [], maybe: [] });
  });

  it("multiple users across categories", () => {
    const result = categorize(
      [
        reaction("basketball", ["U1", "U2"]),
        reaction("+1", ["U3"]),
        reaction("x", ["U4"]),
        reaction("-1", ["U5"]),
        reaction("eyes", ["U6"]),
        reaction("thinking_face", ["U7"]),
      ],
      BOT
    );
    expect(result.in.sort()).toEqual(["U1", "U2", "U3"]);
    expect(result.out.sort()).toEqual(["U4", "U5"]);
    expect(result.maybe.sort()).toEqual(["U6", "U7"]);
  });

  it("deduplicates a user who appears twice in the same category", () => {
    expect(categorize([reaction("basketball", ["U1"]), reaction("+1", ["U1"])], BOT).in).toEqual(["U1"]);
  });
});

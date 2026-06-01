import { WebClient } from "@slack/web-api";
import { fetchWeather } from "../services/weather.js";
import { createPostMessageRunner } from "../events/post.js";

let cachedRun;

function parseChannels(raw) {
  return (raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function getRun() {
  if (!cachedRun) {
    const client = new WebClient(process.env.SLACK_BOT_TOKEN);
    cachedRun = createPostMessageRunner({
      client,
      fetchWeather,
      channels: parseChannels(process.env.BBALL_CHANNEL_IDS),
      botUserId: process.env.SLACK_BOT_USER_ID,
    });
  }
  return cachedRun;
}

export async function handler() {
  return getRun()();
}

export function _resetForTests() {
  cachedRun = undefined;
}

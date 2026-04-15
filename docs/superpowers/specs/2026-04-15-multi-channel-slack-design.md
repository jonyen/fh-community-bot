# Multi-Channel Slack Support Design Spec

## Overview

Allow the maintenance bot to respond in multiple Slack channels instead of only one. All channels share the same Google Sheet with no channel-specific data. Duplicate detection works across all channels naturally because they share the same sheet.

## Changes

### Config (`src/config.js`)

- Rename required env var: `SLACK_CHANNEL_ID` -> `SLACK_CHANNEL_IDS`
- Parse as a comma-separated list: `"C123,C456,C789"` -> `["C123", "C456", "C789"]`
- Trim whitespace from each entry and drop empty entries
- Return as `slackChannelIds` (array), replacing `slackChannelId` (string)

### Slack Handler (`src/handlers/slack.js`)

- Accept `channelIds` (array of strings) in the factory options, replacing `channelId` (string)
- Change the channel filter from `event.channel !== channelId` to `!channelIds.includes(event.channel)`

### Lambda Entry Point (`src/lambda/slack.js`)

- Pass `channelIds: config.slackChannelIds` to `createSlackHandler`

### SAM Template (`template.yaml`)

- Rename parameter `SlackChannelId` -> `SlackChannelIds`
- Update the Lambda environment variable from `SLACK_CHANNEL_ID` -> `SLACK_CHANNEL_IDS`

### Tests

- Update `tests/config.test.js`:
  - Replace `SLACK_CHANNEL_ID` with `SLACK_CHANNEL_IDS` in `VALID_ENV`
  - Assert `config.slackChannelIds` is a parsed array
  - Add a test for comma-separated parsing with whitespace handling
- Update `tests/handlers/slack.test.js`:
  - Change factory calls from `channelId: "C123"` to `channelIds: ["C123"]`
  - Add a test verifying the bot responds in any of multiple configured channels

## Scope and Constraints

- **Backwards compatibility:** None. The `SLACK_CHANNEL_ID` env var is renamed entirely. Deployers must update `.env` / SAM parameters when taking this change.
- **No schema changes** to the Google Sheet.
- **SMS is unaffected** — it has no concept of channels.
- **Duplicate detection, commands, severity flow** — all unchanged.
- **Manager CC** (`U0000000000`) stays hardcoded and applies to all channels.
- **Channel tracking:** We do not record which channel an issue came from.

## What's Not Changing

- Google Sheet schema and storage
- Issue processing, classification, dedup, AI suggestions
- All Slack commands (report, list, close, notes)
- SMS handling
- Lambda infrastructure (other than the renamed parameter)

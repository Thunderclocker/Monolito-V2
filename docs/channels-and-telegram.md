# Channels And Telegram

Telegram is the currently implemented external channel integration.

## Session mapping

Incoming Telegram messages are routed into dedicated sessions with this shape:

`telegram-<chatId>`

That keeps each Telegram chat attached to a stable Monolito session.

## Inbound message format

Telegram messages are normalized into channel-tagged text before entering the runtime.

Depending on the message, Monolito can include:

- plain text
- captions
- photo attachments
- documents
- audio
- video
- voice notes
- video notes

Slash commands sent in Telegram are normalized and passed through the same runtime command handler when possible.
Some commands, such as `/channels` and `/websearch`, are intercepted as interactive Telegram menus instead of plain text handlers.

## Outbound behavior

For Telegram-backed sessions, Monolito can:

- send normal replies back to the chat
- emit typing indicators while a turn is running
- mirror delegated agent summaries back to the chat
- send files or images through Telegram-specific tools when requested
- send generated audio or voice notes through Telegram tools when a TTS backend is configured

Outgoing messages are chunked to fit Telegram limits.

When TTS is configured, the runtime can also generate local speech audio and send it back as:

- Telegram audio
- Telegram voice notes

## Configuration

Channel settings are stored in:

`~/.monolito-v2/channels.json`

Telegram config includes:

- bot token
- enabled flag
- allowed chat IDs

If `allowedChats` is empty, all chats are accepted.

## Commands

Telegram can be configured through:

- `/channels`

Changing Telegram config schedules a daemon restart automatically.

The Telegram `/channels` menu currently supports:

- enable or disable Telegram
- set bot token
- set allowed chats
- clear allowed chats
- refresh current status

These settings are runtime-level settings shared by all Telegram-backed sessions.

## Telegram web search menu

Telegram also exposes `/websearch` as an inline-button menu.

That menu lets the user:

- switch between `default` and `searxng`
- list detected SearxNG containers
- stop the managed SearxNG container
- remove the managed SearxNG container
- clean detected SearxNG containers
- run a test search

Selecting `searxng` triggers the same managed local Docker flow used by the CLI.

The selected web search mode is also a runtime-level setting shared by all sessions.

## Related files

- `~/.monolito-v2/channels.json`
- `~/.monolito-v2/websearch.json`
- `.monolito-v2/logs/monolitod-v2.log`

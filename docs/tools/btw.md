---
summary: "Ephemeral side questions with /btw and /catchup"
read_when:
  - You want to ask a quick side question about the current session
  - You want a catch-up on what happened since your last message
  - You are implementing or debugging BTW behavior across clients
title: "BTW side questions"
---

`/btw` (alias `/side`) asks a quick side question about the **current
session** without adding it to conversation history. It is modeled after
Claude Code's `/btw`, adapted to OpenClaw's Gateway and multi-channel
architecture.

The two side-question contracts are deliberately separate. BTW is a one-shot question on the session's actual model, preserving harness behavior and Codex thread-fork continuity for channel ingress (WhatsApp, Telegram, and Discord), the TUI, and embedded `tui --local`; the TUI stays on BTW by design. Side chat uses a persistent, read-only RPC thread for Control UI-class clients. Its first question lazily prepares bounded visible context from the selected session; a temporary history failure remains retryable and does not run as an empty session. Channels cannot use Side chat because they do not have an RPC connection.

```text
/btw what changed?
/side what does this error mean?
```

## What it does

1. Snapshots the current session as background context (including any
   in-flight main-run prompt).
2. Runs a separate, one-shot side query telling the model to answer only the
   side question and not resume or steer the main task.
3. Delivers the answer as a live side result, not a normal assistant message.
4. Never writes the question or answer to session history or `chat.history`.

The main run, if one is active, is left untouched.

Images attached to the `/btw` message are sent with the side question on
direct-provider runtimes and on the Codex harness. This includes a photo with a
`/btw` caption, or media from the replied-to message when the channel supplies
it as reply context. Other harnesses receive the images as an optional input
and may ignore them. CLI runtimes receive a text note with the number of
omitted images instead. An image that media understanding already described is
not attached, because its description lives in the main conversation prompt,
not in the side question.

When their runtime supplies usage, completed direct-provider and harness side
questions report it through the configured [diagnostics pipeline](/gateway/opentelemetry).
This does not add the exchange to session history or session-derived `/usage cost` totals.

For Codex harness sessions, BTW forks the active Codex app-server thread into
an ephemeral child thread instead of running a separate provider call. This
keeps Codex OAuth and native tool/thread behavior intact, and the forked
thread keeps the parent thread's current approval policy, sandbox, and native
tool surface. The forked thread gets a boundary prompt telling the model that
everything before it is inherited reference context, not active instructions,
and that only messages after the boundary are live. `/btw` requires an
existing Codex thread; send a normal message first.

Eligible Codex side questions can use the same OpenClaw Gateway shell tools as
the main thread. Canceling a side question or reaching its timeout stops native
background terminals owned by the side thread before releasing it. Main-thread
terminals and OpenClaw-managed background jobs keep their existing lifetime.

For CLI runtime aliases, BTW invokes the owning CLI backend in one-shot
side-question mode: it seeds sanitized conversation context into a fresh CLI
invocation with tool bundling and reusable session state disabled, and adds
any no-resume/no-tools flags the backend supports. Direct (non-CLI) runtimes
use a direct one-shot provider call instead.

## What it does not do

`/btw` does not create a durable session, continue the unfinished main task,
or persist question/answer data to transcript history. Detached BTW results do
not survive a reload. Control UI Side chat can rehydrate its in-memory
thread after a reload, but the thread is cleared by a session reset, Gateway
restart, idle expiry, or the rail's clear button.

## Delivery model

Normal assistant chat uses the Gateway `chat` event. Detached BTW uses a
separate `chat.side_result` event so clients cannot mistake it for regular
conversation history. The Control UI does not consume that event; it calls the
`sessions.companion.*` RPCs and renders their bounded exchange state in the rail.

## Surface behavior

| Surface           | Behavior                                                                                                                                                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TUI               | Rendered inline in the chat log, visibly distinct from a normal reply, dismissible with `Enter` or `Esc`.                                                                                                                                    |
| External channels | Delivered as a clearly labeled one-off reply (Telegram, WhatsApp, Discord have no local ephemeral overlay).                                                                                                                                  |
| Control UI / web  | Routes `/btw` and `/side` to the expanded Side chat. The read-only thread is keyed by session, rehydrates from Gateway memory, and preserves a failed question for Retry. It can be cleared with the trash button. `Esc` collapses the rail. |

## Selection popup (Control UI)

Highlighting text inside a chat message in the Control UI opens a small
selection popup with one action:

- **Ask in side chat** opens the rail and pre-fills its composer with a quoted
  draft so you can type your own question about the selection.

The action follows normal `/btw` semantics: the question and answer stay out
of session history and the main run is left untouched.

## `/catchup`: what happened while you were away

`/catchup` is a side question with a fixed prompt. It covers everything in the
session since the last message you typed yourself, and answers with a short,
structured summary:

```text
/catchup
```

- **Window.** It starts at your last typed message (Control UI, TUI, macOS app,
  or a chat channel message from your own account). Messages from crons,
  heartbeats, subagents, other sessions, or `openclaw agent` scripts do not
  count as yours, even though they are stored in the user role.
- **Answer.** Sections for what you asked, where it stands, key facts, what
  waits on you, what is blocked, and what else happened. Every item cites
  numbered messages such as `[7]`, and a **Refs** list at the end gives each
  number its time, author, and a short excerpt.
- **Quote.** On channels such as WhatsApp, when your last message came from the
  same chat, the answer quotes it, so tapping the quote jumps to where the
  catch-up window starts.
- **Delivery.** Like `/btw`, the answer never enters session history and the
  main run is left untouched. Channels show it under a
  `Catch-up since your message at HH:MM` header instead of the BTW banner.
- **Time zone.** Times use `agents.defaults.userTimezone`.
- **Kept answer.** The Gateway keeps the last catch-up per session. Running
  `/catchup` again with no new message in the session returns it at once,
  without another model run. Side chat and `/btw` follow-ups do not count as
  new messages, since they never enter the session; a message in the main
  conversation (including one sent with `/main`) does. The kept answer is in
  memory only, so after a Gateway restart the next `/catchup` runs fresh.

```text
/catchup refresh
```

`/catchup refresh` always runs a new catch-up and replaces the kept one.

In the Control UI, /catchup opens in the Side chat. The kept catch-up survives
closing the Side chat and reloading the page, and the latest catch-up has a
**Refresh** button.

## Follow-ups

The Gateway remembers recent `/btw` and `/catchup` exchanges per session as a
side thread: in memory only, up to 8 exchanges (about 24 KB), and for 60
minutes after the latest one. A Gateway restart clears it.

- **Continue the side chat.** `/btw <question>` while a side thread is live
  passes the earlier exchanges to the side model as earlier side-chat turns.
  Without a live thread, `/btw` behaves as described above.
- **Quote-reply on a channel.** On WhatsApp and other channels that pass the
  quoted message, replying to a side answer with plain text is handled as
  `/btw <your text>`. This applies only to you (the owner, your own linked
  account, or an authorized sender in a direct chat); any other plain message
  goes to the main conversation as usual.
- **Bring it to the main conversation.** `/main <message>` (also as a
  quote-reply to a side answer) sends your message to the main agent with the
  side exchanges attached below it in a `<side_chat_context>` block, then
  clears the side thread. The block is part of the stored user turn, so the
  agent keeps it on later turns. Without a side thread, `/main` sends your
  message alone.

In the TUI, `/catchup` shows its answer inline like `/btw`, `/btw` continues a
live side thread, and `/main <message>` is sent as a normal message. Embedded
`tui --local` runs `/catchup` locally but keeps no side thread, so `/main` there
sends the message alone.

## When to use it

Use `/btw` for a quick clarification, a factual side answer while a long run
is still in progress, or a temporary answer that should not enter future
session context.

```text
/btw what file are we editing?
/btw summarize the current task in one sentence
/btw what is 17 * 19?
```

For anything you want to become part of the session's future working
context, ask normally in the main session instead.

## Related

<CardGroup cols={2}>
  <Card title="Slash commands" href="/tools/slash-commands" icon="terminal">
    Native command catalog and chat directives.
  </Card>
  <Card title="Thinking levels" href="/tools/thinking" icon="brain">
    Reasoning effort levels for the side-question model call.
  </Card>
  <Card title="Session" href="/concepts/session" icon="comments">
    Session keys, history, and persistence semantics.
  </Card>
  <Card title="Steer command" href="/tools/steer" icon="arrow-right">
    Inject a steering message into the active run without ending it.
  </Card>
</CardGroup>

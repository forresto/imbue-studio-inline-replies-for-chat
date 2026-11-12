---
title: "Inline replies for chat"
description: "Select text in any chat message, type a note on it, and your notes go out quoted with your next message. A chat add-on; it does not change the chat itself."
thumbnail: "template.svg"
version: v1
format: v2
---

# Inline replies for chat

This file is the manifest for the **Inline replies for chat** template (slug:
`inline-replies-for-chat`). It is the one document a future agent reads to understand,
present, and adapt this template. If you are an agent in a workspace that was
created from this template, this file is your script: read all of it, then
follow "How to adapt it" below.

## What it is

Select text in any chat message, type a note on it, and your notes go out quoted with your next message. A chat add-on; it does not change the chat itself.

When an agent's reply runs long, answering it point by point usually means
copying passages into the message box by hand. This add-on lets the user select
any passage in a chat message -- their own, a standalone agent reply, or a reply
drawn inside a turn's progress timeline -- and start typing (or click the small
"Add note" chip beside the selection) to pin a note to it. The passage is
highlighted in place, and pending notes collect in a tray just above the message
box; the conversation's bottom edge moves up so the tray never covers the last
message. When the user next sends a message (Enter or the send button), every
pending note is put in front of it as a compact block: a `---` separator, the
short id of the quoted message and its speaker (`#1a2b3c4d Human:` or
`Computer:`), the passage as a `>` quote, then the note. Notes can be edited,
removed or cleared from the tray, and clicking a quote scrolls to and flashes
its passage. Notes are kept per chat in the browser's localStorage, so they
survive a reload; nothing is stored on the server. It is a chat add-on: it does
not change the chat app's code.

## How it works

The snapshot includes these paths (each is a repo-root-relative path copied
from the original agent onto a clean default-workspace-template base):

- `system/chat_addons/`
- `system/test_chat_addons.py`
- `system/supervisord.conf.d/chat.conf`

- `system/chat_addons/inline_notes.js` -- the whole add-on: one self-contained
  script with no dependencies. It reads the chat id from the page's
  `system-interface-chat-id` meta tag (and does nothing in a read-only subagent
  view), watches text selection inside message text, draws its own
  fixed-position chip, note popover and tray, marks pinned passages with the CSS
  Highlight API (it never edits the chat's DOM), and hooks the composer's Enter
  key and send button in the capture phase to prepend the notes through the
  composer's own input event.
- `system/chat_addons/test_inline_notes.py` -- Playwright browser tests
  (marked `browser`): each boots the real chat app over a fixture transcript with
  a recording messenger and the add-on loaded the way `chat.conf` loads it, then
  selects text with real mouse drags and checks what the agent would be sent.
- `system/test_chat_addons.py` -- fast checks pinning the wiring: `chat.conf`
  has exactly one `environment=` line, it still carries `MALLOC_ARENA_MAX="4"`,
  and every `CHAT_JAVASCRIPT_PLUGINS` path is absolute via `%(here)s`, exists,
  has a unique file name, and lives under `system/chat_addons/` rather than the
  chat app's own tree.
- `system/supervisord.conf.d/chat.conf` -- the existing `chat` supervisord
  program. The only change from the stock file is
  `CHAT_JAVASCRIPT_PLUGINS="%(here)s/../chat_addons/inline_notes.js"` appended
  to its single `environment=` line (plus a comment saying why).

At runtime there is no new program and no new port. The `chat` program reads
`CHAT_JAVASCRIPT_PLUGINS` into its config, serves each listed file by its base
name, and adds a `<script>` tag for it to every chat page; the script then runs
entirely in the user's browser. The path must be absolute (hence `%(here)s`):
the chat resolves a relative one against its own package folder, not the
program's `directory=`.

## Recipe

This template is version `v1`. It is not a fork of the
workspace it came from -- it is DERIVED from it by a recipe: include these
paths, leave these out, apply these published-version rules. An update re-runs
the recipe against the current workspace and publishes the result as the next
version, so anything excluded stays excluded even though it still exists in the
source workspace.

The recipe is machine-read, so it lives in the sibling
[`template.toml`](template.toml) -- its `[recipe]` table -- along with
the structured requirements and the environment this template needs
installed. That file is authoritative for all of it; this one holds the prose.

## Requirements

Everything the adopting agent must deal with before this template is really
theirs. Two kinds of entry, handled at different times:

- **Activation** -- what must be SET UP before anything runs, in the
  machine-readable `requires_` forms below. The adopting agent acts on these
  ITSELF, first, before asking anything.
- **Adaptation** -- what must be DECIDED or REWIRED, in prose. Worked through
  interactively with the user, after activation.


No activation requirements: no permissions, secrets or LLM calls.

- The chat's `environment=` line is shared: supervisord keeps only one per
  program, so an adopter who already loads other chat add-ons (or sets other
  variables on the chat program) must merge this add-on's path into their
  existing `CHAT_JAVASCRIPT_PLUGINS` value (comma-separated) and keep
  `MALLOC_ARENA_MAX="4"`, rather than taking this `chat.conf` wholesale. Then
  `supervisorctl reread && supervisorctl update` (or restart `chat`) and reload
  the chat page. `system/test_chat_addons.py` checks the merged line.
- The add-on finds the chat through its CSS class names (`.message-content`,
  `.message-input-textbox`, `.message-input-compose-row`,
  `.message-input-send-button`). If the adopter's chat version renamed any of
  them, update the selectors at the top of `inline_notes.js` to match and re-run
  `system/chat_addons/test_inline_notes.py`.

## Environment

What this template needs INSTALLED, beyond what the template already has.
Declared in `template.toml`'s `[environment]` table; an adopting agent
converges it at ITS OWN pinned apt snapshot timestamp, so package versions come
out consistent with the rest of that agent's environment rather than frozen to
whatever this publisher happened to have.

Nothing extra -- runs on the stock workspace environment.

## How to adapt it

Instructions for the NEXT agent -- the one adapting this template into a
new agent. This is the `use-template` skill's template path; in short:

1. Read this entire file first, especially "Requirements" below. It holds two
   kinds of entry and they are handled at different times: the machine-readable
   `requires_` lines are ACTIVATION (set them up before anything runs), and
   the prose bullets are ADAPTATION (decide or rewire them afterwards).
2. Present the template to the user in plain, non-technical language: what
   it is, what it does, and what it needs from them (name the activation
   requirements).
3. Ask whether they want to use the same connectors (e.g. their own Slack).
   If YES: ACTIVATE FIRST -- initiate every `requires_permission` line NOW
   via a latchkey permission request (see the `connect-external-service` skill; the request
   opens the approval/login flow in the Imbue Studio app), wire up any
   `requires_secret` values, start the services, and get the app showing
   THE USER'S OWN DATA. Done for a data-backed app means the user can open it
   and see their own data -- NOT that a service starts or an endpoint returns
   200. Then tell them it is live and to take a look.
4. Only AFTER that (or immediately, if they chose different connectors -- the
   swap is then the first adaptation) ask: "How do you want to adapt it?"
5. Work through each requirement interactively, one at a time. Translate each
   into plain language, ask for a decision only when you genuinely need one,
   and resolve the obvious ones yourself.
6. When done, append a dated entry to "Adaptation history" below (never
   rewrite earlier entries) and commit.

## Publication history

This template's changelog: what each published version changed. The PUBLISHER
appends one entry per version (newest last); earlier entries are never rewritten.
This is distinct from "Adaptation history" below, which is the ADOPTERS' log.

### v1 (2026-11-12) -- first version: the inline-notes chat add-on, its tests, and the chat setting that loads it.

## Adaptation history

Each agent that adapts this template appends one dated entry below. Earlier
entries are never rewritten.

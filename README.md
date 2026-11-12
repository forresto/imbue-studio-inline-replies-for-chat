<p align="center">
  <img alt="Inline replies for chat" src="template.svg" width="480">
</p>

# Inline replies for chat

<p align="center">
  <a href="https://studio.imbue.com/open?git_url=https://github.com/forresto/imbue-studio-inline-replies-for-chat"><img alt="Open in Imbue Studio" height="64" src="https://img.shields.io/badge/Open%20in%20Imbue%20Studio-D8D1C0?style=for-the-badge"></a>
</p>

Didn't work? Create a Studio workspace and paste this to your agent:
` /use-template https://github.com/forresto/imbue-studio-inline-replies-for-chat`

## Why you care

Select text in any chat message, type a note on it, and your notes go out quoted with your next message. A chat add-on; it does not change the chat itself.

Replying to a long agent message point by point means copying passages into the
message box by hand. With this add-on you select the passage, type your note on
it, and your notes go out quoted with your next message -- like inline comments
on a document, for chat.

## How to use it

1. In any chat, select some text in a message -- yours, the agent's, or a reply
   inside the progress timeline.
2. Start typing (or click **Add note** beside the selection). A small box opens
   with the passage quoted; write your note and press Enter. The passage stays
   highlighted.
3. Pending notes collect in a tray above the message box. Click a note to edit
   it, its quote to jump back to the passage, or remove/clear them.
4. Send your next message as usual (Enter or the send button). Each note goes
   in front of it as a short quoted block, for example:

   ```
   ---
   #1a2b3c4d Computer:
   > Step 3 rebuilds the index from scratch every run.
   Can this be incremental instead?
   ---
   Otherwise looks good.
   ```

   Or press **Send now** in the tray to send them straight away.

Notes are saved per chat in your browser, so a reload keeps them; nothing is
stored on the server.

## Ideas for making it yours

- Change the outgoing format in `notesAsText()` -- for example drop the message
  ids, or use the agent's name instead of "Computer".
- Restyle the highlight colour or the tray to match your theme.
- Raise or lower the 1200-character cap on how much of a passage is quoted.
- Add a keyboard shortcut that opens a note on the current selection.
- Use the same add-on mechanism (`CHAT_JAVASCRIPT_PLUGINS`) to add your own
  chat tweaks alongside this one.

## What this is

This repository is a published **Imbue Studio template**: a clean, bootable
snapshot of what an agent built, ready to adapt into your own. It is NOT the
generic workspace template -- it is this specific project.

[`template.md`](template.md) is the full manifest -- what it is, how it
works, what it needs to run, and what to adapt -- with the
machine-readable half (recipe, requirements, and the environment it needs
installed) in [`template.toml`](template.toml).

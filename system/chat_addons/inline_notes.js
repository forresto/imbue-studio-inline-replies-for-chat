/*
 * Inline notes: select text in any chat message and start typing to pin a note to it. Notes
 * collect in a tray above the composer and all go out with the next message, each quoting the
 * text it was pinned to.
 *
 * Loaded into every chat page as a chat add-on (CHAT_JAVASCRIPT_PLUGINS in
 * system/supervisord.conf.d/chat.conf). It lives outside the chat app's own code so a chat
 * update never conflicts with it, and it touches the chat only through markers the chat's own
 * tests rely on: the `.message-content` text blocks inside the `.message-user` /
 * `.message-assistant` rows and the progress timeline, the `.message-input-textbox`
 * composer, the `.message-input-send-button`, and the `.message-input-compose-row` around them.
 * It never edits the chat's DOM: its tray, popover and button are its own fixed-position
 * elements, and the pinned passages are marked with the CSS highlight API, which leaves the
 * page's nodes alone. Room for the tray is made with a style rule that pads the composer's footer,
 * so the transcript ends above the tray instead of running underneath it.
 */
(() => {
  "use strict";

  const chatId = document.querySelector('meta[name="system-interface-chat-id"]')?.getAttribute("content") ?? "";
  const subagentId = document.querySelector('meta[name="system-interface-chat-agent-id"]')?.getAttribute("content") ?? "";
  // A subagent view is read-only: there is no composer to send notes from.
  if (!chatId || subagentId) return;

  const STORAGE_KEY = `inline-notes:${chatId}`;
  // A message's text block: a user bubble's, a standalone reply's, and the replies drawn inside a
  // turn's progress timeline (which carry no `.message-assistant` row of their own).
  const MESSAGE_SELECTOR = ".message-content, .message-user, .message-assistant";
  const COMPOSER_SELECTOR = ".message-input-textbox";
  const SEND_BUTTON_SELECTOR = ".message-input-send-button";
  const COMPOSE_ROW_SELECTOR = ".message-input-compose-row";
  const MAX_QUOTE_CHARS = 1200;
  const HIGHLIGHT_NAME = "inline-notes";
  // The space kept between the tray and the composer below it, and the transcript above it.
  const TRAY_GAP_PX = 8;
  const TRAY_SPACE_VAR = "--inline-notes-tray-space";

  /** @type {{id: string, quote: string, author: "you" | "agent", note: string, messageId: string}[]} */
  let notes = loadNotes();
  /** Live ranges for the notes made on this page load, by note id; a re-rendered message drops its range. */
  const liveRanges = new Map();
  let popover = null;
  let isSendingFromTray = false;

  function loadNotes() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function saveNotes() {
    if (notes.length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
  }

  // ---------------------------------------------------------------- styles

  const style = document.createElement("style");
  style.textContent = `
    footer:has(${COMPOSE_ROW_SELECTOR}) { padding-top: var(${TRAY_SPACE_VAR}, 0px); }
    ::highlight(${HIGHLIGHT_NAME}) { background-color: color-mix(in srgb, var(--c-warning, #d9a400) 30%, transparent); }
    .inline-notes-el { font-family: var(--font-sans, system-ui, sans-serif); font-size: 13px; color: var(--c-text-primary, #222);
      box-sizing: border-box; }
    .inline-notes-el * { box-sizing: border-box; }
    .inline-notes-chip { position: fixed; z-index: 2147483000; padding: 3px 9px; border-radius: 999px; cursor: pointer;
      border: 1px solid var(--c-border, #ccc); background: var(--c-surface, #fff); color: var(--c-text-secondary, #555);
      box-shadow: 0 2px 8px rgb(0 0 0 / 0.12); font-size: 12px; }
    .inline-notes-chip:hover { color: var(--c-text-primary, #222); background: var(--c-fill-hover, #f2f2f2); }
    .inline-notes-popover { position: fixed; z-index: 2147483001; width: 320px; padding: 10px; border-radius: 10px;
      border: 1px solid var(--c-border, #ccc); background: var(--c-surface, #fff); box-shadow: 0 6px 24px rgb(0 0 0 / 0.18); }
    .inline-notes-popover textarea { width: 100%; min-height: 56px; max-height: 200px; resize: none; padding: 6px 8px;
      border-radius: 6px; border: 1px solid var(--c-border, #ccc); background: var(--c-bg-composer, #fff);
      color: inherit; font: inherit; outline: none; }
    .inline-notes-popover textarea:focus { border-color: var(--c-accent, #4a6cf7); }
    .inline-notes-quote { margin: 0 0 6px; padding-left: 8px; border-left: 2px solid var(--c-warning, #d9a400);
      color: var(--c-text-secondary, #555); font-style: italic; overflow: hidden; display: -webkit-box;
      -webkit-line-clamp: 2; -webkit-box-orient: vertical; white-space: pre-wrap; word-break: break-word; }
    .inline-notes-hint { margin-top: 6px; font-size: 11px; color: var(--c-text-faint, #888); }
    .inline-notes-tray { position: fixed; z-index: 2147482999; max-height: 40vh; display: flex; flex-direction: column;
      border-radius: 10px; border: 1px solid var(--c-border, #ccc); background: var(--c-surface, #fff);
      box-shadow: 0 4px 16px rgb(0 0 0 / 0.12); overflow: hidden; }
    .inline-notes-tray-head { display: flex; align-items: center; gap: 8px; padding: 7px 10px;
      border-bottom: 1px solid var(--c-border-faint, #eee); color: var(--c-text-secondary, #555); }
    .inline-notes-tray-head span { flex: 1; }
    .inline-notes-tray-list { overflow-y: auto; padding: 4px 0; }
    .inline-notes-item { display: flex; gap: 8px; padding: 6px 10px; }
    .inline-notes-item:hover { background: var(--c-fill-hover, #f6f6f6); }
    .inline-notes-item-body { flex: 1; min-width: 0; }
    .inline-notes-item .inline-notes-quote { cursor: pointer; margin-bottom: 2px; }
    .inline-notes-item-note { white-space: pre-wrap; word-break: break-word; cursor: text; }
    .inline-notes-btn { border: 1px solid var(--c-border, #ccc); background: transparent; color: inherit; cursor: pointer;
      border-radius: 6px; padding: 2px 8px; font: inherit; font-size: 12px; }
    .inline-notes-btn:hover { background: var(--c-fill-hover, #f2f2f2); }
    .inline-notes-btn.primary { background: var(--c-accent, #4a6cf7); border-color: var(--c-accent, #4a6cf7);
      color: var(--c-text-on-accent, #fff); }
    .inline-notes-btn.primary:hover { background: var(--c-accent-hover, #3b5be0); }
    .inline-notes-remove { border: none; background: transparent; color: var(--c-text-faint, #999); cursor: pointer;
      font-size: 15px; line-height: 1; padding: 0 2px; align-self: flex-start; }
    .inline-notes-remove:hover { color: var(--c-danger, #c33); }
    .inline-notes-flash { animation: inline-notes-flash 1.2s ease-out; }
    @keyframes inline-notes-flash { from { background-color: color-mix(in srgb, var(--c-warning, #d9a400) 35%, transparent); } }
  `;
  document.head.appendChild(style);

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // ---------------------------------------------------------------- selection

  function messageOf(node) {
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    return element?.closest(MESSAGE_SELECTOR) ?? null;
  }

  /**
   * The current selection, trimmed to the chat message it falls in, else null. A selection often
   * runs past a message's edge (a triple-click, or a drag into the gap below), so an end outside
   * any message is pulled back to the end of the message the selection starts in (and a start
   * outside one forward to the start of the message it ends in).
   */
  function messageSelection() {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0).cloneRange();
    const startMessage = messageOf(range.startContainer);
    const endMessage = messageOf(range.endContainer);
    let message = startMessage ?? endMessage;
    if (!message) {
      const common = range.commonAncestorContainer;
      const container = common.nodeType === Node.ELEMENT_NODE ? common : common.parentElement;
      message = [...(container?.querySelectorAll(MESSAGE_SELECTOR) ?? [])].find((row) => range.intersectsNode(row)) ?? null;
      if (!message) return null;
    }
    if (startMessage !== message) range.setStart(message, 0);
    if (endMessage !== message && (endMessage === null || startMessage === message)) {
      range.setEnd(message, message.childNodes.length);
    }
    const quote = range.toString().trim();
    if (!quote) return null;
    return {
      range,
      quote: quote.length > MAX_QUOTE_CHARS ? `${quote.slice(0, MAX_QUOTE_CHARS)}...` : quote,
      author: message.closest(".message-user") ? "you" : "agent",
      // The nearest element with an id (the message row, or the progress block a reply sits in),
      // where the quote is searched for again to re-mark it after a re-render.
      messageId: message.closest("[id]")?.id ?? "",
    };
  }

  function isTypingTarget(element) {
    return !!element && (element.tagName === "TEXTAREA" || element.tagName === "INPUT" || element.isContentEditable);
  }

  // The "Add note" chip beside a selection, for anyone who does not know they can just type.
  const chip = el("button", "inline-notes-el inline-notes-chip", "Add note");
  chip.type = "button";
  chip.title = "Or just start typing";
  chip.style.display = "none";
  // Keep the selection: a mousedown on a button would otherwise clear it.
  chip.addEventListener("mousedown", (event) => event.preventDefault());
  chip.addEventListener("click", () => {
    const selected = messageSelection();
    if (selected) openPopover({ selected, initialText: "" });
  });
  document.body.appendChild(chip);

  function placeChip() {
    const selected = popover ? null : messageSelection();
    if (!selected) {
      chip.style.display = "none";
      return;
    }
    const rects = selected.range.getClientRects();
    const last = rects[rects.length - 1] ?? selected.range.getBoundingClientRect();
    chip.style.display = "block";
    const chipWidth = chip.offsetWidth;
    // In the right margin, beside the transcript column, level with the selection's last line: out
    // of the text, so it never sits under the pointer mid-selection. With no margin wide enough (a
    // narrow window) it hugs the window's right edge.
    const startElement = selected.range.startContainer.parentElement ?? selected.range.startContainer;
    const column = startElement.closest?.(".message-list") ?? messageOf(selected.range.startContainer);
    const columnRight = column ? column.getBoundingClientRect().right : last.right;
    chip.style.left = `${Math.max(8, Math.min(columnRight + 12, window.innerWidth - chipWidth - 8))}px`;
    chip.style.top = `${Math.max(8, Math.min(last.top - 2, window.innerHeight - 40))}px`;
  }

  let chipFrame = 0;
  document.addEventListener("selectionchange", () => {
    cancelAnimationFrame(chipFrame);
    chipFrame = requestAnimationFrame(placeChip);
  });
  window.addEventListener("scroll", () => (chip.style.display = "none"), true);
  // While a selection is being dragged the chip follows its end, right under the pointer; let the
  // pointer pass through it until the press ends, or it grabs the drag.
  // A press on the chip itself is a click on it, so it keeps the pointer.
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (event.target !== chip) chip.style.pointerEvents = "none";
    },
    true,
  );
  document.addEventListener("pointerup", () => (chip.style.pointerEvents = ""), true);
  document.addEventListener("pointercancel", () => (chip.style.pointerEvents = ""), true);

  // Typing a character while message text is selected opens a note seeded with that character.
  document.addEventListener(
    "keydown",
    (event) => {
      if (popover || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key.length !== 1 || isTypingTarget(document.activeElement)) return;
      const selected = messageSelection();
      if (!selected) return;
      event.preventDefault();
      event.stopPropagation();
      openPopover({ selected, initialText: event.key });
    },
    true,
  );

  // ---------------------------------------------------------------- popover

  /** Close the open note editor, saving what it holds unless `shouldSave` is false. */
  function closePopover({ shouldSave = true } = {}) {
    const open = popover;
    if (!open) return;
    popover = null;
    if (shouldSave) open.commit();
    open.remove();
  }

  /** Open the note editor: for a fresh selection (`selected`) or an existing note (`noteId`). */
  function openPopover({ selected = null, noteId = null, initialText = "" }) {
    closePopover();
    chip.style.display = "none";
    const existing = noteId ? notes.find((note) => note.id === noteId) : null;
    const quote = existing ? existing.quote : selected.quote;

    const editor = el("div", "inline-notes-el inline-notes-popover");
    editor.appendChild(el("div", "inline-notes-quote", quote));
    const input = el("textarea");
    input.placeholder = "Your note on this...";
    input.value = existing ? existing.note : initialText;
    editor.appendChild(input);
    const hint = el("div", "inline-notes-hint", "Enter or click away to save, Shift+Enter for a new line, Esc to discard");
    editor.appendChild(hint);

    // Save the note as typed: an emptied existing note is removed, an empty new one is dropped.
    editor.commit = () => {
      const text = input.value.trim();
      if (existing) {
        if (text) existing.note = text;
        else notes = notes.filter((note) => note !== existing);
      } else if (text) {
        const id = `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        notes.push({ id, quote: selected.quote, author: selected.author, note: text, messageId: selected.messageId });
        liveRanges.set(id, selected.range);
        document.getSelection()?.removeAllRanges();
      } else {
        return;
      }
      saveNotes();
      render();
    };
    popover = editor;
    document.body.appendChild(editor);

    const anchor = selected ? selected.range.getBoundingClientRect() : tray.getBoundingClientRect();
    const width = editor.offsetWidth;
    const height = editor.offsetHeight;
    let top = selected ? anchor.bottom + 8 : anchor.top - height - 8;
    if (top + height > window.innerHeight - 8) top = Math.max(8, anchor.top - height - 8);
    editor.style.top = `${Math.max(8, top)}px`;
    editor.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8))}px`;

    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);

    const fit = () => {
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight + 2, 200)}px`;
    };
    fit();
    input.addEventListener("input", fit);
    // Focus leaving the note saves it -- but not the whole window losing focus (switching to
    // another app), which leaves the note open to come back to.
    input.addEventListener("blur", () => {
      if (popover === editor && document.hasFocus()) closePopover();
    });
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        closePopover({ shouldSave: false });
      } else if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        closePopover();
        // Back to the message box, so a second Enter sends the notes.
        document.querySelector(COMPOSER_SELECTOR)?.focus();
      }
    });
  }

  // A press anywhere outside the open note saves it (the blur would too, but a press on
  // something that takes no focus does not move it).
  document.addEventListener(
    "mousedown",
    (event) => {
      if (popover && !popover.contains(event.target)) closePopover();
    },
    true,
  );

  // ---------------------------------------------------------------- tray

  const tray = el("div", "inline-notes-el inline-notes-tray");
  tray.style.display = "none";
  document.body.appendChild(tray);

  function render() {
    tray.replaceChildren();
    if (notes.length === 0) {
      tray.style.display = "none";
      updateHighlights();
      return;
    }
    const head = el("div", "inline-notes-tray-head");
    head.appendChild(
      el("span", "", notes.length === 1 ? "1 note goes out with your next message" : `${notes.length} notes go out with your next message`),
    );
    const clear = el("button", "inline-notes-btn", "Clear");
    clear.type = "button";
    clear.addEventListener("click", () => {
      if (!window.confirm(`Discard ${notes.length === 1 ? "this note" : `all ${notes.length} notes`}?`)) return;
      notes = [];
      saveNotes();
      render();
    });
    const sendNow = el("button", "inline-notes-btn primary", "Send now");
    sendNow.type = "button";
    sendNow.title = "Send the notes (and anything in the message box) now";
    sendNow.addEventListener("click", sendFromTray);
    head.append(clear, sendNow);
    tray.appendChild(head);

    const list = el("div", "inline-notes-tray-list");
    for (const note of notes) {
      const item = el("div", "inline-notes-item");
      const body = el("div", "inline-notes-item-body");
      const quote = el("div", "inline-notes-quote", note.quote);
      quote.title = "Show in the chat";
      quote.addEventListener("click", () => revealNote(note));
      const text = el("div", "inline-notes-item-note", note.note);
      text.title = "Edit";
      text.addEventListener("click", () => openPopover({ noteId: note.id }));
      body.append(quote, text);
      const remove = el("button", "inline-notes-remove", "×");
      remove.type = "button";
      remove.title = "Remove this note";
      remove.addEventListener("click", () => {
        notes = notes.filter((other) => other !== note);
        liveRanges.delete(note.id);
        saveNotes();
        render();
      });
      item.append(body, remove);
      list.appendChild(item);
    }
    tray.appendChild(list);
    tray.style.display = "flex";
    placeTray();
    updateHighlights();
  }

  /**
   * Make room for the tray: the footer holding the composer grows by the tray's height, so the
   * transcript above it ends where the tray begins rather than running on underneath it.
   */
  let reservedPx = -1;
  function reserveTraySpace() {
    const px = notes.length === 0 ? 0 : tray.offsetHeight + 2 * TRAY_GAP_PX;
    if (px === reservedPx) return;
    reservedPx = px;
    document.documentElement.style.setProperty(TRAY_SPACE_VAR, `${px}px`);
  }

  /** Sit the tray just above the composer, matching its width. */
  function placeTray() {
    reserveTraySpace();
    if (notes.length === 0) return;
    const row = document.querySelector(COMPOSE_ROW_SELECTOR);
    const rect = row?.getBoundingClientRect();
    if (rect && rect.width > 0) {
      tray.style.left = `${rect.left}px`;
      tray.style.width = `${rect.width}px`;
      tray.style.bottom = `${window.innerHeight - rect.top + TRAY_GAP_PX}px`;
    } else {
      tray.style.left = "16px";
      tray.style.width = `${window.innerWidth - 32}px`;
      tray.style.bottom = "16px";
    }
  }

  function trackTray() {
    placeTray();
    requestAnimationFrame(trackTray);
  }
  requestAnimationFrame(trackTray);

  // ---------------------------------------------------------------- highlights

  /** Find `quote` inside `root`'s text, returning a Range over it, or null. Whitespace runs match loosely. */
  function findQuote(root, quote) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let text = "";
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      nodes.push({ node, start: text.length });
      text += node.data;
    }
    const pattern = quote
      .replace(/\.\.\.$/, "")
      .trim()
      .split(/\s+/)
      .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s*");
    if (!pattern) return null;
    const match = new RegExp(pattern).exec(text);
    if (!match) return null;
    const locate = (offset) => {
      for (let i = nodes.length - 1; i >= 0; i--) {
        if (nodes[i].start <= offset) return { node: nodes[i].node, offset: offset - nodes[i].start };
      }
      return null;
    };
    const start = locate(match.index);
    const end = locate(match.index + match[0].length);
    if (!start || !end) return null;
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, Math.min(end.offset, end.node.data.length));
    return range;
  }

  function rangeFor(note) {
    const live = liveRanges.get(note.id);
    if (live && live.startContainer.isConnected && !live.collapsed) return live;
    const message = note.messageId ? document.getElementById(note.messageId) : null;
    const found = message ? findQuote(message, note.quote) : null;
    if (found) liveRanges.set(note.id, found);
    return found;
  }

  function updateHighlights() {
    if (typeof Highlight === "undefined" || !CSS.highlights) return;
    const ranges = notes.map(rangeFor).filter(Boolean);
    if (ranges.length === 0) CSS.highlights.delete(HIGHLIGHT_NAME);
    else CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(...ranges));
  }

  // The transcript re-renders as messages stream in; re-mark the pinned passages after it settles.
  let highlightTimer = 0;
  new MutationObserver(() => {
    if (notes.length === 0) return;
    clearTimeout(highlightTimer);
    highlightTimer = setTimeout(updateHighlights, 300);
  }).observe(document.body, { childList: true, subtree: true, characterData: true });

  function revealNote(note) {
    const message = note.messageId ? document.getElementById(note.messageId) : null;
    if (!message) return;
    message.scrollIntoView({ block: "center", behavior: "smooth" });
    message.classList.remove("inline-notes-flash");
    void message.offsetWidth;
    message.classList.add("inline-notes-flash");
    setTimeout(() => message.classList.remove("inline-notes-flash"), 1300);
  }

  // ---------------------------------------------------------------- sending

  function quoteBlock(text) {
    return text
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
  }

  /**
   * The short tag naming the message a passage sits in: the first 8 characters of the uuid in its
   * page id. A user message's row is `<message uuid>-user` and a standalone reply's
   * `<message uuid>-assistant`, the uuids the agent's own transcript records them under; a
   * timeline reply's is its turn's `progress-section-<user message uuid>-user`, so it is tagged with
   * the message it answers. Empty when the id carries no uuid.
   */
  function shortTag(messageId) {
    const match = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(messageId ?? "");
    return match ? `#${match[0].slice(0, 8)} ` : "";
  }

  /** Each note as a compact block: the tagged speaker of the quoted text, the quote, then the note. */
  function notesAsText() {
    return notes
      .map((note) => `---\n${shortTag(note.messageId)}${note.author === "you" ? "Human" : "Computer"}:\n${quoteBlock(note.quote)}\n${note.note}`)
      .join("\n");
  }

  /** Put the notes in front of whatever the composer holds, through its own input path, and clear them. */
  function injectNotes(textarea) {
    if (notes.length === 0) return;
    const typed = textarea.value.trim();
    textarea.value = typed ? `${notesAsText()}\n---\n${typed}` : notesAsText();
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    notes = [];
    liveRanges.clear();
    saveNotes();
    render();
  }

  function sendFromTray() {
    const textarea = document.querySelector(COMPOSER_SELECTOR);
    if (!textarea) {
      window.alert("The message box is not available right now, so the notes stay here for now.");
      return;
    }
    injectNotes(textarea);
    isSendingFromTray = true;
    try {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    } finally {
      isSendingFromTray = false;
    }
  }

  // Ride along with the chat's own sends: Enter in the composer, or its send button.
  document.addEventListener(
    "keydown",
    (event) => {
      if (isSendingFromTray || notes.length === 0) return;
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      const textarea = event.target instanceof Element ? event.target.closest(COMPOSER_SELECTOR) : null;
      if (textarea) injectNotes(textarea);
    },
    true,
  );
  document.addEventListener(
    "click",
    (event) => {
      if (notes.length === 0 || !(event.target instanceof Element)) return;
      if (!event.target.closest(SEND_BUTTON_SELECTOR)) return;
      const textarea = document.querySelector(COMPOSER_SELECTOR);
      if (textarea) injectNotes(textarea);
    },
    true,
  );

  render();
})();

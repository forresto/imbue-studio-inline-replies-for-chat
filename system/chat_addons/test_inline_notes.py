"""Browser tests for the inline-notes chat add-on (``inline_notes.js``).

Each test boots the real chat app the way ``system/supervisord.conf.d/chat.conf`` runs it -- with
``CHAT_JAVASCRIPT_PLUGINS`` naming the add-on -- over a fixture transcript and a recording
messenger, so a send reaches no agent and the test reads exactly what the agent would have been
sent. The transcript holds a user message, a standalone agent reply, and a turn whose reply is
drawn inside the progress timeline (``.pv-final``), the three places a note can be pinned.

Text is selected with real mouse drags, as a user does it: the press moves focus out of the
composer, which is what lets a typed character open a note instead of landing in the message box.
"""

import os
from collections.abc import Iterator
from pathlib import Path
from typing import Any, Final
from unittest.mock import patch

import pytest
from imbue.chat.testing import (
    FIXTURE_AGENT_ID,
    RecordingMngrMessenger,
    running_workspace,
)
from imbue.mngr.utils.polling import wait_for
from imbue.system_interface.testing import find_free_port
from playwright.sync_api import Browser, Page, expect

pytestmark = [pytest.mark.browser, pytest.mark.timeout(120, func_only=False)]

_PLUGIN_PATH: Final[Path] = Path(__file__).parent / "inline_notes.js"
_CHAT_STATIC: Final[Path] = (
    Path(__file__).resolve().parents[1]
    / "apps"
    / "chat"
    / "imbue"
    / "chat"
    / "static"
    / "chat.html"
)

_USER_TEXT: Final[str] = "Please summarize the quarterly report for the board."
_AGENT_TEXT: Final[str] = "Revenue grew by twelve percent this quarter."
_TIMELINE_TEXT: Final[str] = "The forecast looks steady through the spring."
_STEP_ID: Final[str] = "ab-step-x1y2"
# Message uuids shaped like the real ones: the add-on tags a note with the first 8 characters of
# the uuid in its message's page id.
_USER_UUID: Final[str] = "11111111-aaaa-4aaa-8aaa-000000000001"
_AGENT_UUID: Final[str] = "22222222-bbbb-4bbb-8bbb-000000000002"
_FORECAST_UUID: Final[str] = "33333333-cccc-4ccc-8ccc-000000000003"
_TIMELINE_UUID: Final[str] = "44444444-dddd-4ddd-8ddd-000000000004"


def _assistant(
    uuid: str, content: list[dict[str, Any]], stop_reason: str
) -> dict[str, Any]:
    return {
        "type": "assistant",
        "uuid": uuid,
        "timestamp": "2026-01-01T00:00:00Z",
        "message": {
            "role": "assistant",
            "model": "claude-opus-4-6",
            "content": content,
            "stop_reason": stop_reason,
            "usage": {"input_tokens": 10, "output_tokens": 5},
        },
    }


def _user(uuid: str, content: str | list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "type": "user",
        "uuid": uuid,
        "timestamp": "2026-01-01T00:00:00Z",
        "message": {"role": "user", "content": content},
    }


def _tool_call(
    uuid: str, tool_id: str, command: str, output: str
) -> list[dict[str, Any]]:
    """A Bash call and its result, as a turn that runs ``tk`` records them."""
    return [
        _assistant(
            uuid,
            [
                {
                    "type": "tool_use",
                    "id": tool_id,
                    "name": "Bash",
                    "input": {"command": command},
                }
            ],
            "tool_use",
        ),
        _user(
            f"{uuid}-result",
            [{"type": "tool_result", "tool_use_id": tool_id, "content": output}],
        ),
    ]


_SESSION_EVENTS: Final[list[dict[str, Any]]] = [
    _user(_USER_UUID, _USER_TEXT),
    _assistant(_AGENT_UUID, [{"type": "text", "text": _AGENT_TEXT}], "end_turn"),
    _user(_FORECAST_UUID, "Now check the forecast."),
    *_tool_call(
        "a2",
        "tool-1",
        'tk create --step "Check the forecast"',
        f"Created {_STEP_ID}: Check the forecast",
    ),
    *_tool_call(
        "a3", "tool-2", f"tk start {_STEP_ID}", f"Updated {_STEP_ID} -> in_progress"
    ),
    *_tool_call(
        "a4",
        "tool-3",
        f'tk close {_STEP_ID} "Read the forecast"',
        f"Updated {_STEP_ID} -> closed",
    ),
    _assistant(_TIMELINE_UUID, [{"type": "text", "text": _TIMELINE_TEXT}], "end_turn"),
]

# A session the agent opens on its own: a turn with steps and a reply before any user message. Its
# timeline sits in `progress-section-pre`, an id with no uuid in it.
_OPENING_TEXT: Final[str] = "Good morning, the overnight import finished cleanly."
_OPENING_EVENTS: Final[list[dict[str, Any]]] = [
    *_tool_call(
        "a1",
        "tool-1",
        'tk create --step "Check the import"',
        f"Created {_STEP_ID}: Check the import",
    ),
    *_tool_call(
        "a2", "tool-2", f"tk start {_STEP_ID}", f"Updated {_STEP_ID} -> in_progress"
    ),
    *_tool_call(
        "a3",
        "tool-3",
        f'tk close {_STEP_ID} "Read the import log"',
        f"Updated {_STEP_ID} -> closed",
    ),
    _assistant("a4", [{"type": "text", "text": _OPENING_TEXT}], "end_turn"),
]

_USER_MESSAGE: Final[str] = ".message-user .message-content"
_AGENT_MESSAGE: Final[str] = ".message-assistant .message-content"
_TIMELINE_MESSAGE: Final[str] = ".pv-final .message-content"
_COMPOSER: Final[str] = ".message-input-textbox"
_POPOVER: Final[str] = ".inline-notes-popover"
_POPOVER_INPUT: Final[str] = ".inline-notes-popover textarea"
_TRAY: Final[str] = ".inline-notes-tray"
_TRAY_ITEM: Final[str] = ".inline-notes-item"
_CHIP: Final[str] = ".inline-notes-chip"

# The viewport coordinates of a substring of one element's text: the left edge of its first
# character and the right edge of its last, each at its line's vertical middle.
_SUBSTRING_POINTS_JS: Final[str] = """([selector, needle]) => {
  const root = document.querySelector(selector);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const index = node.data.indexOf(needle);
    if (index < 0) continue;
    const range = document.createRange();
    range.setStart(node, index);
    range.setEnd(node, index + needle.length);
    const rects = range.getClientRects();
    const first = rects[0];
    const last = rects[rects.length - 1];
    return {startX: first.left + 1, startY: (first.top + first.bottom) / 2,
            endX: last.right - 1, endY: (last.top + last.bottom) / 2};
  }
  throw new Error(`"${needle}" is not in ${selector}`);
}"""


class _Chat:
    """The chat page with the add-on, and what its agent has been sent."""

    def __init__(self, page: Page, messenger: RecordingMngrMessenger) -> None:
        self.page = page
        self.messenger = messenger

    def drag_select(
        self, selector: str, needle: str, past_the_end: bool = False
    ) -> None:
        """Select ``needle`` in the element at ``selector`` with a mouse drag (or from it to below the element)."""
        points = self.page.evaluate(_SUBSTRING_POINTS_JS, [selector, needle])
        self.page.mouse.move(points["startX"], points["startY"])
        self.page.mouse.down()
        if past_the_end:
            box = self.page.locator(selector).first.bounding_box()
            assert box is not None
            self.page.mouse.move(
                box["x"] + box["width"] + 40, box["y"] + box["height"] + 20, steps=8
            )
        else:
            self.page.mouse.move(points["endX"], points["endY"], steps=8)
        self.page.mouse.up()

    def sent(self) -> list[str]:
        return [
            message
            for agent_id, message in self.messenger.sent
            if agent_id == FIXTURE_AGENT_ID
        ]

    def wait_for_send(self) -> str:
        wait_for(
            lambda: len(self.sent()) > 0,
            timeout=10.0,
            poll_interval=0.05,
            error_message="no message was sent",
        )
        return self.sent()[-1]

    def stored_notes(self) -> list[dict[str, Any]]:
        return self.page.evaluate(
            "(key) => JSON.parse(localStorage.getItem(key) ?? '[]')",
            f"inline-notes:{FIXTURE_AGENT_ID}",
        )

    def anchor_id(self, selector: str) -> str:
        """The page id of the nearest element with one around the first match of ``selector``."""
        return self.page.locator(selector).first.evaluate(
            "(node) => node.closest('[id]').id"
        )


@pytest.fixture
def chat(
    module_browser: Browser, tmp_path: Path, request: pytest.FixtureRequest
) -> Iterator[_Chat]:
    """The fixture chat's page, served with the add-on loaded.

    The transcript is ``_SESSION_EVENTS`` unless a test passes its own, with the text of the reply
    to wait for, through ``indirect`` parametrization.
    """
    session_events, last_reply = getattr(
        request, "param", (_SESSION_EVENTS, _TIMELINE_TEXT)
    )
    assert _CHAT_STATIC.is_file(), (
        "The chat frontend is not built: run `npm ci && npm run build` in system/"
    )
    messenger = RecordingMngrMessenger(sent=[])
    environment = {
        "CHAT_JAVASCRIPT_PLUGINS": str(_PLUGIN_PATH),
        "CHAT_DATA_DIR": str(tmp_path / "chat-data"),
        "MNGR_AGENT_STATE_DIR": str(tmp_path / "agent-state"),
    }
    with (
        patch.dict(os.environ, environment),
        running_workspace(
            tmp_path,
            find_free_port(),
            find_free_port(),
            session_events=session_events,
            messenger=messenger,
        ) as workspace,
    ):
        context = module_browser.new_context(viewport={"width": 1300, "height": 900})
        try:
            page = context.new_page()
            page.goto(f"{workspace.chat_url}/{FIXTURE_AGENT_ID}")
            expect(page.locator(_TIMELINE_MESSAGE)).to_contain_text(
                last_reply, timeout=30000
            )
            expect(page.locator(_CHIP)).to_be_attached()
            yield _Chat(page, messenger)
        finally:
            context.close()


def test_notes_on_a_user_and_an_agent_passage_go_out_with_the_next_message(
    chat: _Chat,
) -> None:
    page = chat.page

    # A typed character on a selection in the user's own message opens a note seeded with it.
    chat.drag_select(_USER_MESSAGE, "quarterly report")
    page.keyboard.type("C")
    expect(page.locator(_POPOVER_INPUT)).to_be_focused()
    expect(page.locator(_POPOVER_INPUT)).to_have_value("C")
    expect(page.locator(f"{_POPOVER} .inline-notes-quote")).to_have_text(
        "quarterly report"
    )
    page.keyboard.type("heck the totals")
    # Enter saves and hands focus back to the message box, so a second Enter sends.
    page.keyboard.press("Enter")
    expect(page.locator(_POPOVER)).to_have_count(0)
    expect(page.locator(_COMPOSER)).to_be_focused()
    expect(page.locator(_TRAY_ITEM)).to_have_count(1)
    expect(page.locator(_TRAY)).to_contain_text(
        "1 note goes out with your next message"
    )

    # An agent reply drawn inside the progress timeline; clicking away saves this one.
    chat.drag_select(_TIMELINE_MESSAGE, "steady through the spring")
    page.keyboard.type("Why?")
    page.mouse.click(5, 5)
    expect(page.locator(_POPOVER)).to_have_count(0)
    expect(page.locator(_TRAY_ITEM)).to_have_count(2)
    expect(page.locator(_TRAY)).to_contain_text("2 notes go out with your next message")
    assert [
        (note["author"], note["quote"], note["note"]) for note in chat.stored_notes()
    ] == [
        ("you", "quarterly report", "Check the totals"),
        ("agent", "steady through the spring", "Why?"),
    ]
    assert chat.sent() == []

    page.locator(_COMPOSER).click()
    page.keyboard.type("Thanks")
    page.keyboard.press("Enter")

    # Each speaker is tagged with the first 8 characters of its message's uuid; a timeline reply
    # with the uuid of the user message its turn answers.
    assert chat.anchor_id(_USER_MESSAGE) == f"{_USER_UUID}-user"
    assert (
        chat.anchor_id(_TIMELINE_MESSAGE) == f"progress-section-{_FORECAST_UUID}-user"
    )
    assert chat.wait_for_send() == (
        f"---\n#{_USER_UUID[:8]} Human:\n> quarterly report\nCheck the totals\n"
        f"---\n#{_FORECAST_UUID[:8]} Computer:\n> steady through the spring\nWhy?\n"
        "---\nThanks"
    )
    expect(page.locator(_TRAY)).to_be_hidden()
    assert chat.stored_notes() == []


@pytest.mark.parametrize("chat", [(_OPENING_EVENTS, _OPENING_TEXT)], indirect=True)
def test_a_passage_whose_message_id_has_no_uuid_goes_out_with_a_bare_speaker(
    chat: _Chat,
) -> None:
    page = chat.page
    assert chat.anchor_id(_TIMELINE_MESSAGE) == "progress-section-pre"
    chat.drag_select(_TIMELINE_MESSAGE, "overnight import")
    page.keyboard.type("Any errors?")
    page.keyboard.press("Enter")
    expect(page.locator(_TRAY_ITEM)).to_have_count(1)
    page.locator(".inline-notes-btn.primary", has_text="Send now").click()
    assert chat.wait_for_send() == "---\nComputer:\n> overnight import\nAny errors?"


def test_a_note_kept_from_before_messages_were_tagged_goes_out_with_a_bare_speaker(
    chat: _Chat,
) -> None:
    # A note saved by an earlier version of the add-on carries no message id; it still loads and
    # sends, untagged, beside a note made now.
    page = chat.page
    page.evaluate(
        "([key, notes]) => localStorage.setItem(key, JSON.stringify(notes))",
        [
            f"inline-notes:{FIXTURE_AGENT_ID}",
            [
                {
                    "id": "old-1",
                    "quote": "the board",
                    "author": "you",
                    "note": "Which board?",
                }
            ],
        ],
    )
    page.reload()
    expect(page.locator(_TRAY_ITEM)).to_have_count(1)
    # The add-on's tray draws from storage at once; the transcript arrives after it.
    expect(page.locator(_AGENT_MESSAGE).first).to_contain_text("twelve percent", timeout=30000)
    chat.drag_select(_AGENT_MESSAGE, "twelve percent")
    page.keyboard.type("Year on year?")
    page.keyboard.press("Enter")
    expect(page.locator(_TRAY_ITEM)).to_have_count(2)
    page.locator(".inline-notes-btn.primary", has_text="Send now").click()
    assert chat.wait_for_send() == (
        "---\nHuman:\n> the board\nWhich board?\n"
        f"---\n#{_AGENT_UUID[:8]} Computer:\n> twelve percent\nYear on year?"
    )


def test_escape_discards_the_note(chat: _Chat) -> None:
    page = chat.page
    chat.drag_select(_AGENT_MESSAGE, "twelve percent")
    page.keyboard.type("draft")
    expect(page.locator(_POPOVER_INPUT)).to_have_value("draft")
    page.keyboard.press("Escape")
    expect(page.locator(_POPOVER)).to_have_count(0)
    expect(page.locator(_TRAY)).to_be_hidden()
    assert chat.stored_notes() == []


def test_shift_enter_is_a_new_line_and_multiline_quotes_and_notes_keep_their_lines(
    chat: _Chat,
) -> None:
    page = chat.page
    chat.drag_select(_AGENT_MESSAGE, "twelve percent")
    page.keyboard.type("one")
    page.keyboard.press("Shift+Enter")
    page.keyboard.type("two")
    expect(page.locator(_POPOVER_INPUT)).to_have_value("one\ntwo")
    page.keyboard.press("Enter")
    expect(page.locator(_TRAY_ITEM)).to_have_count(1)

    # "Send now" sends the notes alone when the message box is empty, with no trailing separator.
    page.locator(".inline-notes-btn.primary", has_text="Send now").click()
    assert chat.anchor_id(_AGENT_MESSAGE).startswith(_AGENT_UUID)
    assert chat.wait_for_send() == (
        f"---\n#{_AGENT_UUID[:8]} Computer:\n> twelve percent\none\ntwo"
    )
    expect(page.locator(_TRAY)).to_be_hidden()


def test_the_window_losing_focus_keeps_the_note_open(chat: _Chat) -> None:
    page = chat.page
    chat.drag_select(_USER_MESSAGE, "the board")
    page.keyboard.type("x")
    # What an app switch looks like to the page: the field blurs while the document has no focus.
    page.evaluate(
        f"""() => {{
          document.hasFocus = () => false;
          document.querySelector({_POPOVER_INPUT!r}).blur();
        }}"""
    )
    expect(page.locator(_POPOVER)).to_have_count(1)
    expect(page.locator(_POPOVER_INPUT)).to_have_value("x")
    assert chat.stored_notes() == []


def test_a_selection_running_past_a_message_is_trimmed_to_it(chat: _Chat) -> None:
    page = chat.page
    chat.drag_select(_USER_MESSAGE, "summarize", past_the_end=True)
    page.keyboard.type("n")
    expect(page.locator(f"{_POPOVER} .inline-notes-quote")).to_have_text(
        "summarize the quarterly report for the board."
    )
    page.keyboard.press("Enter")
    assert [note["quote"] for note in chat.stored_notes()] == [
        "summarize the quarterly report for the board."
    ]


def test_the_chip_opens_an_empty_note_and_the_tray_edits_and_removes_notes(
    chat: _Chat,
) -> None:
    page = chat.page
    chat.drag_select(_AGENT_MESSAGE, "Revenue grew")
    chip = page.locator(_CHIP)
    expect(chip).to_be_visible()
    # It sits in the margin to the right of the transcript column, clear of the text.
    chip_box = chip.bounding_box()
    column_box = page.locator(".message-list").bounding_box()
    assert chip_box is not None and column_box is not None
    assert chip_box["x"] >= column_box["x"] + column_box["width"]
    chip.click()
    expect(page.locator(_POPOVER_INPUT)).to_have_value("")
    expect(page.locator(_POPOVER_INPUT)).to_be_focused()
    page.keyboard.type("first")
    page.keyboard.press("Enter")
    expect(chip).to_be_hidden()

    # Notes outlive a reload: they are kept per chat in the browser.
    page.reload()
    expect(page.locator(_TRAY_ITEM)).to_have_count(1)
    expect(page.locator(".inline-notes-item-note")).to_have_text("first")

    page.locator(".inline-notes-item-note").click()
    expect(page.locator(_POPOVER_INPUT)).to_have_value("first")
    page.locator(_POPOVER_INPUT).fill("edited")
    page.keyboard.press("Enter")
    expect(page.locator(".inline-notes-item-note")).to_have_text("edited")
    assert [note["note"] for note in chat.stored_notes()] == ["edited"]

    page.locator(".inline-notes-remove").click()
    expect(page.locator(_TRAY)).to_be_hidden()
    assert chat.stored_notes() == []
    assert chat.sent() == []


def test_typing_with_no_selection_goes_to_the_message_box(chat: _Chat) -> None:
    page = chat.page
    page.locator(_COMPOSER).click()
    page.keyboard.type("hello")
    expect(page.locator(_COMPOSER)).to_have_value("hello")
    expect(page.locator(_POPOVER)).to_have_count(0)
    page.keyboard.press("Enter")
    # With no notes pending the message goes out untouched.
    assert chat.wait_for_send() == "hello"


def test_the_tray_never_covers_the_end_of_the_conversation(chat: _Chat) -> None:
    # A short window, so the conversation overflows and sits scrolled to its last reply, right
    # above the composer, where the tray opens.
    page = chat.page
    chat.drag_select(_USER_MESSAGE, "quarterly report")
    page.keyboard.type("Check the totals")
    page.keyboard.press("Enter")
    chat.drag_select(_AGENT_MESSAGE, "twelve percent")
    page.keyboard.type("Year on year?")
    page.keyboard.press("Enter")
    expect(page.locator(_TRAY_ITEM)).to_have_count(2)
    page.set_viewport_size({"width": 1300, "height": 420})
    page.mouse.move(650, 100)
    page.mouse.wheel(0, 5000)

    def last_reply_clears_the_tray() -> bool:
        tray = page.locator(_TRAY).bounding_box()
        reply = page.locator(_TIMELINE_MESSAGE).last.bounding_box()
        return tray is not None and reply is not None and reply["y"] + reply["height"] <= tray["y"]

    wait_for(
        last_reply_clears_the_tray,
        timeout=10.0,
        poll_interval=0.1,
        error_message="the tray covers the last reply",
    )

    # With the notes gone the room it took is given back.
    page.on("dialog", lambda dialog: dialog.accept())
    page.locator(".inline-notes-btn", has_text="Clear").click()
    expect(page.locator(_TRAY)).to_be_hidden()
    assert page.locator(f"footer:has({_COMPOSER})").evaluate(
        "(node) => getComputedStyle(node).paddingTop"
    ) == "0px"

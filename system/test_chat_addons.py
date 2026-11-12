"""The chat program loads this workspace's chat add-ons (``system/chat_addons/``).

``system/supervisord.conf.d/chat.conf`` names them in ``CHAT_JAVASCRIPT_PLUGINS`` on the program's
single ``environment=`` line, beside ``MALLOC_ARENA_MAX``. supervisord keeps only the last of two
``environment=`` keys, so an add-on line added as a second one would silently drop the memory cap
(or the reverse), and a path that no longer resolves leaves every chat page requesting a script
that 404s. The add-ons' behaviour is tested in ``system/chat_addons/``; this pins the wiring.
"""

import configparser
import re
from pathlib import Path
from typing import Final

_REPO_ROOT: Final[Path] = Path(__file__).resolve().parents[1]
_CHAT_CONF: Final[Path] = _REPO_ROOT / "system" / "supervisord.conf.d" / "chat.conf"
_ADDONS_DIR: Final[Path] = _REPO_ROOT / "system" / "chat_addons"
_CHAT_APP_DIR: Final[Path] = _REPO_ROOT / "system" / "apps" / "chat"

# One ``KEY="value"`` pair of supervisord's ``environment=`` syntax.
_ENVIRONMENT_PAIR_RE: Final[re.Pattern[str]] = re.compile(
    r'\s*([A-Za-z_][A-Za-z0-9_]*)="([^"]*)"\s*(?:,|$)'
)


def _chat_environment() -> dict[str, str]:
    """The chat program's environment, failing on a duplicated key (configparser's strict mode)."""
    parser = configparser.ConfigParser(interpolation=None, strict=True)
    parser.read(_CHAT_CONF)
    line = parser.get("program:chat", "environment")
    assert _ENVIRONMENT_PAIR_RE.sub("", line) == "", (
        f'environment= is not all KEY="value" pairs: {line!r}'
    )
    return dict(_ENVIRONMENT_PAIR_RE.findall(line))


def test_chat_conf_has_a_single_environment_line() -> None:
    lines = [
        line
        for line in _CHAT_CONF.read_text().splitlines()
        if line.startswith("environment")
    ]
    assert len(lines) == 1, lines


def test_chat_environment_keeps_the_memory_cap_and_loads_the_addons() -> None:
    environment = _chat_environment()
    assert environment["MALLOC_ARENA_MAX"] == "4"
    assert (
        environment["CHAT_JAVASCRIPT_PLUGINS"]
        == "%(here)s/../chat_addons/inline_notes.js"
    )


def test_every_chat_plugin_resolves_outside_the_chat_app() -> None:
    plugins = [
        path.strip()
        for path in _chat_environment()["CHAT_JAVASCRIPT_PLUGINS"].split(",")
        if path.strip()
    ]
    assert plugins
    # The chat serves plugins by basename, and refuses to start on two with the same one.
    assert len({Path(path).name for path in plugins}) == len(plugins)
    for path in plugins:
        # Absolute once supervisord expands %(here)s (this file's directory): the chat serves a
        # plugin with Flask's send_file, which resolves a relative path against the chat package's
        # own folder rather than the program's directory=, so a relative path 500s on every page.
        assert path.startswith("%(here)s/"), path
        resolved = (_CHAT_CONF.parent / path.removeprefix("%(here)s/")).resolve()
        assert resolved.is_file(), f"{path} does not exist"
        # An add-on stays out of the chat app's own tree, so a chat update never conflicts with it.
        assert resolved.is_relative_to(_ADDONS_DIR), path
        assert not resolved.is_relative_to(_CHAT_APP_DIR), path

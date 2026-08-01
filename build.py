#!/usr/bin/env python3
"""Bundle ZIPPIN into a single self-contained HTML file.

The app is written as ES modules, which browsers refuse to load over file://
(the origin is `null`, so the module fetch is blocked). That makes the source
tree fine for hosting but useless for "here, open this" sharing.

This inlines the stylesheet and concatenates the modules into one classic
script inside an IIFE, producing a zippin.html that works by double-clicking —
no server, no build tooling, no network except the timetable API itself.

    python3 build.py
"""

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).parent
OUT = ROOT / "zippin.html"

# Dependency order: each module may only use names defined above it.
MODULES = ["js/time.js", "js/api.js", "js/plan.js", "js/app.js"]

IMPORT_RE = re.compile(r"import\s*\{[^}]*\}\s*from\s*['\"][^'\"]*['\"];")
EXPORT_RE = re.compile(r"^export\s+", re.MULTILINE)


def strip_module_syntax(src: str) -> str:
    """Turn a module into plain script text: no imports, no export keywords."""
    src = IMPORT_RE.sub("", src)
    src = EXPORT_RE.sub("", src)
    return src.strip()


def main() -> int:
    html = (ROOT / "index.html").read_text()
    css = (ROOT / "styles.css").read_text()

    parts = []
    for name in MODULES:
        src = strip_module_syntax((ROOT / name).read_text())
        parts.append(f"/* ---- {name} ---- */\n{src}")

    # One shared scope, kept out of `window` so nothing leaks to the page.
    script = "(function () {\n'use strict';\n\n" + "\n\n".join(parts) + "\n})();"

    # A stray </script> inside the JS would close the tag early. None today, but
    # this keeps the bundle correct if a string ever contains one.
    script = script.replace("</script>", "<\\/script>")

    before = html
    html = html.replace(
        '<link rel="stylesheet" href="styles.css">',
        f"<style>\n{css}\n</style>",
    )
    if html == before:
        print("error: stylesheet link not found in index.html", file=sys.stderr)
        return 1

    before = html
    html = html.replace(
        '<script type="module" src="js/app.js"></script>',
        f"<script>\n{script}\n</script>",
    )
    if html == before:
        print("error: module script tag not found in index.html", file=sys.stderr)
        return 1

    OUT.write_text(html)
    kb = len(html.encode()) / 1024
    print(f"wrote {OUT.name}  ({kb:.0f} KB, self-contained)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

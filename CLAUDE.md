# Working notes for Claude

## Verification

- Never take screenshots to verify something (it wastes tokens) without the user's explicit permission each time. Permission for one screenshot does not carry over to the next.
- Prefer text-based checks instead: typecheck, tests, console messages, logs, `read_page` / `get_page_text`, or reasoning about the code.

---
name: self-check
description: Exercise every WIDI tool in one fixed flow (ls, find, grep, read, ask_human, write, edit, bash) to smoke-test the harness end to end, cleaning up all artifacts.
---
Run this fixed procedure in order. The goal is to trigger every tool's real execution path — not to inspect configuration. Keep each report to one or two lines. The scratch file is `.widi-self-check.tmp` in the current working directory; nothing else may be created.

1. `ls` the current directory; report the entry count.
2. `find` for `*.md` under `.widi`; report the hit count and names.
3. `grep` for `defaultProvider` in `.widi/settings.json`; report the matching line.
4. `read` `.widi/settings.json`; report what you actually read back (default provider, model, profile).
5. `ask_human` with kind=select and allowFreeInput: ask what to write into the scratch file. Options must include your own suggestion, e.g. `widi self-check scratch` and `self-check <today's date>`; the human may also type a free answer. If the request is dismissed, use your first suggestion.
6. `write` the chosen content to `.widi-self-check.tmp`; report the path.
7. `edit` the file: replace the word `scratch` (or the first line) with `edited`; report the change.
8. `read` the file back; report the final content.
9. `bash` a read-only check (`wc -c .widi-self-check.tmp`); report the output.
10. `bash rm -f .widi-self-check.tmp`, then confirm with `bash` (`test ! -e .widi-self-check.tmp && echo gone`) that nothing is left behind.

Rules:

- Never skip step 10, even if an earlier step failed — report the failure, then clean up anyway.
- If `.widi-self-check.tmp` already exists before step 6, stop and tell the user instead of overwriting it.
- Do not create or modify any other file.
- Finish with a compact summary: one line per tool exercised (ok / failed), the human's answer from step 5, and any diagnostic you noticed along the way.

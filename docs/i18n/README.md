# CLI Copy Export

Generated: 2026-06-22T10:32:20.031Z

Files:

- `cli-runtime-copy-to-translate.json`: recommended handoff file for translators. Source CLI copy only; fill `target`.
- `cli-copy-to-translate.json`: same translator-friendly JSON, but also includes docs/security notice copy.

Translator/editor workflow:

1. Give translators `cli-runtime-copy-to-translate.json` unless docs also need review.
2. They only fill each entry's `target`.
3. They should not change entry ids, `source`, `location`, `category`, `placeholders`, or `note`.
4. Keep placeholders such as `{0}`, `{1}`, command names, flags, URLs, env vars, and JSON field names intact.
5. Return the edited JSON file when translation is done; import will use the entry ids and `target` values.

Current counts:

- Total rows: 1291
- Reviewable rows: 1244
- Runtime review rows: 1120
- Locked rows: 47

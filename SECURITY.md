# Security Policy

## Reporting

Please report security issues privately through the project maintainers instead
of opening a public issue.

## Secrets

Do not commit API keys, npm tokens, registry credentials, `.npmrc`, `.env`, or
generated credential files.

Local credentials are stored outside the repository under:

```text
~/.octoparse/
```

If a secret is committed accidentally:

1. Rotate or revoke it immediately.
2. Remove it from the current tree.
3. Rewrite Git history before making the repository public.
4. Re-run a secret scan on the final branch.

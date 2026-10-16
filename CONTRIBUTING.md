# Contributing

Louibot is a small TypeScript project. Keep changes focused and preserve the local-first workflow, Docker isolation, and human-controlled GitHub mutations.

From the repository root:

```sh
npm ci
npm run format
npm run build
npm test
npm audit --audit-level=high
```

Pull requests should explain the behavior change and include validation results. Do not commit `.louibot/`, credentials, generated `dist/` files, or local logs. Changes to GitHub polling, workspace setup, or sandboxing should include focused tests and should preserve idempotent restart behavior.

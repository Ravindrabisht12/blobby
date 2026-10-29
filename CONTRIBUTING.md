# Contributing to Blobby

Thanks for helping. Blobby is a side project, so replies may take a few days.

## Before you start

- **Bugs:** open an issue with steps to reproduce, what you expected, and your OS, Node version and AI app.
- **Features:** open an issue first so we can agree on the idea before you write code.

## Working on the code

```bash
npm install
npm start          # run the app
npm test           # MCP smoke test
npm run test:ui    # drives the real app (uses a temp folder, never your ~/Blobby)
```

- Plain JavaScript (ES modules), no framework and no build step. Match the style of the file you're editing.
- Keep the MCP tools in `src/mcp/tools.js` small and well described: the AI reads those descriptions.
- Run both test commands before opening a pull request, and add a check to `scripts/ui-e2e.mjs` for UI changes.
- One change per pull request, with a short description of what and why.

By contributing you agree that your contribution is licensed under the MIT License.

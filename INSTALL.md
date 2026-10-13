# Installing annotate (for an agent)

You are setting up the **annotate** Claude Code plugin for the person you work for. Follow these steps in order and report what you verified.

## 1. Check the machine

- Claude Code 2.1.288 or later: `claude --version`
- Node 20 or later: `node --version`
- Google Chrome installed at the usual place (`/Applications/Google Chrome.app` on macOS). Edge works with `ANNOTATE_BROWSER=msedge`.

No Playwright browser download is needed. The plugin drives the installed Chrome with its own profile.

## 2. Add the marketplace and install the plugin

Inside a Claude Code session:

```text
/plugin marketplace add FinalAngel/claude-annotate
/plugin install annotate@claude-annotate
```

Choose **user** scope when asked, so it's available in every project. If the marketplace was cloned locally instead, pass the directory: `/plugin marketplace add /path/to/claude-annotate`.

Claude Code installs the plugin's two npm packages from its lockfile when it copies the plugin into the cache, with install scripts disabled. If `/plugin` later shows a note that the packages are not installed, run `claude plugin update annotate@claude-annotate` to retry, or run `npm install` inside the plugin directory it names.

## 3. Start the session with the channel flag

Exit Claude Code and start it again with:

```sh
claude --dangerously-load-development-channels plugin:annotate@claude-annotate
```

Claude Code shows a full-screen notice about development channels. Pick "I am using this for local development". After the banner a dim line must say that messages from `plugin:annotate@claude-annotate` inject into this session.

If the line says **blocked by org policy**, an admin has to enable channels for the organization (claude.ai → Admin settings → Claude Code → Channels). Until then use Add to chat: the notes go with the next message, which needs no flag.

Suggest an alias for the person, for example in their shell profile:

```sh
alias claude-annotate='claude --dangerously-load-development-channels plugin:annotate@claude-annotate'
```

## 4. Verify

With the Chrome extension set up (`npm run extension:install`, then Load unpacked on `extension/`) and a dev server running: open the page in Chrome and turn annotating on with the extension's icon or `⌥⇧A`.

Expected: a bar at the bottom of the page says *Annotating · 0* and **To** the chat open in Claude Code. Click an element, type a word, press `↵`, then **Add to chat**. Above the prompt of that chat a chip says *1 annotation*; press its **Send** and Claude should read a PNG path from the message.

## 5. Clean up

Turn annotating off with the extension's icon. Temporary screenshots are removed when Claude calls done, on Clear, and when the session ends. The Chrome profile stays in `~/.cache/claude-annotate/chrome-profile/` so logins persist; delete it to reset.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `/mcp` shows the annotate server as failed | The packages did not install, or Node is too old | `claude plugin update annotate@claude-annotate`, or `npm install` inside the plugin directory, then start a new session |
| Marks drawn but Send does nothing | The bridge is unreachable (red dot on the toolbar) | Restart the session; the server and the overlay share one process |
| Progress never shows on the page | Claude is not calling `annotate_progress` | Remind it: the server's instructions describe the protocol |

# claudemd-panel

A Claude Code mod: a side panel for your global instructions file, `~/.claude/CLAUDE.md`, that lets you read it, edit it and review every change before it is saved.

- **See it rendered** beside the chat. Run `/claudemd` to open it.
- **Edit it** in the panel, then review your unsaved changes as a diff and **Save** or **Discard**.
- **Approve Claude's changes.** When Claude wants to change the file (with Edit, Write or its `propose_change` tool), the change shows as a diff with **Accept** and **Reject**. Nothing is written until you press Accept.
- **Never lose a version.** Before every save, the current file is copied to `~/.claude/claude-md-history/` with a timestamp. **History** in the panel compares any copy with the current file and restores it.
- **Changes made elsewhere.** An edit from your own editor is kept, and the version it replaced goes to History. If one of Claude's tool calls changes the file any other way (a shell command, a script), the mod puts your approved version back and shows Claude's version as a proposal.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install claudemd-panel --marketplace CodefiLabs/claudemd-panel
```

Answer `y` to add the marketplace, then press Enter to install for your user (every project on your computer).

From a shell:

```bash
claude plugin install claudemd-panel --marketplace CodefiLabs/claudemd-panel
```

In the Claude desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `CodefiLabs/claudemd-panel`, then **Add plugin**.

Then run `/claudemd` in any session to open the panel.

## Good to know

- `~/.claude/CLAUDE.md` is read when a session starts, so saved changes apply to new sessions.
- The panel shows and edits files up to 256 KB. A larger file is described but not loaded; History still works for it.
- Lines you don't touch keep their own line endings (CRLF or LF). The diff names invisible characters and line-ending changes, so nothing in a proposal is hidden.
- A background job Claude starts that writes the file *after* its tool call has ended is treated like an edit from your own editor: it is kept, and the version before it goes to History.
- Built on Claude Code's function-hooks mod API, which is in early access. Tested on Claude Code 2.1.325 and 2.1.330; update Claude Code first if `/claudemd` doesn't appear after installing.

## Tests

```bash
claude plugin test .
```

The suite runs against an in-memory disk and never touches your real `~/.claude`. Set `CLAUDEMD_PANEL_FILE` to point the mod at a sandbox file instead of `~/.claude/CLAUDE.md` when trying it by hand.

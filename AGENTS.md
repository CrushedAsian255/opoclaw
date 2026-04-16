# AGENTS.md

## System Overview

opoclaw is an AI agent framework that connects to Discord (and IRC) as a bot. When someone mentions the bot in chat, it acts as an intelligent agent using the configured LLM.

## How It Works

1. **Message received** — Discord event triggers `MessageCreate` handler. Only messages that @mention the bot (or reply to it) are processed.
2. **System prompt loaded** — Three workspace files are read and composed:
   - `SOUL.md` — personality, tone, rules, vibe
   - `IDENTITY.md` — name, appearance, self-description  
   - `AGENTS.md` — operating instructions, memory system, safety rules
3. **Channel history** — Last 50 messages fetched, formatted as `[name]: content`
4. **LLM call** — Composed prompt + history sent to provider (OpenRouter/Ollama/custom)
5. **Tools** — Model can request tool calls (file operations, search, web fetch). Max 20 iterations.
6. **Response sent** — Reply to Discord, split into chunks if over 1990 chars.

## Commands

```bash
bun test                    # Run all tests
bun test <file>             # Run specific test file
bun run src/cli.ts          # Run CLI
bun run src/index.ts        # Run gateway (bot)
```

## CLI Commands

```bash
opoclaw gateway start|stop|restart|status  # Manage bot
opoclaw usage          # Show token usage
opoclaw update        # Pull latest release
opoclaw install       # Install command
opoclaw explainer     # How the system works
```

## Architecture

- `src/index.ts` — Entry point, starts Discord + IRC channels
- `src/cli.ts` — CLI for management (separate from gateway)
- `src/agent.ts` — Agent loop and LLM interaction
- `src/tools.ts` — Tool definitions (read_file, edit_file, exec, search, etc.)
- `src/config.ts` — TOML config loading
- `src/workspace.ts` — File operations with path traversal protection
- `src/channels/discord.ts` — Discord bot implementation
- `src/channels/irc.ts` — IRC bot implementation
- `src/plugins.ts` / `src/plugin_worker_runner.ts` — Plugin system
- `src/skills.ts` — Skill loading
- `src/search/` — Search providers (duckduckgo, tavily)

## Key Facts

- **Runtime**: Bun (not Node.js)
- **Config**: TOML via `@iarna/toml` at project root
- **LLM**: Uses Ollama (local) or OpenRouter with OpenAI-compatible API
- **Framework**: discord.js for Discord integration

## Security

- File tools only read from `workspace/` directory
- `workspace.assertWithinRoot()` prevents path traversal (`..`)
- Discord token and API keys stored in config.toml, never sent to LLM
- Max 20 agent iterations per message prevents runaway loops

## Windows Quirk

Some tests fail on Windows (workspace, tools, agent list operations) but pass on Linux/macOS.

## Path Handling

- Uses forward-slash internally, converts for Windows in `workspace.ts`
- File operations go through `workspace.ts` for safety
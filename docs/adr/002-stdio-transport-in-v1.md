# ADR-002: stdio transport in v1

- **Status:** Accepted
- **Date:** 2026-11-16

## Context
- MCP servers can talk over **stdio** (the chat app starts the process) or **Streamable HTTP** (a long-running service clients connect to).
- v1 is single-user and runs on the user's own machine against their own Postgres.
- Hosting is planned for a later iteration (React dashboard, accounts).

## Options considered
1. **stdio** now.
2. **Streamable HTTP** now.

## Decision
stdio in v1; Streamable HTTP when there is a hosted, multi-user version.

## Why
- **Customizable.** Each user runs their own copy, so if they find something they don't like, it's easy for them to make the change, and it only affects them.
- **No hosting cost.**
- **No accounts or logins to build.**
- **Each person's data stays on their own computer.**
- **Simplest start.** It's how Claude Desktop runs local tools.

## Consequences
- Setup is harder for users: they install Node and Postgres and edit a config file, instead of pasting a link.
- It only works on the computer it's installed on: no phone, nothing shared across devices.
- Moving to HTTP later means building logins and keeping each user's data separate.

For this tool, this cost may not be worth it, because simpler to use is better. But I don't want to host it myself, so stdio stays for v1. Revisit if hosting becomes an option.

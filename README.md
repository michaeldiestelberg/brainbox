![brainbox — Einstein peeking out of a box](assets/brainbox.png)

# brainbox (`bbx`)

`bbx` is a CLI that uses [OpenRouter](https://openrouter.ai/) and [Vercel Sandbox](https://vercel.com/docs/sandbox) together. You give it a text-file task and a model ID. It calls that model through OpenRouter, starts an AI agent in a disposable sandbox, downloads the files the agent declared, writes a full observable log, then permanently deletes the sandbox.

Use it to satisfy curiosity about new models. When one shows up on OpenRouter, give it a task, let it operate in a sandbox, and watch what it does. I publish my experiments with new AI models using bbx on [productized.tech/model](https://productized.tech/models).

Sandbox has a generous [Hobby free tier](https://vercel.com/docs/sandbox/pricing). Within those quotas, the sandbox itself does not add extra cost.

- [Using bbx](#using-bbx)
- [Configuration](#configuration)
- [How it works](#how-it-works)
- [Development](#development)



## Using bbx

### What you need

- Node.js 24 or newer
- An [OpenRouter](https://openrouter.ai/) API key
- A [Vercel account](https://vercel.com/signup) and a project. The project does not need any code deployed; it only has to exist so Vercel can issue credentials for Sandbox.
- The [Vercel CLI](https://vercel.com/docs/cli)



### One-time setup

Install `bbx`, add an OpenRouter key, link a Vercel project, and pull a local sandbox token:

```bash
npm install
npm run build
npm link

npm i -g vercel
vercel login
vercel link
vercel env pull .env.local --yes
```

Put `OPENROUTER_API_KEY` in `.env.local` next to your config file (see `.env.example`). `vercel env pull` writes `VERCEL_OIDC_TOKEN`, which authenticates Sandbox. Both stay on your machine and are never copied into the sandbox. The OIDC token expires after about 12 hours; run `vercel env pull .env.local --yes` again if sandbox authentication starts failing.

Then check that everything is in place:

```bash
bbx doctor
```

This repo's committed `bbx.config.json` uses the in-repo `SYSTEM_PROMPT.md` and writes artifacts and logs under `./artifacts` and `./logs`. `bbx doctor` will tell you if the prompt file is missing.

### Write a task

A task is a plain `.txt` file. Put it in `tasks/` (or whichever directory you configured) and describe what you want in ordinary language. For example, `tasks/report.txt`:

```text
Write a one-page briefing on the current state of reusable rockets.
Save the result as a PDF.
```

This repo already includes a few sample tasks (`essay`, `landingpage`, `powerpoint`) if you want to try a run before writing your own.

### Pick a model

`bbx models` reads the public OpenRouter catalog. It does not need credentials.

```bash
bbx models --tool-use
bbx models grok
bbx models claude --tool-use --reasoning
```

`--tool-use`, `--vision`, and `--reasoning` filter the table. A run only accepts a current language model that supports tool use.

### Run it

```bash
bbx run essay --model x-ai/grok-4.6
```

`--model` is required. Task names are relative to the tasks directory; these all work:

```bash
bbx run essay
bbx run essay.txt
bbx run research/report
```

While it runs, the terminal shows a concise live view: reasoning previews, tool calls, and download progress. The full record goes to the log.

Ctrl-C once stops the agent and starts cleanup. Ctrl-C again cancels cleanup immediately.

Useful options when you need them:

- `--reasoning-effort` - one of `provider-default`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh`. Omit it to let the provider decide.
- `--run-id` - override the generated run name when you want a stable directory, for example `--run-id essay-2026-08-09`.
- `--config` - use a different config file. Works on every command.



### What you get

Each run gets an ID like `2026-08-16-x-ai-grok-4.6-ea756923` (UTC date, a filesystem-safe model ID, and a short unique suffix). When the agent finishes, `bbx` downloads the files it declared and deletes the sandbox.

```text
artifacts/<run-id>/                   The deliverables
logs/<run-id>/events.jsonl           Append-only event stream for the whole run
logs/<run-id>/transcript.txt         Human-readable progress (same shape as the live terminal, full text)
logs/<run-id>/result.json            Final status and summary
logs/<run-id>/artifact-manifest.json Sizes and SHA-256 hashes
```

`events.jsonl` is an append-only stream of pretty-printed JSON records separated by blank lines. Command output is stored in full (very large output may still be shortened before it is returned to the model, to protect the context window). The log keeps plaintext reasoning summaries the provider exposes and replaces encrypted reasoning traces with a placeholder; providers do not expose private hidden chain-of-thought.

`transcript.txt` mirrors the live terminal progress (run header, thinking, tool calls/results, phases). Reasoning and tool-call details are written in full instead of the short previews shown on screen.

If a run fails or hits a limit, `bbx` still tries to salvage whatever is already in the sandbox artifact directory into `artifacts/<run-id>.partial`.

## Configuration

`bbx` reads `bbx.config.json` from the current directory unless you pass `--config`. Relative paths resolve from the config file, so tasks, artifacts, and logs stay next to the config even if you run `bbx` from somewhere else. Absolute paths outside the project are fine too.

```json
{
  "tasksDir": "./tasks",
  "artifactsDir": "./artifacts",
  "logsDir": "./logs",
  "systemPromptFile": "./SYSTEM_PROMPT.md",
  "limits": {
    "turns": 200,
    "durationMinutes": 60
  }
}
```


| Field                      | Purpose                                                                  |
| -------------------------- | ------------------------------------------------------------------------ |
| `tasksDir`                 | Where `.txt` task files live                                             |
| `artifactsDir` / `logsDir` | Where each run's output is written                                       |
| `systemPromptFile`         | Instructions given to the agent. Edit the file; the next run picks it up |
| `limits.turns`             | Maximum agent steps in a run                                             |
| `limits.durationMinutes`   | Wall-clock budget for the run                                            |


`bbx` loads `.env.local` (falling back to `.env`) from the directory that contains the config file, not from your current working directory.

## How it works

`bbx` is a single Node.js CLI. There is no server and no UI. A run creates a sandbox, lets a model operate it through tools, downloads what the model produced, records the whole thing, and deletes the sandbox.

### The loop

The agent is a simple tool loop:

1. `bbx` creates a disposable Linux sandbox and an artifacts directory inside it.
2. It sends the system prompt and your task to the model, along with a small set of tools.
3. The model thinks, calls a tool, gets the result, and repeats.
4. When the work is genuinely done, the agent calls `finish_task` with a short summary and the files (or directories) to download.
5. `bbx` copies those files to your machine, writes the log, and permanently deletes the sandbox.

If the model stops with an ordinary text reply instead of `finish_task`, `bbx` asks it to keep going. The loop ends when `finish_task` is accepted, or when the turn or time limit is reached.

Deliverables have to live under `/vercel/sandbox/artifacts`. Everything else in the sandbox is temporary.

### The system prompt

The system prompt is deliberately short - a few paragraphs, not a handbook - so anyone using `bbx` can read and change it. It lives in the file named by `systemPromptFile`. The in-repo template is `SYSTEM_PROMPT.md`. Edit the file; no rebuild is required.

It tells the agent that it has full control of a disposable Linux sandbox, that deliverables belong in `/vercel/sandbox/artifacts`, and that it must call `finish_task` when the work is complete.

### The tools

The agent gets a short list of tools. Together they are enough to operate the computer: run commands, inspect and edit files, look at images, and hand back the result.

- `run_command` - Run a shell command in the sandbox. Pipes, redirects, and `sudo` work. Can run in the foreground or detach a long-running process.
- `command_status` - Check, wait for, or read output from a detached command.
- `kill_command` - Stop a detached command.
- `read_file` - Read a sandbox file in chunks.
- `write_files` - Write one or more files.
- `list_files` - Inspect a directory tree (type and size).
- `view_image` - Look at an image in the sandbox when the selected model supports vision. Images are re-encoded as JPEG under a ~100KB budget (and downscaled if needed). Only the latest screenshot stays in the model context; earlier ones become short text stubs.
- `finish_task` - End the run with a summary and the artifact files or directories to download.

The sandbox has network access, so the agent can install packages and fetch whatever it needs to do the job.

## Development

```bash
npm test
npm run typecheck
npm run build
npm run dev -- --help
```


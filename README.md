# Jira tasks: an Agents Hub plugin

A "Jira tasks" view in the hub's sidebar: which Jira tasks the agents are working on now and which are done.

- For each task: the key (a link to Jira), the summary, the status and assignee in Jira, when it was last mentioned.
- The hub's mark: **in progress** (an agent is busy with it in this turn, or a hub task about it is open), **waits for
  you** (an agent's question or its "waiting for the owner" names the task), **agents handed in** (the tasks are
  closed), **today / quiet**. A click on the mark opens the right session; the agent buttons open their sessions.
- Filters "In progress", "Waiting for you", "Closed", "All" and a search by key or word.

## How it works

The plugin process (`main.py`) only reads the hub journal: which tasks the hub's tasks, messages and session turns
mentioned (command output does not count: keys turn up there by chance). **It takes the statuses from Jira through
the Atlassian MCP (Rovo) already connected to the hub**, with the same login as the sessions; no token of its own is
needed. In Jira the plugin only reads: a JQL search and reading a task. A task moved to another project is found by its
old key.
The board shows only the tasks whose Jira assignee is you (`assignee = currentUser()` under your Atlassian login):
your colleagues' tasks that were mentioned are not shown.

It writes nothing to the hub or to Jira. It does not change the hub code.

## The "?" button

Each task has a "?" button next to its statuses: a click sends the hub "what is the status of KEY?" as your message,
and the answer comes in the hub session. After sending it shows "✓" for a minute (so you do not ask twice by accident);
if the hub refuses, the button turns red with the reason in its tooltip.

## Language

The view follows the hub page language: English by default, Russian when the hub page is in Russian.

## Requirements

- A hub with Plugin API 1.29 or newer (the "?" button sends its message with `hub.send`).
- The Jira links module in `hub.json`: `"jira": {"url": "https://<site>.atlassian.net", "projects": ["ABC", …]}`.
- The Atlassian MCP in the hub catalog (`hub.json` → `mcp`, a server on `mcp.atlassian.com`, for example through
  `mcp-remote`) with a completed login. Without it the view works on the hub's data, without Jira statuses.

The code is MIT.

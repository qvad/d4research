# Product Concepts

d4research keeps one visible investigation authoritative while provider runtimes and devices may
change underneath it.

## Environment

One running d4research server and the machine it controls: its filesystem, provider CLIs and
credentials, settings, projects, local Memo, and runtime state. A remote browser connects to an
environment; it does not move those resources to the browser device.

## Project

An environment-local workspace rooted at a directory. Threads, terminals, source-control status,
and checkpoints are associated with a project.

## Thread and Turn

A **thread** is the durable, visible conversation and work history for a project. A **turn** is one
user request and the provider work that follows it. Reloading or reconnecting reads the same thread;
it does not create a replacement history.

## Provider and Model

A **provider** is the local agent runtime d4research controls, such as Codex, Claude, Cursor, Grok,
Junie, OpenCode, or Agy. A provider instance can represent a separate account or configuration. A
model selection always belongs to a provider instance.

Pipelines record the requested target and the target that actually ran. An explicitly authored
fallback is not an alias and is never reported as the unavailable requested model.

## Workflow and Delegation

The composer's **Workflows** menu selects Chat/Plan, a named Dev pipeline, or a named Research
scenario. Research and Dev share target resolution, explicit fallback policy, tracing, and
server-enforced budgets.

A **delegation** is a real, bounded provider call made by the orchestrator. Delegates cannot
delegate again. A skipped or failed call stays that way in the run record; model-written prose
cannot turn it into a successful call.

An **inline delegation** is the same bounded call made without a pipeline: open a message with
`!provider:model` and that one message is answered by the model you named, leaving the chat's own
model, session, and history untouched.

## Handoff

A handoff changes the provider/model attached to the same thread. The visible transcript remains
authoritative.

Choosing another provider in a chat that has already started only _stages_ the switch — nothing runs
yet, and the composer tells you the next message will hand off. That next message is the handoff:
d4research attaches a bounded transcript to what you wrote, and the new provider answers your
instruction. Automatic handoffs do not wait for compression or a Memo write. You can switch chats
after sending; an accepted turn continues on its original thread. The context travels in the saved
message, without requiring a separate searchable Memo record.

The attached context keeps the original task and recent messages, up to 60,000 characters, with
less space available for very long instructions. Omitted history is marked. A failed or disconnected
send is not a completed handoff; check the original thread for the sent message or error.

In the thread, a handed-off message carries a compact **Handed off to …** row above your normal
message bubble; expand it to read the context that travelled with it. Handoffs from older versions
of d4research were a separate machine-written turn, and those still fold away behind the same row.

### Meko handoff memory

To keep a verified copy in Meko, select **Meko MCP** under **Settings → General → Handoff →
Handoff memory**. Set your Streamable HTTP MCP endpoint, datapack ID, and agent ID. Credentials
come from the named environment variable on the machine running the d4research server, not from
the browser. For an unauthenticated local endpoint, clear the credential variable field.

This is opt-in: context goes to the endpoint you configure, which may be hosted. **Inspect API**
checks connectivity and compatible tools without saving a test record. Automatic handoffs save
their attached context in the background and verify it by hash. Successful saves do not add chat
messages; failures appear in the thread and do not stop the receiving provider. No compression
model or provider session runs as part of the Meko save.

**Recent operations** shows this server process’s bounded receipt history. MCP-capable agents can use
`handoff_status` and `handoff_recall` to retrieve an exact verified checkpoint for their current
thread. Retrieved content is reference material, not a replacement for the conversation. These
receipts are not a permanent checkpoint browser and clear when the server restarts.

Select **Local Memo** or **No memory copy** to stop new Meko saves. This does not delete records
already stored in Meko. Local Memo documents and research memory keep their existing backend.
Meko’s datapack access rules determine who can read the stored artifacts.

## Memo

Memo is local shared memory for handoff context and research findings. The built-in backend is an
environment-local SQLite database. Oversized text attachments are committed as chunks plus a final
manifest, and the turn carries compact tokens used to retrieve relevant chunks. The external
`memo-rest` backend is an explicit alternative, not a hidden hosted dependency.

## Checkpoint

A checkpoint is a hidden source-control snapshot taken around a turn so file changes can be diffed
or restored. It is separate from the conversation transcript and provider-native session history.

Next: [Install and First Run](./install.md), [Starter Research](./starter-research.md), and
[Troubleshooting](./troubleshooting.md).

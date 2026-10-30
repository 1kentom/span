# Generated image previews

Issue #55 adds a saved-path fallback after completed tool calls. Valid inline raster content continues to take precedence. A path is not an operating-system open request and does not authorize a network request.

The fallback reads only the currently selected workspace. The client sends the exact originating workspace root to the existing generated `read_image` command. A blocking worker holds the workspace selector and core workspace locks while checking that root and reading the file. Core canonicalization rejects traversal and escaping symlinks. PNG, JPEG, GIF and WebP retain the existing 8 MiB byte and image dimension limits. Other formats, outside paths, missing files and changed workspaces produce a visible refusal in the tool row.

The UI retains up to 32 recent completed-tool previews and 32 MiB of decoded image bytes per controller. A shared semaphore permits at most two native reads across controller disposal and replacement. Session identifiers distinguish delegated tools with the same tool call identifier. Feed pruning, path changes, session/workspace changes and disposal discard queued work and stale completions. Clicking a thumbnail opens the existing attachment viewer from retained bytes. This does not save another copy or reread a workspace path.

Existing preview callers that do not supply an expected root retain the workspace captured when their command is invoked. They do not switch a queued relative-path read to a newly selected workspace.

## Protocol evidence

- [ACP content](https://agentclientprotocol.com/protocol/v1/content) describes inline image data and optional URIs. Inline bytes remain the preferred input.
- [ACP security](https://agentclientprotocol.com/protocol/v1/security) treats agent-provided paths and URIs as untrusted, requires scoped file access, and warns against automatic URI fetching and operating-system opens.

This implementation deliberately adds no guessed provider output roots. An image written outside the open workspace is refused. Supporting another approved root requires a separate explicit native policy. Live provider output locations and installed-app thumbnail/viewer acceptance remain to be verified; source tests and a browser fixture are not evidence of a completed provider integration.

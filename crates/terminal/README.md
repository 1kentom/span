# Interactive terminal

`span-terminal` owns user-started PTYs through portable-pty 0.9.0. Unix uses native PTYs, and Windows uses ConPTY. The shell starts directly with an explicit canonical directory inside the open workspace. No command string is built from a path. Finder launch environments receive an augmented child-only PATH.

`TerminalManager::create` returns `TerminalInfo` and a bounded Tokio event receiver. The desktop bridge must drain that receiver into the channel supplied on create, before returning the terminal ID. Registering a separate output listener after create can lose initial shell output. If the desktop channel closes, close the session. Apply output flow control in the bridge so a slow UI does not accumulate unbounded transport messages.

Rust DTOs derive `specta::Type`. Export them through the existing generated IPC contracts. The panel's `TerminalTransport` is a local UI adapter contract, rather than an independently declared serialized IPC model.

PTY reads use dedicated threads. Spawn, writes, resizing and termination use Tokio's blocking pool. Output chunks are at most 8 KiB, the receiver holds at most 64 events, and backend scrollback holds at most 256 KiB. Input is limited to one MiB per call, dimensions to 2 through 1000, and a workspace to 12 sessions. The frontend xterm display retains 5000 lines.

Explicit close stops the foreground process group and shell, then releases PTY handles and reaps the child. Manager drop also cleans up owned sessions. The application must close all sessions before changing workspace and on application quit. Hiding the terminal panel preserves the session. Commands may have side effects before termination, so application quit policy should account for active sessions.

Markdown Run is an explicit user action. Send stages exact text in a reviewable draft with a separate Run draft button. It does not write multiline text to a shell, because intermediate newlines could execute commands. Nothing executes during Markdown rendering. This terminal does not advertise ACP terminal tools or grant an agent execution permission.

Real PTY tests on macOS cover UTF-8 I/O, native resize, cwd and symlink rejection, spawn failure, exit status, Ctrl-C, foreground cleanup on close and drop, bounded scrollback, and close during output backpressure. Cross-platform roundtrip, cwd, resize, spawn-failure and exit tests include Windows command variants. Windows and Linux runtime behavior still require native validation on those operating systems. The browser preview cannot execute native PTY processes.

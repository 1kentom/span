# Span command line

The native application accepts folder and file requests from the invoking shell:

```sh
span .
span "path/to/my project"
span src/main.rs:12:3
span --goto src/main.rs:12 other.rs
span -- --filename-starting-with-hyphen
span --help
span --version
```

Paths are relative to the shell's working directory, including when a running instance receives a forwarded request. Quote paths containing spaces. Files must exist. Line and column numbers are 1-based. A literal existing filename containing colons takes precedence over interpreting its suffix as a location. Otherwise the parser reads at most two numeric suffixes from the right, preserving Windows drive letters and other filename colons.

One request can contain a folder and files inside it, or multiple files sharing a filesystem root. When only files are supplied, their nearest common parent becomes the project folder. Only one folder is accepted per request. Startup and forwarded requests are queued until the frontend is ready. Changing projects uses the same unsaved changes guard as opening a folder in the UI. `--help` and `--version` exit without opening the GUI. `--new-window` and `--wait` are not implemented and are rejected.

## Install the command

CLI installation is an explicit action after the final native app has been installed. The repository does not automatically change shell configuration or install a link during builds.

On macOS, with the application installed at `/Applications/span.app`:

```sh
bash scripts/install-cli.sh --dry-run
bash scripts/install-cli.sh
```

The link targets `/Applications/span.app/Contents/MacOS/span-desktop`. The script prefers a writable `/opt/homebrew/bin` or `/usr/local/bin` already on PATH, then falls back to `~/.local/bin`. It prints when the chosen directory needs adding to PATH. A conflicting `span` command is an error. It never overwrites an unrelated executable or link.

To choose a prefix, or use another installed app location:

```sh
bash scripts/install-cli.sh --prefix "$HOME/.local" --target /Applications/span.app/Contents/MacOS/span-desktop --dry-run
```

On Linux, install the native application first, then point the helper at its installed executable:

```sh
bash scripts/install-cli.sh --target /absolute/path/to/span-desktop --dry-run
bash scripts/install-cli.sh --target /absolute/path/to/span-desktop
```

The link requires that executable to remain at its installed location. CLI packaging and launch behavior must still be checked on each target platform.

On Windows, installer PATH registration is not configured. Invoke the installed executable directly in PowerShell, replacing its path with the installation location:

```powershell
& 'C:\path\to\span-desktop.exe' .
& 'C:\path\to\span-desktop.exe' --goto 'C:\project\src\main.rs:12:3'
```

A manual PowerShell helper can be added to your own profile after confirming the executable path. The application does not modify your profile or claim installer PATH integration.

## Recent projects

Successful folder opens record the canonical project root, display name, and last-opened time in the user profile's `.config/span/recent-projects.json`. The history keeps at most 50 distinct projects, newest first, separately from the last saved workspace session. Concurrent updates use an operating system file lock and atomic replacement. A malformed history file is reported without silently overwriting it.

Missing or moved folders remain visible as unavailable history entries. A missing folder does not make loading history fail. Removing an entry or clearing history changes only this history file. It does not delete project files, code, or the saved workspace session.

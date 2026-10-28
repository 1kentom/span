#!/usr/bin/env python3
"""Real-process launcher checks. Python and a C compiler are test dependencies only."""
import json
import os
from pathlib import Path
import plistlib
import signal
import shutil
import subprocess
import sys
import tempfile
import time

SCRIPTS = Path(__file__).resolve().parent
with tempfile.TemporaryDirectory(prefix="span launcher ü ") as temporary:
    root = Path(temporary)
    log = root / "process.log"
    app = root / "Fixture.app"
    binary = app / "Contents/MacOS/span-desktop"
    binary.parent.mkdir(parents=True)
    (app / "Contents/Info.plist").write_bytes(plistlib.dumps({
        "CFBundleExecutable": "span-desktop", "CFBundleIdentifier": "dev.span.launcher-fixture",
        "CFBundleName": "Span launcher fixture", "CFBundlePackageType": "APPL",
    }))
    source = root / "fixture.c"
    source.write_text('''#include <stdio.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc > 1 && strcmp(argv[1], "--help") == 0) { puts("fixture help"); return 0; }
  if (argc > 1 && strcmp(argv[1], "--version") == 0) { puts("fixture version"); return 0; }
  FILE *f = fopen(''' + json.dumps(str(log), ensure_ascii=True) + ''', "a");
  if (!f) return 2;
  fprintf(f, "PID:%d PGID:%d\\n", getpid(), getpgrp());
  for (int i = 1; i < argc; i++) fprintf(f, "ARG:%s\\n", argv[i]);
  fprintf(f, "END\\n"); fclose(f);
  sleep(60); return 0;
}
''')
    subprocess.run(["cc", str(source), "-o", str(binary)], check=True)
    prefix = root / "prefix"
    subprocess.run(["bash", str(SCRIPTS / "install-cli.sh"), "--target", str(binary), "--prefix", str(prefix)], check=True, env={**os.environ, "PATH": "/usr/bin:/bin"})
    launcher = prefix / "bin/span"
    plain = root / "plain executable"
    shutil.copy2(binary, plain)
    fallback_prefix = root / "fallback prefix"
    subprocess.run(["bash", str(SCRIPTS / "install-cli.sh"), "--target", str(plain), "--prefix", str(fallback_prefix)], check=True, env={**os.environ, "PATH": "/usr/bin:/bin"})
    fallback_launcher = fallback_prefix / "bin/span"
    cwd = root / "invoking folder ü"
    cwd.mkdir()
    for name in ["file ü.rs", "second.rs", "--help"]:
        (cwd / name).write_text("fixture")
    processes = []
    children = []
    def records():
        return log.read_text().split("END\n")[:-1] if log.exists() else []
    try:
        for number, (active_launcher, args) in enumerate([
            (launcher, ["--goto", "file ü.rs:12:3", "second.rs"]),
            (launcher, ["--", "--help"]),
            (launcher, []),
            (fallback_launcher, ["."]),
        ], 1):
            # Keep the invoking foreground group alive after the wrapper returns,
            # then interrupt that entire group as a terminal would do.
            host = subprocess.Popen([sys.executable, "-c", "import subprocess,sys,time; subprocess.run(sys.argv[1:],check=True); print('RETURNED',flush=True); time.sleep(60)", str(active_launcher), *args], cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True, text=True)
            processes.append(host)
            start = time.monotonic()
            import selectors
            selector = selectors.DefaultSelector()
            selector.register(host.stdout, selectors.EVENT_READ)
            assert selector.select(5), "launcher kept terminal stdout attached"
            assert host.stdout.readline().strip() == "RETURNED"
            assert time.monotonic() - start < 5
            deadline = time.monotonic() + 10
            while len(records()) < number and time.monotonic() < deadline:
                time.sleep(0.05)
            assert len(records()) == number, "native fixture did not launch"
            record = records()[-1]
            pid = int(record.splitlines()[0].split()[0].split(":")[1])
            children.append(pid)
            pgid = int(record.splitlines()[0].split()[1].split(":")[1])
            assert pgid != host.pid, "GUI retained the terminal process group"
            os.killpg(host.pid, signal.SIGINT)
            host.communicate(timeout=5)
            os.kill(pid, 0)
            time.sleep(0.1)
            os.kill(pid, 0)
        assert f"ARG:{cwd.resolve()}/file ü.rs:12:3" in records()[0]
        assert f"ARG:{cwd.resolve()}/second.rs" in records()[0]
        assert f"ARG:{cwd.resolve()}/--help" in records()[1]
        count = len(records())
        assert subprocess.check_output([str(launcher), "--help"], text=True).strip() == "fixture help"
        assert subprocess.check_output([str(launcher), "--version"], text=True).strip() == "fixture version"
        assert len(records()) == count, "informational commands launched GUI"
        print("Real process checks passed: immediate return, SIGINT isolation, repeated launch, spaces, Unicode, goto, --, help/version")
    finally:
        for host in processes:
            if host.poll() is None:
                os.killpg(host.pid, signal.SIGTERM)
                host.communicate(timeout=5)
        for pid in children:
            try: os.kill(pid, signal.SIGTERM)
            except ProcessLookupError: pass

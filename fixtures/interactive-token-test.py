import json
import os
import pty
import select
import signal
import sys
import termios
import time

script = sys.argv[1]
token1 = "github_pat_" + "A" * 32
token2 = token1 if sys.argv[2] == "same" else "github_pat_" + "B" * 32
pid, master = pty.fork()
if pid == 0:
    os.execvp("bash", ["bash", script])

output = b""
sent_first = False
sent_second = False
deadline = time.monotonic() + 15
status = None
while time.monotonic() < deadline:
    ready, _, _ = select.select([master], [], [], 0.1)
    if ready:
        try:
            chunk = os.read(master, 4096)
        except OSError:
            chunk = b""
        output += chunk
    # bash can print the prompt just before read -s disables terminal echo.
    # Wait for the PTY state rather than racing the prompt.
    try:
        silent = not (termios.tcgetattr(master)[3] & termios.ECHO)
    except (OSError, termios.error):
        silent = False
    if silent and b"Actions token: " in output and not sent_first:
        os.write(master, (token1 + "\n").encode())
        sent_first = True
    elif silent and b"Secrets token: " in output and not sent_second:
        os.write(master, (token2 + "\n").encode())
        sent_second = True
    waited, status = os.waitpid(pid, os.WNOHANG)
    if waited:
        break
else:
    os.kill(pid, signal.SIGKILL)
    os.waitpid(pid, 0)
    raise RuntimeError("Token setup test timed out")

text = output.decode("utf-8", "replace")
print(json.dumps({"code": os.waitstatus_to_exitcode(status),
                  "echoed": token1 in text or token2 in text,
                  "askedBoth": sent_first and sent_second}))

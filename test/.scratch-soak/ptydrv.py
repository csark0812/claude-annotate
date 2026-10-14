# Detached pty driver for an interactive claude. usage: pty.py <name> <cwd> <logdir> -- argv...
import os, sys, pty, select, time, signal, json
name, cwd, logdir = sys.argv[1], sys.argv[2], sys.argv[3]
argv = sys.argv[sys.argv.index("--")+1:]
os.setsid()
inp = os.path.join(logdir, name + ".in")
if os.path.exists(inp): os.remove(inp)
os.mkfifo(inp)
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    env = {k: v for k, v in os.environ.items() if not (k.startswith("CLAUDE_CODE") or k == "CLAUDECODE" or k.startswith("CLAUDE_AGENT") or k == "CLAUDE_PID" or k == "CLAUDE_EFFORT" or k == "CLAUDE_PREVIEW_CLASSIFIER_FLOOR")}
    env["TERM"] = "xterm-256color"; env["COLUMNS"] = "160"; env["LINES"] = "50"
    os.execvpe(argv[0], argv, env)
import fcntl, termios, struct
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 160, 0, 0))
open(os.path.join(logdir, name + ".pid"), "w").write(json.dumps({"driver": os.getpid(), "claude": pid}))
log = open(os.path.join(logdir, name + ".log"), "ab", buffering=0)
infd = os.open(inp, os.O_RDONLY | os.O_NONBLOCK)
keep = os.open(inp, os.O_WRONLY)  # keep fifo open
while True:
    try:
        r, _, _ = select.select([fd, infd], [], [], 1.0)
    except InterruptedError:
        continue
    if fd in r:
        try: data = os.read(fd, 65536)
        except OSError: break
        if not data: break
        log.write(data)
    if infd in r:
        data = os.read(infd, 65536)
        if data:
            # literal \r handled by sender; send slowly
            for ch in [data[i:i+64] for i in range(0, len(data), 64)]:
                os.write(fd, ch); time.sleep(0.02)
    p, st = os.waitpid(pid, os.WNOHANG)
    if p: break
log.write(b"\n[pty.py: child exited]\n")

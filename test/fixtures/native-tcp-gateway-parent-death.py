"""Deterministically expose the fork-to-PDEATHSIG race using the real relay path."""
import ctypes
import os
import select
import signal
import socket
import subprocess
import sys
import time


def wait_for(condition, description):
    deadline = time.monotonic() + 10
    while not condition():
        if time.monotonic() >= deadline:
            raise RuntimeError("timed out: " + description)
        time.sleep(0.005)


def readable_line(stream, description):
    if not select.select([stream], [], [], 10)[0]:
        raise RuntimeError("timed out: " + description)
    return stream.readline()


def run(probe, preload):
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise OSError(ctypes.get_errno(), "PR_SET_CHILD_SUBREAPER")
    notification_read, notification_write = os.pipe()
    broker = socket.socket()
    broker.bind(("127.0.0.1", 0))
    broker.listen(1)
    environment = dict(os.environ, LD_PRELOAD=preload,
                       PI_GATEWAY_FORK_NOTIFY_FD=str(notification_write))
    gateway = subprocess.Popen([probe, "serve", str(broker.getsockname()[1])],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               env=environment, pass_fds=(notification_write,))
    os.close(notification_write)
    relay = None
    client = None
    connection = None
    reaped = False
    status = None
    notifications = os.fdopen(notification_read, "rb", buffering=0)
    try:
        readiness = readable_line(gateway.stdout, "gateway readiness").decode("ascii").strip().split("\t")
        if readiness[:3] != ["PI_TCP_GATEWAY", "1", "READY"] or len(readiness) != 4:
            raise RuntimeError("invalid gateway readiness: " + repr(readiness))
        client = socket.create_connection(("127.0.0.1", int(readiness[3])))
        relay = int(readable_line(notifications, "relay fork notification"))

        def stopped():
            with open(f"/proc/{relay}/status", encoding="ascii") as process_status:
                return any(line.startswith("State:") and "T" in line for line in process_status)

        wait_for(stopped, "relay paused before production child branch")
        gateway.kill()
        gateway.wait(timeout=10)
        # The relay must have been adopted by this launcher, not PID 1. This is
        # the condition the old getppid()==1 check fails to detect.
        with open(f"/proc/{relay}/status", encoding="ascii") as process_status:
            parent = next(int(line.split()[1]) for line in process_status if line.startswith("PPid:"))
        if parent != os.getpid():
            raise RuntimeError(f"relay adopted by {parent}, expected subreaper {os.getpid()}")
        os.kill(relay, signal.SIGCONT)

        deadline = time.monotonic() + 10
        connected = False
        while time.monotonic() < deadline:
            if select.select([broker], [], [], 0.01)[0]:
                connection, _ = broker.accept()
                connected = True
                break
            pid, status = os.waitpid(relay, os.WNOHANG)
            if pid == relay:
                reaped = True
                # Check after observing exit, too: a broken child could connect
                # and then exit before the launcher sees the listening socket.
                connected = bool(select.select([broker], [], [], 0)[0])
                break
        else:
            raise RuntimeError("relay neither exited nor connected after resume")
        if connected:
            print("broker-connected")
        elif reaped and os.WIFEXITED(status) and os.WEXITSTATUS(status) == 1:
            print("relay-rejected")
        else:
            raise RuntimeError(f"unexpected relay exit: {status}")
        if select.select([gateway.stderr], [], [], 0)[0] and os.read(gateway.stderr.fileno(), 4096):
            raise RuntimeError("unexpected gateway diagnostics")
    finally:
        if gateway.poll() is None:
            gateway.kill()
            gateway.wait(timeout=10)
        if relay is not None and not reaped:
            try:
                os.kill(relay, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(relay, 0)
        if connection is not None:
            connection.close()
        if client is not None:
            client.close()
        broker.close()
        notifications.close()
        gateway.stdout.close()
        gateway.stderr.close()


if __name__ == "__main__":
    run(*sys.argv[1:])

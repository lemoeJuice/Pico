#!/usr/bin/env python3
"""Hold a D-Bus reference to one systemd unit until explicitly released."""

import os
import sys


def connect(bus):
    import dbus

    if bus == "--user":
        runtime_dir = os.environ.get("XDG_RUNTIME_DIR")
        if not runtime_dir:
            raise RuntimeError("user-bus-unavailable")
        connection = dbus.bus.BusConnection("unix:path=" + os.path.join(runtime_dir, "bus"))
    elif bus == "--system":
        connection = dbus.SystemBus()
    else:
        raise RuntimeError("invalid-bus")
    manager = dbus.Interface(
        connection.get_object("org.freedesktop.systemd1", "/org/freedesktop/systemd1"),
        "org.freedesktop.systemd1.Manager",
    )
    return connection, manager


def main():
    if len(sys.argv) != 3:
        print("ERROR arguments", flush=True)
        return 2

    bus, unit = sys.argv[1:]
    try:
        connection, manager = connect(bus)
        manager.RefUnit(unit)
    except Exception:
        print("ERROR ref-failed", flush=True)
        return 1

    print("READY", flush=True)
    try:
        for line in sys.stdin:
            command = line.rstrip("\r\n")
            if command == "PING":
                try:
                    manager.GetUnit(unit)
                except Exception:
                    print("ERROR ping-failed", flush=True)
                    return 1
                print("PONG", flush=True)
            elif command == "RELEASE":
                try:
                    manager.UnrefUnit(unit)
                except Exception:
                    print("ERROR unref-failed", flush=True)
                    return 1
                print("RELEASED", flush=True)
                return 0
            else:
                print("ERROR protocol", flush=True)
                return 1
    finally:
        connection.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Move only verified Podman container helper processes into systemd scopes."""

import os
import errno
import re
import sys
import time

ALLOWED_COMM = {"conmon", "passt", "passt.avx2", "pasta", "slirp4netns"}
PROC_ROOT = "/proc"
CGROUP_ROOT = "/sys/fs/cgroup"
MAX_SCANS = 80
CLEAN_SCANS_REQUIRED = 3
SCAN_INTERVAL_SECONDS = 0.05
SCOPE_WAIT_SECONDS = 3.0


def cgroup_paths(pid, proc_root=PROC_ROOT):
    with open(os.path.join(proc_root, str(pid), "cgroup"), "r", encoding="utf-8") as stream:
        paths = []
        for line in stream:
            value = line.rstrip("\n")
            if not value:
                continue
            parts = value.split(":", 2)
            if len(parts) != 3 or not parts[0] or not parts[2].startswith("/"):
                raise RuntimeError("proc-cgroup-unparseable")
            paths.append(parts[2])
        if not paths:
            raise RuntimeError("proc-cgroup-unparseable")
        return paths


def in_cgroup(paths, expected):
    expected = expected.rstrip("/") or "/"
    return any(path == expected or (expected != "/" and path.startswith(expected + "/")) for path in paths)


def process_identity(pid, proc_root=PROC_ROOT):
    directory = os.path.join(proc_root, str(pid))
    try:
        with open(os.path.join(directory, "stat"), "r", encoding="utf-8") as stream:
            stat = stream.read()
        closing = stat.rfind(")")
        if closing < 0:
            raise RuntimeError("proc-stat-unparseable")
        fields = stat[closing + 1 :].split()
        if len(fields) <= 19:
            raise RuntimeError("proc-stat-unparseable")
        if fields[0] == "Z":
            return None
        start_time = fields[19]
        with open(os.path.join(directory, "comm"), "r", encoding="utf-8") as stream:
            comm = stream.read().strip()
        paths = cgroup_paths(pid, proc_root)
        if not comm or not paths:
            raise RuntimeError("proc-identity-unparseable")
        return {"pid": int(pid), "starttime": start_time, "comm": comm, "cgroups": paths}
    except FileNotFoundError:
        if not os.path.exists(directory):
            return None
        raise RuntimeError("proc-identity-incomplete")
    except ProcessLookupError:
        return None
    except PermissionError as error:
        raise RuntimeError("proc-process-unreadable") from error
    except OSError as error:
        if error.errno in (errno.ENOENT, errno.ESRCH) and not os.path.exists(directory):
            return None
        raise RuntimeError("proc-process-unreadable") from error
    except ValueError as error:
        raise RuntimeError("proc-identity-unparseable") from error


def scan_candidates(control_group, proc_root=PROC_ROOT, cgroup_root=CGROUP_ROOT):
    candidates = []
    cgroup_root = os.path.realpath(cgroup_root)
    expected_cgroup = os.path.realpath(os.path.join(cgroup_root, control_group.lstrip("/")))
    if os.path.commonpath([cgroup_root, expected_cgroup]) != cgroup_root or not os.path.isdir(expected_cgroup):
        raise RuntimeError("runtime-cgroup-unavailable")
    pids = set()

    def walk_error(_error):
        raise RuntimeError("runtime-cgroup-unreadable")

    try:
        for directory, subdirectories, files in os.walk(expected_cgroup, topdown=True, onerror=walk_error):
            subdirectories[:] = [name for name in subdirectories if not os.path.islink(os.path.join(directory, name))]
            if "cgroup.procs" not in files:
                raise RuntimeError("runtime-cgroup-procs-missing")
            try:
                with open(os.path.join(directory, "cgroup.procs"), "r", encoding="ascii") as stream:
                    for line in stream:
                        value = line.strip()
                        if not value.isdigit():
                            raise RuntimeError("runtime-cgroup-procs-unparseable")
                        pids.add(int(value))
            except PermissionError as error:
                raise RuntimeError("runtime-cgroup-unreadable") from error
            except OSError as error:
                if error.errno in (errno.ENOENT, errno.ESRCH) and not os.path.exists(directory):
                    continue
                raise RuntimeError("runtime-cgroup-unreadable") from error
    except OSError as error:
        raise RuntimeError("runtime-cgroup-unreadable") from error

    for pid in sorted(pids):
        identity = process_identity(pid, proc_root)
        if identity and in_cgroup(identity["cgroups"], control_group) and identity["comm"] in ALLOWED_COMM:
            candidates.append(identity)
    return sorted(candidates, key=lambda item: item["pid"])


def verified_current(candidate, control_group, proc_root=PROC_ROOT):
    current = process_identity(candidate["pid"], proc_root)
    if not current or current["comm"] not in ALLOWED_COMM or not in_cgroup(current["cgroups"], control_group):
        return None
    if current["starttime"] != candidate["starttime"] or current["comm"] != candidate["comm"]:
        return None
    return current


def process_scope(manager, candidate, scope_name):
    import dbus

    properties = dbus.Array(
        [
            dbus.Struct(
                (dbus.String("Description"), dbus.String("Pico preserved Container process", variant_level=1)),
                signature="sv",
            ),
            dbus.Struct(
                (
                    dbus.String("PIDs"),
                    dbus.Array([dbus.UInt32(candidate["pid"])], signature="u", variant_level=1),
                ),
                signature="sv",
            ),
        ],
        signature="(sv)",
    )
    manager.StartTransientUnit(scope_name, "fail", properties, dbus.Array([], signature="(sa(sv))"))


def wait_for_scope_cgroup(read_scope_cgroup, scope_name, timeout=SCOPE_WAIT_SECONDS, sleep=time.sleep):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            path = read_scope_cgroup(scope_name)
        except Exception:
            path = ""
        if path:
            return path
        sleep(0.05)
    raise RuntimeError("scope-not-active")


def move_one(manager, read_scope_cgroup, candidate, control_group, scope_name, proc_root=PROC_ROOT, sleep=time.sleep):
    current = verified_current(candidate, control_group, proc_root)
    if not current:
        return "gone"
    try:
        process_scope(manager, current, scope_name)
    except Exception as error:
        # Podman helpers can disappear naturally between the last /proc check
        # and StartTransientUnit. Retry only when the exact process still lives
        # in the Runtime cgroup; never send a stale PID again.
        current = process_identity(candidate["pid"], proc_root)
        if not current:
            return "gone"
        if current["starttime"] != candidate["starttime"] or current["comm"] != candidate["comm"]:
            if not in_cgroup(current["cgroups"], control_group):
                raise RuntimeError("process-identity-changed") from error
            return "gone"
        if not in_cgroup(current["cgroups"], control_group):
            try:
                scope_cgroup = read_scope_cgroup(scope_name)
            except Exception:
                scope_cgroup = ""
            if scope_cgroup and in_cgroup(current["cgroups"], scope_cgroup):
                return "moved"
            raise RuntimeError("process-moved-unexpectedly") from error
        if current["comm"] not in ALLOWED_COMM:
            return "gone"
        raise RuntimeError("scope-start-failed") from error

    current = process_identity(candidate["pid"], proc_root)
    if not current:
        return "moved"
    if current["starttime"] != candidate["starttime"] or current["comm"] != candidate["comm"]:
        raise RuntimeError("process-identity-changed")
    try:
        scope_cgroup = wait_for_scope_cgroup(read_scope_cgroup, scope_name, sleep=sleep)
    except RuntimeError:
        if not process_identity(candidate["pid"], proc_root):
            return "moved"
        raise
    current = process_identity(candidate["pid"], proc_root)
    if not current:
        return "moved"
    if current["starttime"] != candidate["starttime"] or current["comm"] != candidate["comm"]:
        raise RuntimeError("process-identity-changed")
    if current["comm"] not in ALLOWED_COMM or not in_cgroup(current["cgroups"], scope_cgroup):
        raise RuntimeError("scope-verification-failed")
    if in_cgroup(current["cgroups"], control_group):
        raise RuntimeError("process-remained-in-runtime-cgroup")
    return "moved"


def preserve_container_processes(
    manager,
    read_scope_cgroup,
    control_group,
    scope_prefix,
    proc_root=PROC_ROOT,
    max_scans=MAX_SCANS,
    sleep=time.sleep,
    cgroup_root=CGROUP_ROOT,
):
    if (
        not control_group.startswith("/")
        or ".." in control_group.split("/")
        or not re.fullmatch(r"pico-container-preserve-[a-f0-9-]+", scope_prefix)
    ):
        raise RuntimeError("invalid-scope-arguments")
    moved = 0
    clean_scans = 0
    scope_sequence = 0
    for _ in range(max_scans):
        candidates = scan_candidates(control_group, proc_root, cgroup_root)
        if not candidates:
            clean_scans += 1
            if clean_scans >= CLEAN_SCANS_REQUIRED:
                return moved
            sleep(SCAN_INTERVAL_SECONDS)
            continue

        clean_scans = 0
        for candidate in candidates:
            scope_sequence += 1
            scope_name = f"{scope_prefix}-{scope_sequence:04d}.scope"
            result = move_one(
                manager,
                read_scope_cgroup,
                candidate,
                control_group,
                scope_name,
                proc_root,
                sleep,
            )
            if result == "moved":
                moved += 1
        sleep(SCAN_INTERVAL_SECONDS)
    raise RuntimeError("runtime-cgroup-did-not-stabilize")


def connect_user_bus():
    import dbus

    runtime_dir = os.environ.get("XDG_RUNTIME_DIR")
    if not runtime_dir:
        raise RuntimeError("user-bus-unavailable")
    connection = dbus.bus.BusConnection("unix:path=" + os.path.join(runtime_dir, "bus"))
    manager = dbus.Interface(
        connection.get_object("org.freedesktop.systemd1", "/org/freedesktop/systemd1"),
        "org.freedesktop.systemd1.Manager",
    )

    def read_scope_cgroup(scope_name):
        object_path = manager.GetUnit(scope_name)
        properties = dbus.Interface(
            connection.get_object("org.freedesktop.systemd1", object_path),
            "org.freedesktop.DBus.Properties",
        )
        # ControlGroup is exposed on the concrete Scope interface by systemd;
        # unlike common state such as ActiveState, it is not a Unit property.
        return str(properties.Get("org.freedesktop.systemd1.Scope", "ControlGroup"))

    return connection, manager, read_scope_cgroup


def connect_system_bus():
    import dbus

    connection = dbus.SystemBus()
    manager = dbus.Interface(
        connection.get_object("org.freedesktop.systemd1", "/org/freedesktop/systemd1"),
        "org.freedesktop.systemd1.Manager",
    )

    def read_scope_cgroup(scope_name):
        object_path = manager.GetUnit(scope_name)
        properties = dbus.Interface(
            connection.get_object("org.freedesktop.systemd1", object_path),
            "org.freedesktop.DBus.Properties",
        )
        return str(properties.Get("org.freedesktop.systemd1.Scope", "ControlGroup"))

    return connection, manager, read_scope_cgroup


def main():
    if len(sys.argv) != 5 or sys.argv[1] not in ("--user", "--system"):
        print("ERROR invalid-arguments", flush=True)
        return 2
    _, bus_mode, unit, control_group, scope_prefix = sys.argv
    connection = None
    try:
        if bus_mode == "--user":
            connection, manager, read_scope_cgroup = connect_user_bus()
        else:
            connection, manager, read_scope_cgroup = connect_system_bus()
        if not unit.endswith(".service") or not re.fullmatch(r"pico-container-preserve-[a-f0-9-]+", scope_prefix):
            raise RuntimeError("invalid-scope-identity")
        moved = preserve_container_processes(manager, read_scope_cgroup, control_group, scope_prefix)
        print(f"OK {moved}", flush=True)
        return 0
    except Exception:
        # Do not print D-Bus errors, process data, environments, or credentials.
        print("ERROR container-process-isolation-failed", flush=True)
        return 1
    finally:
        if connection:
            try:
                connection.close()
            except Exception:
                pass


if __name__ == "__main__":
    sys.exit(main())

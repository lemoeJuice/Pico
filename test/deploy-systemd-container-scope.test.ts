import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

const helperPath = fileURLToPath(new URL('../scripts/deploy/systemd-container-scope.py', import.meta.url));
const deployScriptPath = fileURLToPath(new URL('../scripts/deploy-production.mjs', import.meta.url));

const fixture = String.raw`
import atexit, contextlib, importlib.util, io, os, shutil, sys, tempfile, types
spec = importlib.util.spec_from_file_location('container_scope_helper', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
class FakeBus:
    def __init__(self):
        self.closed = False
    def get_object(self, _service, _path):
        return self
    def GetUnit(self, _name):
        return '/org/freedesktop/systemd1/unit/probe'
    def Get(self, interface, prop):
        assert interface == 'org.freedesktop.systemd1.Scope', interface
        assert prop == 'ControlGroup', prop
        return '/system.slice/pico-container-preserve-probe.scope'
    def close(self):
        self.closed = True
system_connections = []
def fake_system_bus():
    connection = FakeBus()
    system_connections.append(connection)
    return connection
sys.modules['dbus'] = types.SimpleNamespace(
    String=lambda value, variant_level=0: str(value), UInt32=int,
    Array=lambda values, signature=None, variant_level=0: list(values),
    Struct=lambda values, signature=None: tuple(values),
    Interface=lambda obj, _interface: obj,
    SystemBus=fake_system_bus,
)
base = tempfile.mkdtemp(prefix='pico-scope-test-')
atexit.register(lambda: shutil.rmtree(base, ignore_errors=True))
cgroup_root = os.path.join(base, 'cgroup')
proc_root = os.path.join(base, 'proc')
control_group = '/user.slice/user-1000.slice/app.slice/pico-runtime.service'
source_root = os.path.join(cgroup_root, control_group.lstrip('/'))
worker_root = os.path.join(source_root, 'worker')
os.makedirs(worker_root)
os.makedirs(proc_root)
open(os.path.join(source_root, 'cgroup.procs'), 'w', encoding='ascii').close()
open(os.path.join(worker_root, 'cgroup.procs'), 'w', encoding='ascii').close()
def add_process(pid, comm, cgroup, starttime):
    directory = os.path.join(proc_root, str(pid))
    os.makedirs(directory)
    tail = ['S'] + ['0'] * 18 + [str(starttime)]
    with open(os.path.join(directory, 'stat'), 'w', encoding='utf-8') as stream:
        stream.write(f'{pid} ({comm}) ' + ' '.join(tail))
    with open(os.path.join(directory, 'comm'), 'w', encoding='utf-8') as stream:
        stream.write(comm + '\n')
    with open(os.path.join(directory, 'cgroup'), 'w', encoding='utf-8') as stream:
        stream.write('0::' + cgroup + '\n')
    owner = worker_root if cgroup.endswith('/worker') else source_root
    with open(os.path.join(owner, 'cgroup.procs'), 'a', encoding='ascii') as stream:
        stream.write(str(pid) + '\n')
def remove_pid(pid):
    for directory in (source_root, worker_root):
        filename = os.path.join(directory, 'cgroup.procs')
        with open(filename, 'r', encoding='ascii') as stream:
            rows = [row.strip() for row in stream if row.strip() != str(pid)]
        with open(filename, 'w', encoding='ascii') as stream:
            stream.write(''.join(row + '\n' for row in rows))
class FakeManager:
    def __init__(self, disappear=False, fail_to_move=False):
        self.calls, self.scopes = [], {}
        self.disappear, self.fail_to_move = disappear, fail_to_move
    def StartTransientUnit(self, name, mode, properties, auxiliary):
        pids = next(value for key, value in properties if key == 'PIDs')
        self.calls.append((name, mode, list(pids)))
        target = '/user.slice/user-1000.slice/app.slice/' + name
        self.scopes[name] = target
        for pid in pids:
            if self.disappear:
                shutil.rmtree(os.path.join(proc_root, str(pid)))
                remove_pid(pid)
            elif not self.fail_to_move:
                remove_pid(pid)
                with open(os.path.join(proc_root, str(pid), 'cgroup'), 'w', encoding='utf-8') as stream:
                    stream.write('0::' + target + '\n')
manager = FakeManager()
def read_scope(name):
    return manager.scopes.get(name, '')
`;

function runPython(scenario: string) {
  const result = spawnSync('python3', ['-c', `${fixture}\n${scenario}`, helperPath], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.error) throw result.error;
  return result;
}

describe('systemd Container process scope helper', () => {
  it('moves only allowlisted PIDs from the Runtime cgroup and rescans until clear', () => {
    const result = runPython(String.raw`
add_process(100, 'conmon', control_group, 1000)
add_process(101, 'passt', control_group + '/worker', 1001)
add_process(102, 'bash', control_group, 1002)
add_process(200, 'conmon', '/user.slice/user-1000.slice/app.slice/other.service', 2000)
moved = module.preserve_container_processes(
    manager, read_scope, control_group, 'pico-container-preserve-123e4567e89b42d3a456426614174000',
    proc_root=proc_root, cgroup_root=cgroup_root, sleep=lambda _seconds: None,
)
assert moved == 2, moved
assert [call[2] for call in manager.calls] == [[100], [101]], manager.calls
assert all(call[1] == 'fail' for call in manager.calls)
assert all(call[0].startswith('pico-container-preserve-123e4567e89b42d3a456426614174000-') for call in manager.calls)
assert module.process_identity(100, proc_root)['cgroups'] == [manager.scopes[manager.calls[0][0]]]
assert module.process_identity(101, proc_root)['cgroups'] == [manager.scopes[manager.calls[1][0]]]
assert module.process_identity(102, proc_root)['cgroups'] == [control_group]
assert module.process_identity(200, proc_root)['cgroups'] == ['/user.slice/user-1000.slice/app.slice/other.service']
`);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('connects to the system D-Bus manager without user-bus environment and reads Scope.ControlGroup', () => {
    const result = runPython(String.raw`
os.environ.pop('XDG_RUNTIME_DIR', None)
connection, manager, read_scope = module.connect_system_bus()
assert connection is system_connections[-1]
assert read_scope('pico-container-preserve-probe.scope') == '/system.slice/pico-container-preserve-probe.scope'
connection.close()
assert connection.closed
`);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('fails closed on system-bus authorization errors without exposing their details', () => {
    const result = runPython(String.raw`
module.connect_system_bus = lambda: (FakeBus(), FakeManager(), read_scope)
def denied_preserve(*_args, **_kwargs):
    raise PermissionError('authorization denied: do not expose this detail')
module.preserve_container_processes = denied_preserve
sys.argv = [sys.argv[0], '--system', 'pico-runtime.service', control_group,
            'pico-container-preserve-123e4567e89b42d3a456426614174000']
output = io.StringIO()
with contextlib.redirect_stdout(output):
    exit_code = module.main()
assert exit_code == 1, exit_code
assert output.getvalue() == 'ERROR container-process-isolation-failed\n', output.getvalue()
assert 'authorization denied' not in output.getvalue()
`);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('bounds the deployment helper and selects the already verified manager mode', () => {
    const source = readFileSync(deployScriptPath, 'utf8');
    expect(source).toContain("const busMode = systemdContext.args?.includes('--user') ? '--user' : '--system';");
    expect(source).toContain('timeout: 30_000');
    expect(source).toContain("if (result.error || result.status !== 0 || !summary)");
  });

  it('fails closed when an existing Runtime-cgroup PID has unreadable /proc identity', () => {
    const result = runPython(String.raw`
add_process(100, 'conmon', control_group, 1000)
import builtins
real_open = builtins.open
def denied_open(filename, *args, **kwargs):
    if str(filename) == os.path.join(proc_root, '100', 'comm'):
        raise PermissionError('denied')
    return real_open(filename, *args, **kwargs)
module.open = denied_open
try:
    module.preserve_container_processes(
        manager, read_scope, control_group, 'pico-container-preserve-123e4567e89b42d3a456426614174000',
        proc_root=proc_root, cgroup_root=cgroup_root, sleep=lambda _seconds: None,
    )
    raise AssertionError('expected fail-closed process inspection')
except RuntimeError as error:
    assert str(error) == 'proc-process-unreadable', str(error)
assert manager.calls == [], manager.calls
`);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('fails closed when a Runtime cgroup subtree cannot be enumerated', () => {
    const result = runPython(String.raw`
add_process(100, 'conmon', control_group, 1000)
import builtins
real_open = builtins.open
def denied_open(filename, *args, **kwargs):
    if str(filename) == os.path.join(worker_root, 'cgroup.procs'):
        raise PermissionError('denied')
    return real_open(filename, *args, **kwargs)
module.open = denied_open
try:
    module.preserve_container_processes(
        manager, read_scope, control_group, 'pico-container-preserve-123e4567e89b42d3a456426614174000',
        proc_root=proc_root, cgroup_root=cgroup_root, sleep=lambda _seconds: None,
    )
    raise AssertionError('expected fail-closed cgroup enumeration')
except RuntimeError as error:
    assert str(error) == 'runtime-cgroup-unreadable', str(error)
assert manager.calls == [], manager.calls
`);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('accepts a process that naturally exits during scope creation', () => {
    const result = runPython(String.raw`
add_process(100, 'conmon', control_group, 1000)
manager = FakeManager(disappear=True)
moved = module.preserve_container_processes(
    manager, read_scope, control_group, 'pico-container-preserve-123e4567e89b42d3a456426614174000',
    proc_root=proc_root, cgroup_root=cgroup_root, sleep=lambda _seconds: None,
)
assert moved == 1, moved
assert len(manager.calls) == 1, manager.calls
`);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('fails closed if systemd accepts a scope but the PID is not verified inside it', () => {
    const result = runPython(String.raw`
add_process(100, 'conmon', control_group, 1000)
manager = FakeManager(fail_to_move=True)
try:
    module.preserve_container_processes(
        manager, read_scope, control_group, 'pico-container-preserve-123e4567e89b42d3a456426614174000',
        proc_root=proc_root, cgroup_root=cgroup_root, sleep=lambda _seconds: None,
    )
    raise AssertionError('expected scope verification failure')
except RuntimeError as error:
    assert str(error) == 'scope-verification-failed', str(error)
assert len(manager.calls) == 1
`);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });
});

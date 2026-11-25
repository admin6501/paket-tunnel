#!/usr/bin/env python3
"""Install the standalone storefront into the active Asan Gozar HTTPS site."""
import getpass
import grp
import hashlib
import json
import os
from pathlib import Path
import platform
import pwd
import re
import secrets
import sqlite3
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time

DOMAIN = 'asan-gozar.ir'
WWW = 'www.' + DOMAIN
USER = 'asan-gozar-store'
APP = Path('/opt/asan-gozar-store')
RUNTIME = Path('/opt/asan-gozar-node24')
DATA = Path('/var/lib/asan-gozar-store')
CONFIG = Path('/etc/asan-gozar-store/config.json')
SNIPPET = Path('/etc/nginx/snippets/asan-gozar-shop.conf')
SERVICE = Path('/etc/systemd/system/asan-gozar-store.service')
INCLUDE = f'include {SNIPPET};'
REDIRECT = f'if ($host = {WWW}) {{ return 308 https://{DOMAIN}$request_uri; }}'
TOKEN = re.compile(r'''#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\$\{[^}]+\}|[^\s{};#"']+|[{};]''')


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def active_files(dump):
    return [Path(name) for name in re.findall(r'^# configuration file (.+):$', dump, re.M)]


def blocks(text):
    """Read server blocks and their immediate directives, skipping comments."""
    stack = []
    words = []
    start = None
    tokens = (t for t in TOKEN.finditer(text) if not t.group().startswith('#'))
    for token in tokens:
        v = token.group()
        if v == '{':
            frame = {'key': words[0] if words else '', 'insert': token.end(),
                     'start': start, 'directives': [], 'locations': []}
            if stack and stack[-1]['key'] == 'server' and words and words[0] == 'location':
                stack[-1]['locations'].append(words[1:])
            stack.append(frame)
            words, start = [], None
        elif v == ';':
            if stack and stack[-1]['key'] == 'server' and words:
                stack[-1]['directives'].append(words)
            words, start = [], None
        elif v == '}':
            if not stack:
                return
            frame = stack.pop()
            if frame['key'] == 'server':
                yield frame
            words, start = [], None
        else:
            if start is None:
                start = token.start()
            words.append(v.strip('"\''))


def vhost_plan(files):
    matches = {DOMAIN: [], WWW: []}
    locations = {}
    for path in sorted({p.resolve() for p in files}):
        text = path.read_text(encoding='utf-8')
        for b in blocks(text):
            directives = b['directives']
            names = {n for d in directives if d[0] == 'server_name' for n in d[1:]}
            if not names.intersection(matches):
                continue
            tls = any(d[0] == 'listen' and len(d) > 1 and
                      (d[1] == '443' or d[1].endswith(':443')) for d in directives)
            if not tls:
                continue
            if not names.issubset(matches):
                raise ValueError(f'Shared HTTPS server block found in {path}.')
            key = (path, b['insert'])
            locations[key] = (text, b)
            for name in names:
                matches[name].append(key)
    if len(matches[DOMAIN]) != 1 or len(matches[WWW]) > 1:
        raise ValueError('Expected one active apex HTTPS block and at most one www HTTPS block.')
    apex = matches[DOMAIN][0]
    text, b = locations[apex]
    add_alias = not matches[WWW]
    if add_alias:
        certificates = [Path(d[1]) for d in b['directives'] if d[0] == 'ssl_certificate' and len(d) == 2]
        if not any(certificate.is_absolute() and certificate.is_file() and 'does match certificate' in
                   subprocess.run(['openssl', 'x509', '-in', str(certificate), '-noout', '-checkhost', WWW],
                                  capture_output=True, text=True).stdout for certificate in certificates):
            raise ValueError('No www HTTPS block was found and the apex certificate could not be verified for www.')
    www = apex if add_alias else matches[WWW][0]
    roots = [d[1] for d in b['directives'] if d[0] == 'root' and len(d) == 2]
    if len(roots) != 1 or not roots[0].startswith('/') or '$' in roots[0]:
        raise ValueError('Apex HTTPS server block needs a single absolute root directive.')
    root = Path(roots[0]).resolve()
    if not (root / 'index.html').is_file() or root in [Path('/'), Path('/var'), Path('/var/www'), Path('/var/lib')]:
        raise ValueError(f'Existing site index not found in expected root: {root}')
    if any(part.startswith('/shop') for loc in b['locations'] for part in loc):
        raise ValueError('An existing inline /shop location would conflict with the installer.')
    edits = {}
    additions = [(apex, INCLUDE), (www, REDIRECT)]
    if add_alias:
        additions.append((apex, f'server_name {WWW};'))
    for key, directive in additions:
        path, offset = key
        text, b = locations[key]
        previous = text[offset:]
        # Check immediate directives for includes, and a previously added leading redirect.
        already = (['include', str(SNIPPET)] in b['directives'] if directive == INCLUDE
                   else previous.lstrip().startswith(REDIRECT))
        if not already:
            edits.setdefault(path, []).append((offset, '\n    ' + directive + '\n'))
    changes = {}
    for path, items in edits.items():
        original = path.read_text(encoding='utf-8')
        updated = original
        for offset, content in sorted(items, reverse=True):
            updated = updated[:offset] + content + updated[offset:]
        changes[path] = (original, updated)
    return root, changes


def atomic_text(path, text):
    previous = path.stat()
    with tempfile.NamedTemporaryFile('w', encoding='utf-8', dir=path.parent, delete=False) as stream:
        temp = Path(stream.name)
        try:
            stream.write(text)
            stream.flush()
            os.fchown(stream.fileno(), previous.st_uid, previous.st_gid)
            os.fchmod(stream.fileno(), stat.S_IMODE(previous.st_mode))
            os.replace(temp, path)
        finally:
            temp.unlink(missing_ok=True)


def node_tools(work):
    for binary in (RUNTIME / 'bin/node', Path('/usr/bin/node'), Path('/usr/local/bin/node')):
        npm = binary.with_name('npm')
        if binary.is_file() and npm.is_file():
            version = run(str(binary), '-p', 'process.versions.node', capture_output=True, text=True).stdout.strip()
            if version.startswith('24.'):
                return binary, npm
    arch = {'x86_64': 'x64', 'aarch64': 'arm64'}.get(platform.machine())
    if not arch:
        raise ValueError('This installer supports x86_64 and aarch64. Install Node.js 24 manually for other architectures.')
    base = 'https://nodejs.org/dist/latest-v24.x'
    manifest = run('curl', '-fsSL', '--retry', '2', base + '/SHASUMS256.txt', capture_output=True, text=True).stdout
    entries = re.findall(rf'^([a-f0-9]{{64}})  (node-v24\.[0-9]+\.[0-9]+-linux-{arch}\.tar\.xz)$', manifest, re.M)
    if len(entries) != 1:
        raise ValueError('Could not identify the official Node.js 24 archive.')
    checksum, name = entries[0]
    archive = work / name
    run('curl', '-fsSL', '--retry', '2', '-o', str(archive), base + '/' + name)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != checksum:
        raise ValueError('Node.js checksum verification failed.')
    RUNTIME.mkdir(mode=0o755, parents=True, exist_ok=True)
    run('tar', '-xJf', str(archive), '-C', str(RUNTIME), '--strip-components=1')
    return RUNTIME / 'bin/node', RUNTIME / 'bin/npm'


def service_ready():
    for _ in range(30):
        result = subprocess.run(['curl', '-fsS', '--noproxy', '*', '--max-time', '1',
                                 'http://127.0.0.1:8787/shop/api/state'], capture_output=True, text=True)
        if result.returncode == 0 and json.loads(result.stdout).get('signedIn') is False:
            return
        time.sleep(.5)
    raise RuntimeError('Store API did not start. Check journalctl -u asan-gozar-store -n 50.')


def main(archive):
    if os.geteuid() != 0:
        raise ValueError('Run the installer with sudo.')
    for cmd in ('nginx', 'systemctl', 'curl', 'tar', 'install', 'runuser', 'openssl'):
        if not shutil.which(cmd):
            raise ValueError(f'Missing command: {cmd}')
    dump = run('nginx', '-T', capture_output=True, text=True)
    root, changes = vhost_plan(active_files(dump.stdout))
    print(f'Using existing site root {root}', flush=True)
    if CONFIG.exists():
        conf = json.loads(CONFIG.read_text())
        if conf.get('origin') != f'https://{DOMAIN}' or conf.get('port') != 8787 or not re.fullmatch(r'[a-fA-F0-9]{64}', conf.get('secret', '')):
            raise ValueError(f'Existing store configuration differs from expected origin or port: {CONFIG}')

    with tempfile.TemporaryDirectory(prefix='asan-gozar-install-') as tmp:
        work = Path(tmp)
        with tarfile.open(archive) as bundle:
            bundle.extractall(work, filter='data')
        source = work / 'asan-gozar-store'
        public = work / 'asan_gozar_website'
        if APP.is_symlink() or RUNTIME.is_symlink() or SNIPPET.is_symlink():
            raise ValueError('Unexpected symbolic link in the installation paths.')
        for asset in public.rglob('*'):
            destination = root / asset.relative_to(public)
            if destination.is_symlink():
                raise ValueError(f'Refusing linked site destination: {destination}')
        database = DATA / 'store.sqlite'
        prompt = not database.exists()
        if not prompt:
            db = sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)
            try:
                prompt = not db.execute('SELECT 1 FROM store_accounts WHERE owner=1 LIMIT 1').fetchone()
            finally:
                db.close()
        if prompt:
            password = getpass.getpass('Choose store owner password (at least 14 characters): ')
            if password != getpass.getpass('Repeat store owner password: ') or len(password) < 14 or len(password.encode()) > 256:
                raise ValueError('Passwords did not match or expected length was not met.')
        node, npm = node_tools(work)
        run(str(node), str(npm), 'ci', '--omit=dev', '--ignore-scripts', cwd=source)
        try:
            account = pwd.getpwnam(USER)
        except KeyError:
            run('useradd', '--system', '--user-group', '--home-dir', str(DATA), '--shell', '/usr/sbin/nologin', USER)
            account = pwd.getpwnam(USER)
        group = grp.getgrgid(account.pw_gid).gr_name
        run('install', '-d', '-m', '0700', '-o', USER, '-g', group, str(DATA))
        run('install', '-d', '-m', '0750', '-o', 'root', '-g', group, str(CONFIG.parent))
        if not CONFIG.exists():
            settings = work / 'config.json'
            settings.write_text(json.dumps({'origin': f'https://{DOMAIN}', 'port': 8787, 'secret': secrets.token_hex(32)}))
            run('install', '-m', '0640', '-o', 'root', '-g', group, str(settings), str(CONFIG))
        # Files are read-only to the service user. Existing database remains separate.
        shutil.copytree(source, APP, dirs_exist_ok=True)
        APP.chmod(0o755)
        for item in APP.rglob('*'):
            if not item.is_symlink():
                item.chmod(0o755 if item.is_dir() else 0o644)
        if prompt:
            run('runuser', '-u', USER, '--', str(node), str(APP / 'account.mjs'), 'owner', 'owner', 'مدیر فروشگاه',
                input=password + '\n', text=True)
        unit = (source / 'asan-gozar-store.service').read_text()
        unit = unit.replace('ExecStart=/usr/bin/node ', f'ExecStart={node} ').replace(f'Group={USER}', f'Group={group}')
        SERVICE.write_text(unit)
        SERVICE.chmod(0o644)
        run('systemctl', 'daemon-reload')
        run('systemctl', 'enable', 'asan-gozar-store')
        run('systemctl', 'restart', 'asan-gozar-store')
        service_ready()

        SNIPPET.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
        old_snippet = SNIPPET.read_bytes() if SNIPPET.exists() else None
        applied = []
        try:
            run('install', '-m', '0644', str(work / 'asan-gozar-shop.nginx.conf'), str(SNIPPET))
            for path, (_, updated) in changes.items():
                atomic_text(path, updated)
                applied.append(path)
            run('nginx', '-t')
            for asset in public.rglob('*'):
                dest = root / asset.relative_to(public)
                if asset.is_dir():
                    dest.mkdir(mode=0o755, parents=True, exist_ok=True)
                elif asset.name != 'README.txt':
                    if dest.is_symlink() or any(parent.is_symlink() for parent in dest.parents if parent != root and root in parent.parents):
                        raise ValueError(f'Refusing linked site destination: {dest}')
                    run('install', '-m', '0644', str(asset), str(dest))
            run('systemctl', 'reload', 'nginx')
        except Exception:
            for path in reversed(applied):
                atomic_text(path, changes[path][0])
            if old_snippet is None:
                SNIPPET.unlink(missing_ok=True)
            else:
                SNIPPET.write_bytes(old_snippet)
            raise
    print(f'Installed. Store: https://{DOMAIN}/shop/' + ('  |  Admin username: owner' if prompt else ''))
    print(f'Check: curl -fsS https://{DOMAIN}/shop/api/state')


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('Pass the path to asan-gozar-standalone.tar.gz.')
        main(Path(sys.argv[1]).resolve(strict=True))
    except (ValueError, OSError, EOFError, RuntimeError, sqlite3.Error, subprocess.CalledProcessError, tarfile.TarError) as error:
        print(f'Installation stopped: {error}', file=sys.stderr)
        sys.exit(1)

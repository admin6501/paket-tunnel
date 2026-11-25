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
import socket
import stat
import subprocess
import sys
import tarfile
import tempfile
import time

DOMAIN = os.environ.get('ASAN_GOZAR_DOMAIN', 'asan-gozar.ir').lower().strip().rstrip('.')
WWW = 'www.' + DOMAIN
USER = 'asan-gozar-store'
APP = Path('/opt/asan-gozar-store')
RUNTIME = Path('/opt/asan-gozar-node24')
DATA = Path('/var/lib/asan-gozar-store')
CONFIG = Path('/etc/asan-gozar-store/config.json')
WEB_ROOT = Path('/var/www')
MANAGED_VHOST = Path('/etc/nginx/sites-enabled/asan-gozar-store.conf')
LETSENCRYPT = Path('/etc/letsencrypt/live')
SNIPPET = Path('/etc/nginx/snippets/asan-gozar-shop.conf')
SERVICE = Path('/etc/systemd/system/asan-gozar-store.service')
INCLUDE = f'include {SNIPPET};'
REDIRECT = f'if ($host = {WWW}) {{ return 308 https://{DOMAIN}$request_uri; }}'
TOKEN = re.compile(r'''#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\$\{[^}]+\}|[^\s{};#"']+|[{};]''')
USERNAME = re.compile(r'[a-z][a-z0-9_]{2,31}')
PAGE_NAMES = ('index.html', 'account.html', 'prices.html', 'services.html', 'network.html',
              'status.html', 'faq.html', 'contact.html', 'favicon.svg', 'app.webmanifest')
APP_ASSETS = ('app-install.js', 'app-worker.js', 'app-icon-180.png', 'app-icon-192.png', 'app-icon-512.png')
PUBLIC_ASSETS = (*APP_ASSETS, 'store.js', 'store.css', 'prices.js', 'script.js', 'style.css', 'storefront.js',
                 'tickets.js', 'server-room.webp', 'robots.txt', 'sitemap.xml')
DOMAIN_PATTERN = re.compile(r'(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])')


def owner_username():
    with open('/dev/tty', 'r', encoding='utf-8') as terminal:
        while True:
            print('Choose store owner username (3–32 characters, letters, digits or underscores, starts with a letter): ', end='', flush=True)
            value = terminal.readline()
            if not value:
                raise ValueError('No username was entered.')
            username = value.strip().lower()
            if USERNAME.fullmatch(username):
                return username
            print('Invalid username. Use Latin letters, digits or underscores.')


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
                frame['end'] = token.end()
                yield frame
            words, start = [], None
        else:
            if start is None:
                start = token.start()
            words.append(v.strip('"\''))


def server_blocks(files):
    for path in sorted({p.resolve() for p in files}):
        text = path.read_text(encoding='utf-8')
        for block in blocks(text):
            directives = block['directives']
            names = {n for d in directives if d[0] == 'server_name' for n in d[1:]}
            tls = any(d[0] == 'listen' and len(d) > 1 and
                      (d[1] == '443' or d[1].endswith(':443')) for d in directives)
            yield path, text, block, names, tls


def dedicated_root(path, files, *, check_mount=True):
    if path.is_symlink() or not path.is_absolute() or path != path.resolve() or WEB_ROOT not in path.parents:
        raise ValueError(f'Expected a dedicated directory below {WEB_ROOT}: {path}')
    for _, _, block, names, _ in server_blocks(files):
        if names and names.issubset({DOMAIN, WWW}):
            continue
        for directive in block['directives']:
            if directive[0] == 'root' and len(directive) == 2:
                other = Path(directive[1]).resolve()
                if other == path or other in path.parents or path in other.parents:
                    raise ValueError(f'The site directory overlaps another Nginx site: {other}')
    if check_mount:
        refuse_mounted_tree(path)
    return path


def refuse_mounted_tree(path):
    for entry in Path('/proc/self/mountinfo').read_text().splitlines():
        mount = Path(re.sub(r'\\([0-7]{3})', lambda match: chr(int(match[1], 8)), entry.split()[4]))
        if mount == path or path in mount.parents:
            raise ValueError(f'Refusing to remove files on a mounted path: {mount}')


def remove_path(path):
    if path.is_symlink() or not path.is_dir():
        path.unlink(missing_ok=True)
    else:
        shutil.rmtree(path)


def clean_old_site(root):
    keep = set(PAGE_NAMES + PUBLIC_ASSETS) | {'.well-known'}
    removed = 0
    for path in root.iterdir():
        if path.name not in keep:
            remove_path(path)
            removed += 1
    print(f'Removed {removed} old website files or directories.', flush=True)


def vhost_plan(files):
    matches = {DOMAIN: [], WWW: []}
    locations = {}
    for path, text, b, names, tls in server_blocks(files):
        if not tls or not names.intersection(matches):
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
        add_alias = any(certificate.is_absolute() and certificate.is_file() and 'does match certificate' in
                        subprocess.run(['openssl', 'x509', '-in', str(certificate), '-noout', '-checkhost', WWW],
                                       capture_output=True, text=True).stdout for certificate in certificates)
    www = apex if add_alias else (matches[WWW][0] if matches[WWW] else None)
    roots = [d[1] for d in b['directives'] if d[0] == 'root' and len(d) == 2]
    if len(roots) != 1 or not roots[0].startswith('/') or '$' in roots[0]:
        raise ValueError('Apex HTTPS server block needs a single absolute root directive.')
    root = dedicated_root(Path(roots[0]), files)
    if any(part.startswith('/shop') or part in tuple('/' + name for name in PAGE_NAMES)
           for loc in b['locations'] for part in loc):
        raise ValueError('An existing inline location conflicts with the store routes.')
    edits = {}
    additions = [(apex, INCLUDE)]
    if www:
        additions.append((www, REDIRECT))
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


def nginx_files():
    return active_files(run('nginx', '-T', capture_output=True, text=True).stdout)


def without_domain_blocks(files, *, http_only=False):
    edits = {}
    domains = {DOMAIN, WWW}
    for path, text, block, names, tls in server_blocks(files):
        if not names.intersection(domains) or (http_only and tls):
            continue
        if not names.issubset(domains):
            raise ValueError(f'The domain shares a server block with another site in {path}.')
        edits.setdefault(path, (text, []))[1].append((block['start'], block['end']))
    changes = {}
    for path, (original, ranges) in edits.items():
        updated = original
        for start, end in sorted(ranges, reverse=True):
            updated = updated[:start] + updated[end:]
        changes[path] = (original, updated)
    return changes


def provision_https(files):
    root = dedicated_root(WEB_ROOT / 'asan_gozar_website', files)
    certificate, key = (LETSENCRYPT / DOMAIN / name for name in ('fullchain.pem', 'privkey.pem'))
    existing_cert = (certificate.is_file() and key.is_file() and
                     subprocess.run(['openssl', 'x509', '-in', str(certificate), '-checkend', '86400', '-noout'],
                                    capture_output=True).returncode == 0 and
                     'does match certificate' in subprocess.run(['openssl', 'x509', '-in', str(certificate), '-noout', '-checkhost', DOMAIN],
                                                               capture_output=True, text=True).stdout)
    if not existing_cert:
        try:
            socket.getaddrinfo(DOMAIN, 80, type=socket.SOCK_STREAM)
        except socket.gaierror as exc:
            raise ValueError(f'{DOMAIN} does not resolve. Point its DNS at this server first.') from exc
        email = os.environ.get('ASAN_GOZAR_EMAIL')
        if not email:
            with open('/dev/tty', 'r', encoding='utf-8') as terminal:
                print('Let’s Encrypt email: ', end='', flush=True)
                email = terminal.readline().strip()
        if not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', email):
            raise ValueError('Enter a valid email address for Let’s Encrypt.')
        if not shutil.which('certbot'):
            run('apt-get', 'update')
            run('apt-get', 'install', '-y', 'certbot')
    changes = without_domain_blocks(files, http_only=True)
    if not MANAGED_VHOST.parent.is_dir() or MANAGED_VHOST.is_symlink() or (MANAGED_VHOST.exists() and MANAGED_VHOST not in changes):
        raise ValueError(f'Cannot create the dedicated Nginx site: {MANAGED_VHOST}')
    root.mkdir(mode=0o755, parents=True, exist_ok=True)
    root.chmod(0o755)
    for directory in (root / '.well-known', root / '.well-known' / 'acme-challenge'):
        if directory.is_symlink():
            raise ValueError(f'Refusing a linked certificate validation directory: {directory}')
        directory.mkdir(mode=0o755, exist_ok=True)
        directory.chmod(0o755)
    original, remaining = changes.pop(MANAGED_VHOST, (None, ''))
    http = f'''server {{
    listen 80;
    listen [::]:80;
    server_name {DOMAIN};
    root {root};
    location ^~ /.well-known/acme-challenge/ {{ try_files $uri =404; }}
    location / {{ return {{fallback}}; }}
}}
'''
    tls = f'''server {{
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name {DOMAIN};
    root {root};
    ssl_certificate {certificate};
    ssl_certificate_key {key};
    ssl_protocols TLSv1.2 TLSv1.3;
    location / {{ try_files $uri =404; }}
}}
'''
    applied = []
    try:
        for path, (old, new) in changes.items():
            atomic_text(path, new)
            applied.append((path, old))
        if original is None:
            with MANAGED_VHOST.open('x') as stream:
                stream.write(remaining + http.replace('{fallback}', '503'))
        else:
            atomic_text(MANAGED_VHOST, remaining + http.replace('{fallback}', '503'))
        applied.append((MANAGED_VHOST, original))
        run('nginx', '-t')
        run('systemctl', 'reload', 'nginx')
        if not existing_cert:
            run('certbot', 'certonly', '--webroot', '--webroot-path', str(root), '--domain', DOMAIN,
                '--cert-name', DOMAIN, '--non-interactive', '--agree-tos', '--email', email,
                '--keep-until-expiring', '--deploy-hook', 'systemctl reload nginx')
            run('systemctl', 'enable', '--now', 'certbot.timer')
        atomic_text(MANAGED_VHOST, remaining + http.replace('{fallback}', f'308 https://{DOMAIN}$request_uri') + tls)
        run('nginx', '-t')
        run('systemctl', 'reload', 'nginx')
        return nginx_files()
    except Exception:
        for path, old in reversed(applied):
            if old is None:
                path.unlink(missing_ok=True)
            else:
                atomic_text(path, old)
        subprocess.run(['systemctl', 'reload', 'nginx'], check=False)
        raise


def uninstall():
    if not CONFIG.is_file():
        raise ValueError('The Asan Gozar storefront is not installed.')
    if json.loads(CONFIG.read_text()).get('origin') != f'https://{DOMAIN}':
        raise ValueError('The selected domain does not match the installed storefront.')
    files = nginx_files()
    marker = CONFIG.parent / 'site-root'
    if marker.is_file():
        root = dedicated_root(Path(marker.read_text().strip()), files)
    else:
        root, _ = vhost_plan(files)
    changes = without_domain_blocks(files)
    paths = (APP, RUNTIME, DATA, CONFIG.parent)
    for path in paths:
        if path.is_symlink() or path != path.resolve():
            raise ValueError(f'Refusing to remove a linked installation path: {path}')
        refuse_mounted_tree(path)
    applied = []
    try:
        for path, (old, new) in changes.items():
            atomic_text(path, new)
            applied.append((path, old))
        run('nginx', '-t')
        run('systemctl', 'reload', 'nginx')
        if SERVICE.exists():
            run('systemctl', 'disable', '--now', 'asan-gozar-store.service')
    except Exception:
        for path, old in reversed(applied):
            atomic_text(path, old)
        subprocess.run(['systemctl', 'reload', 'nginx'], check=False)
        raise
    if MANAGED_VHOST in changes and not changes[MANAGED_VHOST][1].strip():
        MANAGED_VHOST.unlink(missing_ok=True)
    SERVICE.unlink(missing_ok=True)
    SNIPPET.unlink(missing_ok=True)
    run('systemctl', 'daemon-reload')
    for path in (root, *paths):
        remove_path(path)
    try:
        account = pwd.getpwnam(USER)
    except KeyError:
        account = None
    if account is not None and account.pw_dir == str(DATA):
        run('userdel', USER)
    print(f'Removed the storefront, database, and Nginx routes for {DOMAIN}.', flush=True)


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


def get(url, *options):
    result = subprocess.run(['curl', '-fsS', '--noproxy', '*', '--connect-timeout', '2', '--max-time', '4',
                             *options, url], capture_output=True)
    return result.stdout if result.returncode == 0 else None


def api_matches(origin, options=()):
    for route, key, expected in [('state', 'signedIn', bool), ('notice', 'notice', (dict, type(None))),
                                 ('featured', 'plans', list), ('brand', 'name', str)]:
        body = get(f'{origin}/shop/api/{route}', *options)
        try:
            if not isinstance(json.loads(body)[key], expected):
                return False
        except (TypeError, ValueError, KeyError):
            return False
    return True


def service_ready():
    for _ in range(30):
        if api_matches('http://127.0.0.1:8787'):
            return
        time.sleep(.5)
    raise RuntimeError('The new store API did not start. Check journalctl -u asan-gozar-store -n 50.')


def served_release(public, domain=DOMAIN, port=443):
    origin = f'https://{domain}:{port}'
    pages = {'/' + name: hashlib.sha256((public / name).read_bytes()).hexdigest().encode() for name in PAGE_NAMES}
    pages['/'] = pages['/index.html']
    assets = {f'/{name}': (public / name).read_bytes() for name in PUBLIC_ASSETS}
    failed = '/'
    loopback = ('--resolve', f'{domain}:{port}:127.0.0.1')
    for options in (loopback, (), loopback):
        for route, expected in pages.items():
            headers = get(origin + route, *options, '--head') or b''
            if not re.search(rb'^x-store-template-sha256: *' + expected + rb'\r?$', headers, re.M | re.I):
                failed = route
                break
        else:
            for route, expected in assets.items():
                if get(origin + route, *options) != expected:
                    failed = route
                    break
            else:
                if not api_matches(origin, options):
                    failed = '/shop/api/'
                else:
                    for route in ('/README.txt', '/shop/shop.css'):
                        if get(origin + route, *options, '--no-fail', '--head', '--output', '/dev/null',
                               '--write-out', '%{http_code}') != b'404':
                            failed = route
                            break
                    else:
                        return
        time.sleep(.5)
    raise RuntimeError(f'HTTPS did not serve the new release at {failed}. Check the active Nginx virtual host.')


def main(archive):
    for cmd in ('nginx', 'systemctl', 'curl', 'tar', 'install', 'runuser', 'openssl'):
        if not shutil.which(cmd):
            raise ValueError(f'Missing command: {cmd}')
    with archive.open('rb') as bundle_file:
        bundle_id = hashlib.file_digest(bundle_file, 'sha256').hexdigest()[:12]
    print(f'Installing store release {bundle_id}', flush=True)
    if CONFIG.exists():
        conf = json.loads(CONFIG.read_text())
        if conf.get('origin') != f'https://{DOMAIN}' or conf.get('port') != 8787 or not re.fullmatch(r'[a-fA-F0-9]{64}', conf.get('secret', '')):
            raise ValueError(f'Existing store configuration differs from expected origin or port: {CONFIG}')
    files = nginx_files()
    if not any(tls and DOMAIN in names for _, _, _, names, tls in server_blocks(files)):
        files = provision_https(files)
    root, changes = vhost_plan(files)
    print(f'Using site root {root}', flush=True)

    with tempfile.TemporaryDirectory(prefix='asan-gozar-install-') as tmp:
        work = Path(tmp)
        with tarfile.open(archive) as bundle:
            bundle.extractall(work, filter='data')
        source = work / 'asan-gozar-store'
        public = work / 'asan_gozar_website'
        required = [source / 'package-lock.json', work / 'install-asan-gozar.py',
                    *(public / name for name in PAGE_NAMES + PUBLIC_ASSETS)]
        if not all(path.is_file() for path in required):
            raise ValueError('The archive is missing required store files.')
        if APP.is_symlink() or RUNTIME.is_symlink() or SNIPPET.is_symlink():
            raise ValueError('Unexpected symbolic link in the installation paths.')
        for name in PAGE_NAMES + PUBLIC_ASSETS:
            destination = root / name
            if destination.is_symlink():
                raise ValueError(f'Refusing linked site destination: {destination}')
        for name in ('robots.txt', 'sitemap.xml'):
            asset = public / name
            asset.write_text(asset.read_text().replace('https://asan-gozar.ir/', f'https://{DOMAIN}/'))
        database = DATA / 'store.sqlite'
        owner = None
        if database.exists():
            db = sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)
            try:
                owner = db.execute('SELECT username FROM store_accounts WHERE owner=1 ORDER BY id LIMIT 1').fetchone()
            finally:
                db.close()
        prompt = owner is None
        if prompt:
            username = owner_username()
            password = getpass.getpass('Choose store owner password (at least 8 characters): ')
            if password != getpass.getpass('Repeat store owner password: ') or len(password) < 8 or len(password.encode()) > 256 or any(c in password for c in '\x00\r\n'):
                raise ValueError('Passwords did not match or expected length was not met.')
        else:
            username = owner[0]
        node, npm = node_tools(work)
        installed_lock = APP / 'package-lock.json'
        reuse = (installed_lock.is_file() and installed_lock.read_bytes() == (source / 'package-lock.json').read_bytes()
                 and subprocess.run([str(node), '-e', 'require(require.resolve("qrcode", { paths: [process.argv[1]] }))',
                                     str(APP)], capture_output=True).returncode == 0)
        if reuse:
            print('Using the installed Node dependencies.', flush=True)
        else:
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
        run('install', '-m', '0644', str(work / 'install-asan-gozar.py'), str(APP / 'install-asan-gozar.py'))
        site_pages = APP / 'site'
        site_pages.mkdir(mode=0o755, exist_ok=True)
        for name in PAGE_NAMES:
            run('install', '-m', '0644', str(public / name), str(site_pages / name))
        APP.chmod(0o755)
        for item in APP.rglob('*'):
            if not item.is_symlink():
                item.chmod(0o755 if item.is_dir() else 0o644)
        if prompt:
            run('runuser', '-u', USER, '--', str(node), str(APP / 'account.mjs'), 'owner', username, 'مدیر فروشگاه',
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
        replaced = {}
        try:
            run('install', '-m', '0644', str(work / 'asan-gozar-shop.nginx.conf'), str(SNIPPET))
            for path, (_, updated) in changes.items():
                atomic_text(path, updated)
                applied.append(path)
            run('nginx', '-t')
            for name in PAGE_NAMES + PUBLIC_ASSETS:
                dest = root / name
                if dest.is_symlink():
                    raise ValueError(f'Refusing linked site destination: {dest}')
                replaced[dest] = (dest.read_bytes(), dest.stat()) if dest.is_file() else None
                run('install', '-m', '0644', str(public / name), str(dest))
            run('systemctl', 'reload', 'nginx')
            served_release(public)
        except Exception:
            for path, old in reversed(replaced.items()):
                if old is None:
                    path.unlink(missing_ok=True)
                else:
                    contents, metadata = old
                    path.write_bytes(contents)
                    os.chown(path, metadata.st_uid, metadata.st_gid)
                    path.chmod(stat.S_IMODE(metadata.st_mode))
            for path in reversed(applied):
                atomic_text(path, changes[path][0])
            if old_snippet is None:
                SNIPPET.unlink(missing_ok=True)
            else:
                SNIPPET.write_bytes(old_snippet)
            subprocess.run(['systemctl', 'reload', 'nginx'], check=False)
            raise
        marker = work / 'site-root'
        marker.write_text(str(root) + '\n')
        run('install', '-m', '0600', str(marker), str(CONFIG.parent / 'site-root'))
        clean_old_site(root)
    print(f'Installed and verified over HTTPS ({bundle_id}). Store: https://{DOMAIN}/  |  Admin username: {username}')
    print(f'Ticket management: https://{DOMAIN}/account.html?support=manage#tickets')


if __name__ == '__main__':
    try:
        if os.geteuid() != 0:
            raise ValueError('Run the installer with sudo.')
        if not DOMAIN_PATTERN.fullmatch(DOMAIN):
            raise ValueError('Enter a valid domain name without https:// or a path.')
        if len(sys.argv) != 2:
            raise ValueError('Pass the path to asan-gozar-standalone.tar.gz.')
        if sys.argv[1] == '--uninstall':
            uninstall()
        else:
            main(Path(sys.argv[1]).resolve(strict=True))
    except (ValueError, OSError, EOFError, RuntimeError, sqlite3.Error, subprocess.CalledProcessError, tarfile.TarError) as error:
        print(f'Installation stopped: {error}', file=sys.stderr)
        sys.exit(1)

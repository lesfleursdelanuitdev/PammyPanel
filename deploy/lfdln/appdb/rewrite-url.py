#!/usr/bin/env python3
# Points an app's connection strings at another port with each role's password there
# (docs/data-move-plan.md M6): used by move-db.sh on the apps' podman secrets (stdin to
# stdout) and on momolig's .env files (in place, keeping the file's owner, mode and
# inode). Only a URL that names this database on the old port, on this machine
# (localhost, 127.0.0.1, or 10.0.2.2 from a container), is changed: its port and its
# password. The role, host, database and everything after it stay as they were.
# docs/s1-plan.md S1f: --host also tells it another host (10.0.2.2 -> 127.0.0.1 for a
# container on pasta), --from-host only URLs at that one, --keep-passwords each URL's
# password as it is (no --pass needed).
#
#   rewrite-url.py --db DB --from 5432 --to 5436 --pass ROLE=FILE [...] [--file PATH] [--check]
#   rewrite-url.py --db DB --from 5436 --to 5436 --from-host 10.0.2.2 --host 127.0.0.1 --keep-passwords [--file PATH] [--check]
#
# Exit 3: no such URL in it. Exit 4: a URL for a role it has no password for (changes nothing).
import argparse
import os
import re
import sys

p = argparse.ArgumentParser()
p.add_argument('--db', required=True)
p.add_argument('--from', dest='old', required=True)
p.add_argument('--to', dest='new', required=True)
p.add_argument('--pass', dest='passes', action='append', default=[])
p.add_argument('--file')
p.add_argument('--check', action='store_true')
p.add_argument('--host', help='the host the URLs get (else each keeps its own)')
p.add_argument('--from-host', choices=['localhost', '127.0.0.1', '10.0.2.2'], help='only URLs at this host')
p.add_argument('--keep-passwords', action='store_true')
a = p.parse_args()

passwords = {}
for item in a.passes:
    role, _, path = item.partition('=')
    with open(path) as f:
        pw = f.read().strip()
    # the install makes them from [A-Za-z0-9] only, so they need no escaping in a URL
    if not re.fullmatch(r'[A-Za-z0-9]{16,}', pw):
        sys.exit(f"{role}'s password isn't one the install made")
    passwords[role] = pw

if a.host is not None and not re.fullmatch(r'(localhost|127\.0\.0\.1|10\.0\.2\.2)', a.host):
    sys.exit('--host is localhost, 127.0.0.1 or 10.0.2.2')
if a.keep_passwords and a.passes:
    sys.exit('--keep-passwords or --pass, not both')
HOSTS = re.escape(a.from_host) if a.from_host else r'localhost|127\.0\.0\.1|10\.0\.2\.2'
URL = re.compile(r'(postgres(?:ql)?://)([A-Za-z0-9_]+)((?::[^@\s"\']*)?)@(' + HOSTS + '):'
                 + re.escape(a.old) + '/' + re.escape(a.db) + r'(?![A-Za-z0-9_])')

text = open(a.file, encoding='utf-8').read() if a.file else sys.stdin.read()
found = URL.findall(text)
if not found:
    sys.stderr.write(f'no URL for {a.db} on :{a.old}\n')
    sys.exit(3)
unknown = [] if a.keep_passwords else sorted({m[1] for m in found} - passwords.keys())
if unknown:
    sys.stderr.write(f"a URL for {', '.join(unknown)}, which this move has no password for\n")
    sys.exit(4)
cred = (lambda m: m[3]) if a.keep_passwords else (lambda m: f':{passwords[m[2]]}')
out = URL.sub(lambda m: f'{m[1]}{m[2]}{cred(m)}@{a.host or m[4]}:{a.new}/{a.db}', text)
if a.check:
    print(len(found))
elif a.file:
    with open(a.file, 'r+', encoding='utf-8') as f:     # the same file: its owner, mode and inode stay
        f.seek(0)
        f.write(out)
        f.truncate()
        f.flush()
        os.fsync(f.fileno())
else:
    sys.stdout.write(out)

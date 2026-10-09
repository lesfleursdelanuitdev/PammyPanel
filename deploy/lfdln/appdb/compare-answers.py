#!/usr/bin/env python3
# Says how the live site's answer and the rehearsal's differ (move-db.sh rehearse), when
# their bytes do. A fresh copy keeps each table's rows in a new order on disk, so a query
# with no ORDER BY, or one whose ORDER BY leaves ties (frequency DESC, LIMIT 200), may give
# the same rows in another order, or other rows among those tied at the cut-off. Those two
# are said, and pass; anything else is a difference.
#
#   compare-answers.py LIVE NEW
#
# Prints one line per list that differs: "order <path>", "ties <path> <key>=<value> <n>",
# or "differ <path>: ...". Exit 0: only order and ties. Exit 1: a difference (or not JSON).
import json
import sys


def canon(v):
    """v with every list sorted and every object's keys sorted, as a string to compare by."""
    if isinstance(v, dict):
        return '{' + ','.join(json.dumps(k) + ':' + canon(v[k]) for k in sorted(v)) + '}'
    if isinstance(v, list):
        return '[' + ','.join(sorted(canon(x) for x in v)) + ']'
    return json.dumps(v)


def number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def tied_at_cutoff(a, b, gone, came):
    """The key whose value all the rows that differ share with the last row of both lists,
    both lists sorted by it: other rows tied at the LIMIT's cut-off. None if there is none."""
    if len(a) != len(b) or not a or not all(isinstance(x, dict) for x in a + b):
        return None
    for k in sorted(set(a[0]).intersection(*a[1:], *b)):
        if not all(number(x[k]) for x in a + b):
            continue
        for seq in ([x[k] for x in a], [x[k] for x in b]):
            if not (all(p >= q for p, q in zip(seq, seq[1:])) or all(p <= q for p, q in zip(seq, seq[1:]))):
                break
        else:
            last = a[-1][k]
            if b[-1][k] == last and all(x[k] == last for x in gone + came):
                return k, last
    return None


def walk(a, b, path, out):
    if a == b:
        return
    if canon(a) == canon(b) and not isinstance(a, dict):
        out.append(f'order {path}')
        return
    if isinstance(a, dict) and isinstance(b, dict):
        if set(a) != set(b):
            out.append(f'differ {path}: keys {sorted(set(a) ^ set(b))}')
            return
        for k in a:
            walk(a[k], b[k], f'{path}.{k}', out)
        return
    if isinstance(a, list) and isinstance(b, list):
        ca, cb = [canon(x) for x in a], [canon(x) for x in b]
        left = list(cb)
        gone = []
        for x, c in zip(a, ca):
            if c in left:
                left.remove(c)
            else:
                gone.append(x)
        came = [x for x, c in zip(b, cb) if c not in ca]
        tie = tied_at_cutoff(a, b, gone, came)
        if tie:
            out.append(f'ties {path} {tie[0]}={tie[1]} {len(gone)}')
        else:
            out.append(f'differ {path}: {len(a)} and {len(b)} items, {len(gone)} of the live ones not in the rehearsal\'s')
        return
    out.append(f'differ {path}: {json.dumps(a)[:80]} and {json.dumps(b)[:80]}')


try:
    live, new = (json.load(open(f)) for f in sys.argv[1:3])
except ValueError:
    print('differ $: not JSON')
    sys.exit(1)
out = []
walk(live, new, '$', out)
print('\n'.join(out))
sys.exit(1 if any(line.startswith('differ') for line in out) else 0)

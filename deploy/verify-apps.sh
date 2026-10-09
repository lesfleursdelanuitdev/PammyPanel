#!/usr/bin/env bash
# Check the software helper for real (docs/apps-plan.md phase 1): the local tests
# can't reach these.
#   - only the panel's user can ask it; it runs as root with ONE capability
#     (reading), writes nothing but its record, and reaches loopback only
#   - the WordPress already here is adopted, and what the helper says about it
#     matches what is actually running, served and stored
#   - adopting it changed nothing of WordPress (A1): verify-wordpress.sh's own
#     view of it still holds, through nginx
#
#   sudo ~/pamela-setup/panel/deploy/verify-apps.sh      (verify-panel.sh runs it)
# Changes nothing.
set -uo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
SVC=svc-pammypanel
APP=/opt/pammy-panel
SOCK=/run/pammy-apps.sock
STATE=/var/lib/pammy-apps
WP=svc-pammywp

pass=0 fail=0
ok()   { printf '  ok    %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  FAIL  %s\n' "$1"; fail=$((fail+1)); }
note() { printf '  note  %s\n' "$1"; }
t_ok() { local l=$1; shift; if "$@" >/dev/null 2>&1; then ok "$l"; else bad "$l"; fi; }
t_no() { local l=$1; shift; if "$@" >/dev/null 2>&1; then bad "$l"; else ok "$l"; fi; }
acall() {  # acall <user> <json> -- ask the software helper the way the panel does
    local user=$1; shift
    (cd / && runuser -u "$user" -- /usr/bin/node --disable-warning=ExperimentalWarning "$APP/src/apps/call.ts" "$@")
}
jget() {  # jget <json> <expression on j> -- one value out of the helper's answer
    /usr/bin/node -e 'const j = JSON.parse(process.argv[1]); const v = (0, eval)(`(j) => ${process.argv[2]}`)(j); console.log(typeof v === "string" ? v : JSON.stringify(v));' "$1" "$2"
}

echo "--- software helper (pammy-apps: root, read-only in phase 1, docs/apps-plan.md G2)"
t_ok "socket is root:$SVC 660"                       test "$(stat -c '%U:%G %a' "$SOCK")" = "root:$SVC 660"
t_ok "the panel's user can ask it"                   acall "$SVC" '{"op":"list","actor":"verify"}'
for u in pamela www-data svc-pammygate "$WP"; do
    id "$u" >/dev/null 2>&1 && t_no "$u can't ask it" acall "$u" '{"op":"list"}'
done
[[ -n ${SUDO_USER:-} && $SUDO_USER != root ]] && t_no "$SUDO_USER can't ask it without sudo" acall "$SUDO_USER" '{"op":"list"}'

apid=$(systemctl show -p MainPID --value pammy-apps)
if [[ $apid =~ ^[1-9][0-9]*$ ]]; then
    caps=$(grep '^CapBnd' "/proc/$apid/status" | awk '{print $2}')
    # CAP_DAC_READ_SEARCH is bit 2, and nothing else
    [[ $caps == 0000000000000004 ]] && ok "it holds one capability: reading files (CAP_DAC_READ_SEARCH), nothing else" \
        || bad "its capability set is $caps (want 0000000000000004)"
    t_ok "inside its sandbox: /pamela is blocked"          test "$(nsenter -t "$apid" -m -- stat -c %a /pamela)" = 0
    t_ok "inside its sandbox: the panel's secrets blocked" test "$(nsenter -t "$apid" -m -- stat -c %a /etc/pammy-panel)" = 0
    t_ok "inside its sandbox: /home is blocked"            test "$(nsenter -t "$apid" -m -- stat -c %a /home)" = 0
    t_no "inside its sandbox: /etc isn't writable"         nsenter -t "$apid" -m -- sh -c 'touch /etc/.pammy-probe && rm -f /etc/.pammy-probe'
    t_no "inside its sandbox: WordPress's files aren't writable" \
         nsenter -t "$apid" -m -- sh -c 'touch /srv/pamela-wordpress/.pammy-probe && rm -f /srv/pamela-wordpress/.pammy-probe'
    t_no "inside its sandbox: nginx's settings aren't writable" \
         nsenter -t "$apid" -m -- sh -c 'touch /etc/nginx/.pammy-probe && rm -f /etc/nginx/.pammy-probe'
    # phase 2: WordPress's three placement files are the one nginx folder it writes
    t_ok "inside its sandbox: WordPress's nginx folder IS writable (its placement files)" \
         nsenter -t "$apid" -m -- sh -c 'touch /etc/nginx/pammy-wordpress/.pammy-probe && rm -f /etc/nginx/pammy-wordpress/.pammy-probe'
    t_no "inside its sandbox: the rest of nginx's sites aren't" \
         nsenter -t "$apid" -m -- sh -c 'touch /etc/nginx/sites-available/.pammy-probe && rm -f /etc/nginx/sites-available/.pammy-probe'
else
    bad "the software helper isn't running after being asked"
fi
aprops=$(systemctl show pammy-apps -p NoNewPrivileges -p ProtectSystem -p ProtectHome -p RestrictAddressFamilies -p IPAddressDeny -p IPAddressAllow -p StateDirectory)
grep -qx 'NoNewPrivileges=yes' <<<"$aprops"                      && ok "it can't gain privileges (NoNewPrivileges)" || bad "pammy-apps NoNewPrivileges not set"
grep -qx 'ProtectSystem=strict' <<<"$aprops"                     && ok "the whole system is read-only to it (ProtectSystem=strict)" || bad "pammy-apps $(grep ProtectSystem <<<"$aprops")"
grep -qx 'ProtectHome=yes' <<<"$aprops"                          && ok "no home folders (ProtectHome=yes)" || bad "pammy-apps $(grep ProtectHome <<<"$aprops")"
grep -qx 'StateDirectory=pammy-apps' <<<"$aprops"                && ok "the one place it may write: $STATE" || bad "pammy-apps $(grep StateDirectory <<<"$aprops")"
grep -qxE 'IPAddressDeny=(0\.0\.0\.0/0 ::/0|::/0 0\.0\.0\.0/0)' <<<"$aprops"             && ok "it is denied every address to start with" || bad "pammy-apps $(grep IPAddressDeny <<<"$aprops")"
grep -qxE 'IPAddressAllow=(127\.0\.0\.0/8 ::1/128|::1/128 127\.0\.0\.0/8)' <<<"$aprops"       && ok "...and allowed loopback only" || bad "pammy-apps $(grep IPAddressAllow <<<"$aprops")"
grep -qx 'RestrictAddressFamilies=AF_INET AF_UNIX' <<<"$aprops"  && ok "it may use only its socket and IPv4" || bad "pammy-apps $(grep RestrictAddressFamilies <<<"$aprops")"
t_no "it refuses what it wasn't built to do (install)"  acall "$SVC" '{"op":"install","id":"shop"}'
t_no "it refuses a name that isn't installed"           acall "$SVC" '{"op":"status","id":"../etc"}'

echo "--- its record (/var/lib/pammy-apps)"
t_ok "$STATE is root's, 700"                          test "$(stat -c '%U %a' "$STATE")" = "root 700"
[[ -e $STATE/apps.json ]] && t_ok "apps.json is root's, 600" test "$(stat -c '%U %a' "$STATE/apps.json")" = "root 600"
list=$(acall "$SVC" '{"op":"list","actor":"verify"}' 2>/dev/null || echo '{"apps":[]}')
# software as the whole website only while nginx reads the pamela site (docs/phase8-plan.md 8-7d)
if [[ -L /etc/nginx/sites-enabled/pamela ]]; then want=true; else want=false; fi
[[ $(jget "$list" 'j.wholeSite') == "$want" ]] && ok "the whole website offered for software: $want (the pamela site $([[ $want == true ]] && echo enabled || echo out, pammy.org on its hosts))" \
    || bad "the helper says wholeSite=$(jget "$list" 'j.wholeSite'), expected $want"
# The blog (A1) can be deleted like any other (4c, P4c): its own checks run only
# while it is here.
blog=$(jget "$list" '((b) => !b ? "absent" : b.deleted ? "deleted" : "here")(j.apps.find((a) => a.id === "blog"))')
if [[ $blog == absent ]]; then
    if id "$WP" >/dev/null 2>&1; then bad "$WP is here, but the helper doesn't list the blog"
    else note "no blog: never installed here, or deleted for good -- its checks are skipped"; fi
elif [[ $blog == deleted ]]; then
    note "the blog is in the deleted software: its checks are skipped until it is restored"
else
# the blog, and any installed from the panel since (4b; checked further down)
[[ $(jget "$list" 'j.apps.some((a) => a.id === "blog")') == true ]] && ok "the WordPress already here is adopted, as \"blog\" (the helper lists: $(jget "$list" 'j.apps.map((a) => a.id).join(", ")'))" \
    || bad "the helper lists: $(jget "$list" 'j.apps.map((a) => a.id)')"
t_ok "...as $WP's"                                    grep -q "\"user\": \"$WP\"" "$STATE/apps.json"
fi

if [[ $blog == here ]]; then

echo "--- what it says about WordPress is what is there"
st=$(acall "$SVC" '{"op":"status","id":"blog","actor":"verify"}' 2>/dev/null || echo '{}')
if [[ $st == '{}' ]]; then
    bad "it gave no status for blog"
else
    placement=$(tr -d '\n' < /etc/nginx/pammy-wordpress/placement)
    said=$(jget "$st" 'j.placement ? [j.placement.mode, j.placement.name].filter(Boolean).join(" ") : "unreadable"')
    [[ $said == "$placement" ]] && ok "where it is served: $said (nginx's placement line)" || bad "it says '$said', nginx says '$placement'"
    version=$(sed -n "s/^\$wp_version = '\(.*\)';/\1/p" /srv/pamela-wordpress/wp-includes/version.php)
    [[ $(jget "$st" 'j.version') == "$version" && -n $version ]] && ok "its version: WordPress $version" || bad "version: it says $(jget "$st" 'j.version'), the files say $version"
    for role in web db; do
        unit=$(jget "$st" "j.containers.find((c) => c.role === '$role').unit")
        live=$(systemctl --user -M "$WP@" is-active "$unit" 2>/dev/null)
        said=$(jget "$st" "j.containers.find((c) => c.role === '$role').running")
        [[ ($live == active && $said == true) || ($live != active && $said == false) ]] && ok "$unit: $live, and it says running=$said" \
            || bad "$unit: systemd says $live, it says running=$said"
        [[ $live != active || $(jget "$st" "j.containers.find((c) => c.role === '$role').memory > 0") == true ]] \
            && ok "$unit's memory is read from its control group" || bad "$unit's memory: $(jget "$st" "j.containers.find((c) => c.role === '$role').memory")"
    done
    address=$(jget "$st" 'j.address')
    if [[ $address == null ]]; then
        note "WordPress is served nowhere (placement off): no address to check"
    else
        h=${address#https://}; h=${h%%/*}
        code=$(curl -sk --max-time 15 -o /dev/null -w '%{http_code}' --resolve "$h:443:127.0.0.1" "$address" || echo 000)
        [[ $(jget "$st" 'j.answering.ok') == true && $code =~ ^[23] ]] && ok "it answers at $address ($code), and the helper saw it answer" \
            || bad "at $address: curl got $code, the helper says answering=$(jget "$st" 'j.answering')"
    fi
    [[ $(jget "$st" 'j.state') == running || $(jget "$st" 'j.state') == offline ]] && ok "state: $(jget "$st" 'j.state')" \
        || bad "state: $(jget "$st" 'j.state') -- $(jget "$st" 'j.problems.join("; ")')"
    # the one capability at work: these are svc-pammywp's, 700 and 2770
    [[ $(jget "$st" 'j.disk.files > 0 && j.disk.database > 0') == true ]] && ok "it can read WordPress's files and database volume for their size" \
        || bad "sizes: $(jget "$st" 'j.disk')"
    whole=$(find /var/lib/$WP/backups -maxdepth 1 -name 'files-*.tar.gz' -printf '%f\n' 2>/dev/null \
        | sed 's/^files-\(.*\)\.tar\.gz$/\1/' | while read -r s; do [[ -f /var/lib/$WP/backups/db-$s.sql.gz ]] && echo "$s"; done | wc -l)
    [[ $(jget "$st" 'j.backups.count') == "$whole" ]] && ok "backups: $whole, as in /var/lib/$WP/backups" \
        || bad "backups: it says $(jget "$st" 'j.backups.count'), the folder has $whole"
    t_ok "where she finds its files: /pamela/wordpress"  test "$(jget "$st" 'j.filesPath')" = /pamela/wordpress
fi

echo "--- phase 2: it can have things done as WordPress's user (changes nothing)"
# Listing WordPress's administrators runs wp-cli in a container as svc-pammywp,
# through systemd-run over the system bus: the path every phase 2 change takes.
if [[ $(jget "$st" 'j.offline === null') != true ]]; then
    note "the blog is offline, so wp-cli isn't asked (it needs its database running)"
else
admins=$(acall "$SVC" '{"op":"admins","id":"blog","actor":"verify"}' 2>&1)
if [[ $(jget "$admins" 'Array.isArray(j.admins) && j.admins.length > 0' 2>/dev/null) == true ]]; then
    ok "wp-cli ran as $WP through systemd (administrators: $(jget "$admins" 'j.admins.join(", ")'))"
else
    bad "listing WordPress's administrators failed: $admins"
fi
t_ok "...as a named transient unit, in the journal" \
    sh -c "journalctl --since '-5min' -q --no-pager | grep -q 'pammy-apps-wp-cli-'"
fi
logs=$(acall "$SVC" '{"op":"logs","id":"blog","actor":"verify"}' 2>&1)
[[ $(jget "$logs" 'Array.isArray(j.web) && Array.isArray(j.db)' 2>/dev/null) == true ]] && ok "it reads WordPress's complaints from the journal" || bad "logs: $logs"
bk=$(acall "$SVC" '{"op":"backups","id":"blog","actor":"verify"}' 2>&1)
[[ $(jget "$bk" 'j.backups.length' 2>/dev/null) == "${whole:-none}" ]] && ok "it lists the same ${whole:-} backups" || bad "backups: $bk"
note "not tried here, because they change things: Back up now, Put this back, Take it offline, a new admin password -- try them from the panel"
fi   # the blog is here

echo "--- nginx (4a): WordPress's files are what the helper would write for every install"
same=$(/usr/bin/node --disable-warning=ExperimentalWarning --input-type=module -e "
  import { readFileSync } from 'node:fs';
  import { renderAll } from '$APP/src/apps/nginx.ts';
  import { parsePlacement } from '$APP/src/apps/placement.ts';
  const line = (f) => { try { return readFileSync(f, 'utf8'); } catch { return null; } };
  // an install that stopped before its address was written isn't in nginx yet
  const apps = JSON.parse(readFileSync('$STATE/apps.json', 'utf8')).apps.filter((a) => !a.setup || line(a.placementFile) !== null);
  const placed = apps.sort((x, y) => x.installedAt - y.installedAt || x.id.localeCompare(y.id)).map((a) => ({
    id: a.id, port: a.port, placementFile: a.placementFile, adopted: a.layout === 'adopted-wordpress',
    placement: parsePlacement(line(a.placementFile)) ?? { mode: 'off', name: null } }));
  const diff = [...renderAll('$APP/apps/wordpress-nginx', placed)].filter(([f, t]) => { try { return readFileSync(f, 'utf8') !== t; } catch { return true; } }).map(([f]) => f);
  console.log(diff.length ? 'differ: ' + diff.join(' ') : 'same');
" 2>&1)
[[ $same == same ]] && ok "main.conf, server.conf and each placement line are exactly what the helper writes" || bad "nginx's WordPress files: $same"

echo "--- installs from the panel (4b): each its own user, files and settings, and nothing of anyone else's"
ids=$(jget "$(cat "$STATE/apps.json")" 'j.apps.filter((a) => a.layout === "standard").map((a) => a.id).join(" ")')
[[ -z $ids ]] && note "none installed from the panel yet"
for id in $ids; do
    u=svc-app-$id
    ist=$(acall "$SVC" "{\"op\":\"status\",\"id\":\"$id\",\"actor\":\"verify\"}" 2>/dev/null || echo '{}')
    if [[ $(jget "$ist" 'Boolean(j.deleted)') == true ]]; then
        note "$id: deleted, kept until $(date -u -d "@$(jget "$ist" 'j.deleted.until')" '+%F %H:%M UTC')"
        continue
    fi
    if [[ $(jget "$ist" 'j.setup !== null && j.setup !== undefined') == true ]]; then
        # half made: nothing to hold it to yet (Delete, 4c, clears it)
        note "$id: its install $( [[ $(jget "$ist" 'j.state') == failed ]] && echo "didn't finish" || echo "is still going") -- $(jget "$ist" 'j.problems.join("; ")')"
        continue
    fi
    t_ok "$id: its user $u, no login shell"            test "$(getent passwd "$u" | cut -d: -f7)" = /usr/sbin/nologin
    t_no "$id: $u is NOT in sudo"                        sh -c "id -nG $u | tr ' ' '\n' | grep -qx sudo"
    t_ok "$id: lingering (starts at boot)"              test -f "/var/lib/systemd/linger/$u"
    t_ok "$id: its files are $u's, 2770"                test "$(stat -c '%U %a' "/srv/pamela-apps/$id")" = "$u 2770"
    t_ok "$id: her link /pamela/apps/$id leads there"   test "$(readlink "/pamela/apps/$id")" = "/srv/pamela-apps/$id"
    t_ok "$id: its settings folder is root's, 755"      test "$(stat -c '%U %a' "/var/lib/$u/config")" = "root 755"
    t_no "$id: $u can't enter /pamela"                  runuser -u "$u" -- ls /pamela/public
    t_no "$id: $u can't read the blog's files"          runuser -u "$u" -- ls /srv/pamela-wordpress
    t_no "$id: $u can't rewrite its own settings"       runuser -u "$u" -- test -w "/var/lib/$u/config/wp.php"
    case $(jget "$ist" 'j.state') in
        running|offline) ok "$id: $(jget "$ist" 'j.state')$( [[ $(jget "$ist" 'j.address') != null ]] && echo " at $(jget "$ist" 'j.address')")" ;;
        installing|failed) note "$id: its install $( [[ $(jget "$ist" 'j.state') == failed ]] && echo "didn't finish" || echo "is still going") -- $(jget "$ist" 'j.problems.join("; ")')" ;;
        *) bad "$id: $(jget "$ist" 'j.state') -- $(jget "$ist" 'j.problems.join("; ")')" ;;
    esac
done

echo "--- deleting (4c): the deleted software goes for good after 30 days"
t_ok "the daily timer is on (pammy-apps-purge.timer)"   systemctl is-enabled -q pammy-apps-purge.timer
t_ok "...and asks as the panel's user, nothing more"    test "$(systemctl show -p User --value pammy-apps-purge.service)" = "$SVC"
overdue=$(jget "$list" "j.apps.filter((a) => a.deleted && a.deleted.until < $(date +%s) - 2 * 86400).map((a) => a.id).join(' ')")
[[ -z $overdue ]] && ok "nothing is kept past its 30 days" || bad "kept past its 30 days (is the timer running?): $overdue"

if [[ $blog == here ]]; then
echo "--- adopting it changed nothing of WordPress (A1)"
t_ok "its settings are still root:root 644"          test "$(stat -c '%U:%G %a' /var/lib/$WP/config/wp.php)" = "root:root 644"
t_ok "its nginx placement is still root's, 644"      test "$(stat -c '%U %a' /etc/nginx/pammy-wordpress/placement)" = "root 644"
note "WordPress's own full check (containers, sharing files with her, backups): sudo ~/pamela-setup/wordpress/verify-wordpress.sh"
fi

echo "--- mail (pammy-mail: the panel's emails through Resend, docs/apps-plan.md phase 3; sends nothing here)"
MAILU=svc-pammymail
MSOCK=/run/pammy-mail.sock
mcall() {  # mcall <user> <json> -- ask the mail service the way the panel does
    local user=$1; shift
    (cd / && runuser -u "$user" -- /usr/bin/node --disable-warning=ExperimentalWarning "$APP/src/mail/call.ts" "$@")
}
t_ok "system user $MAILU exists, no login shell"      test "$(getent passwd "$MAILU" | cut -d: -f7)" = /usr/sbin/nologin
t_ok "socket is root:$SVC 660"                        test "$(stat -c '%U:%G %a' "$MSOCK")" = "root:$SVC 660"
t_ok "the panel's user can ask it"                    mcall "$SVC" '{"op":"status"}'
for u in pamela www-data svc-pammygate "$WP"; do
    id "$u" >/dev/null 2>&1 && t_no "$u can't ask it" mcall "$u" '{"op":"status"}'
done
t_ok "the key file is root's, 600"                    test "$(stat -c '%U %a' /etc/pammy-mail/resend.key)" = "root 600"
t_ok "the settings are root's, 644"                   test "$(stat -c '%U %a' /etc/pammy-mail/settings.json)" = "root 644"
t_no "it can't read the key file itself"              runuser -u "$MAILU" -- cat /etc/pammy-mail/resend.key
mpid=$(systemctl show -p MainPID --value pammy-mail)
if [[ $mpid =~ ^[1-9][0-9]*$ ]]; then
    [[ $(ps -o uid= -p "$mpid" | tr -d ' ') == "$(id -u "$MAILU")" ]] && ok "runs as $MAILU" || bad "runs as uid $(ps -o uid= -p "$mpid" | tr -d ' ')"
    [[ $(grep '^CapBnd' "/proc/$mpid/status" | awk '{print $2}') == 0000000000000000 ]] && ok "it has no Linux capabilities" || bad "pammy-mail has capabilities"
    t_ok "inside its sandbox: /pamela is blocked"          test "$(nsenter -t "$mpid" -m -- stat -c %a /pamela)" = 0
    t_ok "inside its sandbox: /var/lib is blocked (WordPress, the panel's data)" test "$(nsenter -t "$mpid" -m -- stat -c %a /var/lib)" = 0
    t_no "inside its sandbox: nothing is writable"         nsenter -t "$mpid" -m -- sh -c 'touch /etc/.pammy-probe && rm -f /etc/.pammy-probe'
else
    bad "the mail service isn't running after being asked"
fi
t_ok "it gets the key through LoadCredential"         sh -c "systemctl cat pammy-mail | grep -q '^LoadCredential=resend.key:/etc/pammy-mail/resend.key'"
ms=$(mcall "$SVC" '{"op":"status"}' 2>/dev/null || echo '{}')
if [[ $(jget "$ms" 'j.ready') == true ]]; then
    ok "it is ready to send, from $(jget "$ms" 'j.from') to $(jget "$ms" 'j.notifyTo')"
    if [[ $blog == here ]]; then
    t_ok "WordPress has its mail settings (root 644, in its settings folder)" test "$(stat -c '%U %a' /var/lib/$WP/config/mail.json)" = "root 644"
    t_ok "WordPress has its mail plugin"               test -f /srv/pamela-wordpress/wp-content/mu-plugins/pammy-mail.php
    fi
else
    note "mail isn't set up yet ($(jget "$ms" 'j.why')): put the key in on the panel's Email page"
fi
note "not tried here, because they send email: the test buttons on the Email page and the WordPress page"

score=$(systemd-analyze security pammy-apps --no-pager 2>/dev/null | tail -1)
[[ -n $score ]] && note "software helper exposure rating: ${score#→ }"

echo
echo "  software: $pass passed, $fail failed"
[[ $fail -eq 0 ]]

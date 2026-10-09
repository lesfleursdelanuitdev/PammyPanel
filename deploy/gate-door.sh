# The gate's door to the database helper (docs/s2-plan.md), for both sites' installers
# (sourced). gate_door_refuses <command...>: the command asks the door for something that
# isn't a row op and prints "<code>: <message>"; true only if the door refused it in its own
# words. The command exits non-zero on a refusal, which is the answer wanted here, so its
# output is captured rather than piped (S2 review HIGH-1: `cmd | grep -q` under pipefail
# takes cmd's exit 1 as the pipeline's).
gate_door_refuses() {
    local out
    out=$("$@" 2>&1) || true
    [[ $out == "not-allowed: The gate's door"* ]]
}

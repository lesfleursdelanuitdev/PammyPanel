// A project's server answers (docs/phase8b-plan.md D4-3): its container's health check,
// copied into each release by build.mjs. Any answer below 500 from / is well.
const r = await fetch(`http://127.0.0.1:${process.env.PORT || 3000}/`, { redirect: 'manual', signal: AbortSignal.timeout(4000) }).catch(() => null);
process.exit(r && r.status < 500 ? 0 : 1);

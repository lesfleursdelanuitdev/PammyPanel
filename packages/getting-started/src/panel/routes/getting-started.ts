// Getting started (docs/getting-started-plan.md): "What would you like to do?",
// the paths it recommends, and how far each one has got.
//
// The databases right (D4; rights.ts), never for a person kept to places. Home asks without
// `deep`, so nothing here waits on her own databases there (G4); the Getting
// started page asks with it.
import type { FastifyInstance } from 'fastify';
import { AccountError } from '@panel/core/accounts';
import { gatherFacts } from '../../getting-started/facts.ts';
import { PATHS } from '../../getting-started/paths.ts';
import { cleanAnswers, nextQuestion, recommend, type Answers } from '../../getting-started/questions.ts';
import { homeOpen, listPaths, notTheOne, putAway, saveFound, setHomeOpen, setStep, startPath } from '../../getting-started/store.ts';
import { pathView, recommendation, type PathView } from '../../getting-started/view.ts';
import type { PanelCtx } from '@panel/core/panel/context';

const answersOf = (v: unknown): Answers => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k, x]) => typeof x === 'string' && k.length <= 20).slice(0, 10)) as Answers;
};

export function routes(app: FastifyInstance, ctx: PanelCtx) {
  const { db, now, need, body, idParam, gate, helper, studio, config } = ctx;
  const site = config.rpID.replace(/^panel\./, '');

  app.get('/api/getting-started', { config: { needs: 'databases' } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const deep = (req.query as { deep?: string }).deep === '1';
    const [open, started] = await Promise.all([homeOpen(db, a.user.id), listPaths(db)]);
    const paths: PathView[] = [];
    if (started.length) {
      const f = await gatherFacts({ db, deep, gate, helper, studio, actor: a.user.username });
      for (const p of started) {
        const { view, links, finished } = await pathView(p, f, site);
        // Home can't see the steps that ask her database ("can't tell"), so a path
        // stays finished until a step is plainly not done any more
        const undone = view.steps.some((s) => s.state === 'todo');
        const finishedAt = finished ? p.finishedAt ?? now() : undone ? null : p.finishedAt;
        paths.push({ ...view, finished: finishedAt !== null });
        if (JSON.stringify(links) !== JSON.stringify(p.links) || finishedAt !== p.finishedAt) await saveFound(db, p.id, links, finishedAt);
      }
    }
    return { open, paths };
  });

  // One question at a time: what she has answered so far, back comes the next
  // question, or the recommendation once there is nothing left to ask.
  app.post('/api/getting-started/ask', { config: { needs: 'databases' } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const answers = cleanAnswers(answersOf(body(req).answers));
    const question = nextQuestion(answers);
    return question ? { answers, question } : { answers, recommendation: recommendation(answers) };
  });

  app.post('/api/getting-started/start', { config: { needs: 'databases' } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const answers = cleanAnswers(answersOf(body(req).answers));
    if (nextQuestion(answers)) throw new AccountError('Please answer the questions first.', 400);
    const { path } = recommend(answers);
    const id = await startPath(db, { path, answers, by: a.user.username, at: now() });
    return { id, path, title: PATHS[path].title };
  });

  app.post('/api/getting-started/:id/step', { config: { needs: 'databases' } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const id = idParam(req, 'id');
    const b = body(req);
    const started = (await listPaths(db)).find((p) => p.id === id);
    if (!started) throw new AccountError('That is not one of the things you started.', 404);
    const step = PATHS[started.path].steps(started.answers).find((s) => s.key === b.step);
    if (!step) throw new AccountError('That path has no such step.', 400);
    if (b.state !== 'skipped' && b.state !== 'done-by-hand' && b.state !== null) throw new AccountError('Skip it, tick it, or neither.', 400);
    // Q3: the site decides wherever it can
    if (b.state === 'done-by-hand' && step.check) throw new AccountError('The panel ticks this one by itself, once it is done.', 400);
    await setStep(db, id, step.key, b.state, a.user.username, now());
    return { ok: true };
  });

  app.post('/api/getting-started/:id/not-the-one', { config: { needs: 'databases' } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const what = body(req).what;
    if (what !== 'db' && what !== 'form' && what !== 'area') throw new AccountError('Which one?', 400);
    await notTheOne(db, idParam(req, 'id'), what);
    return { ok: true };
  });

  app.post('/api/getting-started/:id/put-away', { config: { needs: 'databases' } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    await putAway(db, idParam(req, 'id'), now());
    return { ok: true };
  });

  // The Home block, open or closed (D2), for this account only.
  app.post('/api/getting-started/open', { config: { needs: 'databases' } }, async (req, reply) => {
    const a = await need(req, reply);
    if (!a) return reply;
    const open = body(req).open;
    if (typeof open !== 'boolean') throw new AccountError('Open or closed?', 400);
    await setHomeOpen(db, a.user.id, open);
    return { open };
  });
}

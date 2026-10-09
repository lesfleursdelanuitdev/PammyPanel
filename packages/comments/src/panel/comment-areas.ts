// Pointing a comment area at the comments tables of one of her apps
// (docs/comments-plan.md A1, A2). Used from Comments, where she chooses it, and
// from the tutorial examples, which set one up for her.
//
// The link itself is the gate's: this works out which question is the author
// and which is the comment, and asks.
import { AccountError } from '@panel/core/accounts';
import { isAnswerType } from '@panel/forms/shared/form-types';
import type { Engine } from '@panel/studio/pammydb/ident';
import type { Authed } from '@panel/core/sessions';
import type { FormFull } from '@panel/core/panel/gate-shapes';
import type { PanelCtx } from '@panel/core/panel/context';

export function commentAreas(ctx: PanelCtx) {
  const { gate } = ctx;

  const linkCommentArea = async (a: Authed, formId: number, databaseId: number, engine: Engine, name: string) => {
    const f = await gate<FormFull>({ op: 'form.get', id: formId });
    const answers = f.items.filter((i) => isAnswerType(i.type) && i.key);
    const author = answers.find((i) => i.type === 'name' || i.type === 'short-text');
    const body = answers.find((i) => i.type === 'long-text');
    if (!body) throw new AccountError('A comment area needs a long answer for the comment itself before its comments can be kept.', 400);
    await gate({ op: 'formlink.save', id: f.id, actor: a.user.username, link: {
      mode: 'comments', databaseId, engine, name, table: 'comments', when: 'approved', fixed: [], enabled: true,
      pairs: [...(author ? [{ key: author.key, field: 'author' }] : []), { key: body.key, field: 'body' }],
    } });
  };

  return { linkCommentArea };
}

// The two database examples (docs/db-examples-plan.md): a recipe book on
// Postgres and a blog on MariaDB. Each is a database -- tables, connections,
// sample rows -- plus what its app says about those tables, plus which of them
// anyone may read, so its public page works without a key.
//
// Everything here is DATA. The tables are built with the same functions the
// Database Manager uses (starterTable, addRelationship), so an example can never
// hold something the canvas could not have drawn -- and test/studio.test.ts
// checks each one passes checkSnapshot and applies to an empty database.
//
// Pure: no database, no socket, no clock. Making, seeding and resetting them
// is src/app.ts's job, through the database helper like everything else.
import type { Engine } from '@panel/studio/pammydb/ident';
import { starterTable, type Column, type Snapshot, type Table } from '@panel/studio/pammydb/ir';
import type { Scalar } from '@panel/studio/pammydb/rows';
import { addRelationship } from '@panel/studio/studio/relationships';
import { COMMENT_RESOURCES, linkResource, withCommentLink } from '@panel/comments/studio/comments-tables';
import type { FieldPatch, ResourcePatch } from '@panel/studio/studio/resources';

export const DB_EXAMPLE_KINDS = ['recipes', 'blog'] as const;
export type DbExampleKind = (typeof DB_EXAMPLE_KINDS)[number];
export const isDbExampleKind = (k: unknown): k is DbExampleKind => DB_EXAMPLE_KINDS.includes(k as DbExampleKind);

// A value in a sample row: plain, or "the id the engine gave the row called
// this" (X4: rows go in without ids), or "this picture, beside the page".
export type SeedValue = Scalar | { ref: string } | { picture: string };
export type SeedRow = { table: string; ref?: string; values: Record<string, SeedValue> };

export type DbExample = {
  kind: DbExampleKind;
  engine: Engine;
  // the example's own database, which the panel owns (X2)
  database: string;
  // the example app's name -- never in her menu (X6), but it is what the
  // Database Manager calls it
  title: string;
  heading: string;
  about: string;
  // her copy: what the form suggests
  suggested: { name: string; title: string; pageName: string };
  tables: Table[];
  // what the app says about each table, on top of what the panel works out
  resources: Record<string, { patch: ResourcePatch; fields?: Record<string, FieldPatch>; order?: string[] }>;
  rows: SeedRow[];
  // the picture files the rows use, in public-gate/examples/<kind>/pictures/
  pictures: string[];
  // docs/comments-plan.md: the example's comment area (a fixture in the gate,
  // like the form examples) and its sample comments, each on a post by its
  // address -- most posts have none, as on a real blog
  comments?: {
    area: { name: string; fixture: string; title: string; contentType: string };
    items: { post: string; author: string; body: string; daysAfter: number }[];
  };
};

// ------------------------------------------------------------------ building blocks

const col = (name: string, type: Column['type'], over: Partial<Column> = {}): Column =>
  ({ name, type, required: false, default: null, ...over });
const line = (name: string, length: number, over: Partial<Column> = {}) => col(name, 'short_text', { length, ...over });

// id, created_at, updated_at -- the same start every new table gets on the canvas
const table = (name: string, columns: Column[], over: Partial<Table> = {}): Table => {
  const start = starterTable(name);
  const [id, ...dates] = start.columns;
  return { ...start, columns: [id!, ...columns, ...dates], ...over };
};

// a table without the two dates, for the small ones nobody sorts by date
const plain = (name: string, columns: Column[], over: Partial<Table> = {}): Table => {
  const start = starterTable(name);
  return { ...start, columns: [start.columns[0]!, ...columns], ...over };
};

const snapshot = (engine: Engine, database: string, tables: Table[]): Snapshot =>
  ({ engine, database, tables, notes: [] });

// ------------------------------------------------------------------ the recipe book

function recipeTables(): Table[] {
  let s = snapshot('postgres', 'example_recipes', [
    plain('cooks', [line('name', 80, { required: true }), col('about', 'text')]),
    table('recipes', [
      line('title', 120, { required: true }),
      col('summary', 'text'),
      col('method', 'text'),
      col('servings', 'integer', { default: { kind: 'number', value: 4 } }),
      col('prep_minutes', 'integer'),
      col('cook_minutes', 'integer'),
      col('vegetarian', 'boolean', { required: true, default: { kind: 'boolean', value: false } }),
      line('picture', 500),
    ]),
    plain('ingredients', [
      col('recipe_id', 'integer', { required: true }),
      col('position', 'integer'),
      line('amount', 60),
      line('item', 120, { required: true }),
    ]),
    plain('tags', [line('name', 60, { required: true })], { uniques: [{ name: 'tags_name_key', columns: ['name'] }] }),
  ]);
  // the connections, drawn the way the canvas draws them
  s = addRelationship(s, { from: { table: 'cooks', column: 'id' }, to: { table: 'recipes' }, kind: 'one-to-many', onDelete: 'set null' });
  s = addRelationship(s, { from: { table: 'recipes', column: 'id' }, to: { table: 'ingredients', column: 'recipe_id' }, kind: 'one-to-many', onDelete: 'cascade' });
  s = addRelationship(s, { from: { table: 'recipes', column: 'id' }, to: { table: 'tags' }, kind: 'many-to-many', onDelete: 'cascade' });
  return s.tables;
}

type Recipe = {
  ref: string; title: string; cook: string; picture: string; summary: string; method: string;
  servings: number; prep: number; cook_minutes: number; vegetarian: boolean;
  ingredients: [string, string][]; tags: string[];
};

const RECIPES: Recipe[] = [
  {
    ref: 'pancakes', title: 'Raspberry pancakes', cook: 'olivia', picture: 'pancakes.jpg', servings: 4, prep: 10, cook_minutes: 15, vegetarian: true,
    summary: 'Thick, soft pancakes for a slow Sunday, piled up with raspberries and a dusting of sugar.',
    method: 'Whisk the flour, baking powder, sugar and a pinch of salt in a big bowl.\n\nBeat the eggs into the milk with the melted butter, pour it into the flour and stir until just mixed. A few lumps are fine.\n\nHeat a little butter in a frying pan over a medium heat. Drop in a ladle of batter at a time and cook until bubbles come up through the top, then turn it over for another minute.\n\nKeep them warm in a low oven while you cook the rest, then pile them up with the raspberries and a dusting of icing sugar.',
    ingredients: [['200 g', 'self-raising flour'], ['1 tsp', 'baking powder'], ['1 tbsp', 'caster sugar'], ['2', 'eggs'], ['300 ml', 'milk'], ['25 g', 'butter, melted'], ['150 g', 'raspberries'], ['', 'icing sugar, to dust']],
    tags: ['quick', 'weekend', 'family'],
  },
  {
    ref: 'soup', title: 'Roast tomato soup', cook: 'rose', picture: 'tomato-soup.jpg', servings: 4, prep: 15, cook_minutes: 45, vegetarian: true,
    summary: 'Tomatoes roasted until they are sweet and sticky, then blended smooth. Better the next day.',
    method: 'Heat the oven to 200 °C (180 °C fan). Halve the tomatoes and put them in a roasting tin with the onion and garlic. Drizzle with oil, season, and roast for 35 minutes.\n\nTip everything into a pan with the stock and simmer for 10 minutes.\n\nBlend until smooth, then taste and add salt, pepper or a pinch of sugar. Serve with a swirl of cream and something green on top.',
    ingredients: [['1 kg', 'ripe tomatoes'], ['1', 'red onion, in wedges'], ['3 cloves', 'garlic'], ['2 tbsp', 'olive oil'], ['500 ml', 'vegetable stock'], ['', 'a little cream, to serve']],
    tags: ['soup', 'family'],
  },
  {
    ref: 'banana', title: 'Banana and walnut bread', cook: 'rose', picture: 'banana-bread.jpg', servings: 10, prep: 15, cook_minutes: 60, vegetarian: true,
    summary: 'The thing to do with the bananas nobody ate. Keeps for days, and toasts beautifully.',
    method: 'Heat the oven to 180 °C (160 °C fan) and line a 2 lb loaf tin.\n\nMash the bananas in a big bowl. Beat in the melted butter, sugar, egg and vanilla.\n\nStir in the flour, bicarbonate of soda and a pinch of salt, then the walnuts.\n\nScrape into the tin and bake for about an hour, until a skewer comes out clean. Leave it in the tin for ten minutes before turning it out.',
    ingredients: [['3', 'very ripe bananas'], ['75 g', 'butter, melted'], ['150 g', 'light brown sugar'], ['1', 'egg'], ['1 tsp', 'vanilla extract'], ['190 g', 'plain flour'], ['1 tsp', 'bicarbonate of soda'], ['75 g', 'walnuts, chopped']],
    tags: ['baking', 'family'],
  },
  {
    ref: 'lemon', title: 'Lemon drizzle loaf', cook: 'olivia', picture: 'lemon-drizzle.jpg', servings: 10, prep: 20, cook_minutes: 45, vegetarian: true,
    summary: 'A light sponge soaked in sharp lemon syrup while it is still warm, with a crackly top.',
    method: 'Heat the oven to 180 °C (160 °C fan) and line a 2 lb loaf tin.\n\nBeat the butter and sugar until pale, then beat in the eggs one at a time. Fold in the flour and the zest of both lemons.\n\nBake for 45 minutes, until golden and a skewer comes out clean.\n\nWhile it bakes, stir the lemon juice into the granulated sugar. Prick the warm cake all over and spoon the drizzle over it. Let it cool in the tin.',
    ingredients: [['225 g', 'butter, softened'], ['225 g', 'caster sugar'], ['4', 'eggs'], ['225 g', 'self-raising flour'], ['2', 'lemons, zest and juice'], ['85 g', 'granulated sugar']],
    tags: ['baking', 'dessert', 'summer'],
  },
  {
    ref: 'curry', title: 'Chickpea curry', cook: 'sam', picture: 'chickpea-curry.jpg', servings: 4, prep: 10, cook_minutes: 30, vegetarian: true,
    summary: 'A warming weeknight curry from the cupboard: chickpeas, tomatoes and coconut, ready in half an hour.',
    method: 'Soften the onion in the oil for 8 minutes. Add the garlic, ginger and curry paste and cook for another 2.\n\nAdd the tomatoes, coconut milk and chickpeas. Simmer for 20 minutes, until thick.\n\nStir in the spinach until it wilts, squeeze in the lime, and scatter with coriander. Serve with rice.',
    ingredients: [['1', 'onion, chopped'], ['1 tbsp', 'oil'], ['2 cloves', 'garlic'], ['1 thumb', 'ginger, grated'], ['3 tbsp', 'curry paste'], ['400 g tin', 'chopped tomatoes'], ['400 ml tin', 'coconut milk'], ['2 × 400 g tins', 'chickpeas, drained'], ['100 g', 'spinach'], ['1', 'lime'], ['', 'coriander and rice, to serve']],
    tags: ['quick', 'family'],
  },
  {
    ref: 'salad', title: 'Greek salad', cook: 'sam', picture: 'greek-salad.jpg', servings: 2, prep: 15, cook_minutes: 0, vegetarian: true,
    summary: 'Tomatoes, cucumber, red onion and olives, with a whole slab of feta on top. Nothing to cook.',
    method: 'Cut the tomatoes into wedges and the cucumber into thick half-moons. Slice the onion very thinly.\n\nPut everything in a wide bowl with the olives, season, and pour over the oil and vinegar.\n\nLay the feta on top in one piece, sprinkle with oregano, and bring it to the table.',
    ingredients: [['4', 'ripe tomatoes'], ['½', 'cucumber'], ['½', 'red onion'], ['a handful', 'black olives'], ['200 g', 'feta'], ['3 tbsp', 'olive oil'], ['1 tbsp', 'red wine vinegar'], ['1 tsp', 'dried oregano']],
    tags: ['quick', 'summer'],
  },
  {
    ref: 'brownies', title: 'Chocolate brownies', cook: 'olivia', picture: 'brownies.jpg', servings: 16, prep: 15, cook_minutes: 25, vegetarian: true,
    summary: 'Fudgy in the middle and crisp on top. The trick is taking them out before they look done.',
    method: 'Heat the oven to 180 °C (160 °C fan) and line a 20 cm square tin.\n\nMelt the chocolate and butter together over a low heat. Leave to cool a little.\n\nWhisk the eggs and sugar until thick and pale, then fold in the chocolate, then the flour and cocoa.\n\nBake for 25 minutes. The middle should still wobble a little. Cool completely in the tin before cutting into squares.',
    ingredients: [['185 g', 'dark chocolate'], ['185 g', 'butter'], ['3', 'eggs'], ['275 g', 'caster sugar'], ['85 g', 'plain flour'], ['40 g', 'cocoa powder']],
    tags: ['baking', 'dessert', 'weekend'],
  },
  {
    ref: 'bolognese', title: 'Spaghetti bolognese', cook: 'rose', picture: 'spaghetti-bolognese.jpg', servings: 4, prep: 15, cook_minutes: 90, vegetarian: false,
    summary: 'The family favourite. It only gets better the longer it simmers.',
    method: 'Fry the onion, carrot and celery in the oil for 10 minutes, until soft.\n\nTurn up the heat, add the mince and brown it well, breaking it up as it cooks. Stir in the tomato purée and cook for a minute.\n\nAdd the tomatoes and stock, season, and simmer gently with the lid half on for an hour and a half, stirring now and then.\n\nCook the spaghetti, toss it with the sauce, and serve with plenty of parmesan.',
    ingredients: [['1', 'onion'], ['1', 'carrot'], ['1 stick', 'celery'], ['2 tbsp', 'olive oil'], ['500 g', 'beef mince'], ['2 tbsp', 'tomato purée'], ['2 × 400 g tins', 'chopped tomatoes'], ['200 ml', 'beef stock'], ['400 g', 'spaghetti'], ['', 'parmesan, to serve']],
    tags: ['family', 'weekend'],
  },
];

const COOKS: [string, string, string][] = [
  ['olivia', 'Olivia', 'Bakes on Sundays and is not to be disturbed while she does.'],
  ['sam', 'Sam', 'Likes dinners that are ready before anyone gets hungry.'],
  ['rose', 'Nana Rose', 'The recipes everyone asks for, written down at last.'],
];

const TAGS = ['baking', 'dessert', 'family', 'quick', 'soup', 'summer', 'vegetarian', 'weekend'];

function recipeRows(): SeedRow[] {
  const rows: SeedRow[] = [];
  for (const [ref, name, about] of COOKS) rows.push({ table: 'cooks', ref: `cook:${ref}`, values: { name, about } });
  for (const t of TAGS) rows.push({ table: 'tags', ref: `tag:${t}`, values: { name: t } });
  for (const r of RECIPES) {
    rows.push({
      table: 'recipes', ref: `recipe:${r.ref}`,
      values: {
        title: r.title, summary: r.summary, method: r.method, servings: r.servings,
        prep_minutes: r.prep, cook_minutes: r.cook_minutes, vegetarian: r.vegetarian,
        picture: { picture: r.picture }, cook_id: { ref: `cook:${r.cook}` },
      },
    });
    r.ingredients.forEach(([amount, item], i) => rows.push({
      table: 'ingredients', values: { recipe_id: { ref: `recipe:${r.ref}` }, position: i + 1, amount, item },
    }));
    const tags = r.vegetarian ? [...r.tags, 'vegetarian'] : r.tags;
    for (const t of tags) rows.push({ table: 'recipe_tags', values: { recipe_id: { ref: `recipe:${r.ref}` }, tag_id: { ref: `tag:${t}` } } });
  }
  return rows;
}

// ------------------------------------------------------------------ the blog

function blogTables(): Table[] {
  let s = snapshot('mariadb', 'example_blog', [
    plain('authors', [line('name', 80, { required: true }), col('about', 'text')]),
    table('posts', [
      line('title', 160, { required: true }),
      line('slug', 120, { required: true }),
      col('summary', 'text'),
      col('body', 'text'),
      col('published', 'boolean', { required: true, default: { kind: 'boolean', value: false } }),
      col('published_on', 'date'),
    ], { uniques: [{ name: 'posts_slug_key', columns: ['slug'] }] }),
    plain('topics', [line('name', 60, { required: true })], { uniques: [{ name: 'topics_name_key', columns: ['name'] }] }),
  ]);
  s = addRelationship(s, { from: { table: 'authors', column: 'id' }, to: { table: 'posts' }, kind: 'one-to-many', onDelete: 'restrict' });
  s = addRelationship(s, { from: { table: 'posts', column: 'id' }, to: { table: 'topics' }, kind: 'many-to-many', onDelete: 'cascade' });
  // people can comment on the posts (docs/comments-plan.md C10): the
  // conversations, the comments, and which conversation is each post's
  s = withCommentLink(s, 'posts');
  return s.tables;
}

// `body` is rich text (docs/rich-text-plan.md, Q6): written here as plain
// paragraphs and made into HTML by paras(), plus `extra` -- HTML added after
// them, for the one post that shows a table.
type Post = { slug: string; title: string; author: string; on: string | null; published: boolean; topics: string[]; summary: string; body: string; extra?: string };

// Plain paragraphs as HTML. Only ever given the text in this file, which has
// no < or & in it -- the test that seeds the examples checks the result is
// exactly what the cleaner would keep.
const paras = (text: string): string => text.split('\n\n').map((p) => `<p>${p}</p>`).join('');

const POSTS: Post[] = [
  {
    slug: 'hello', title: 'Hello, and welcome', author: 'pamela', on: '2026-03-02', published: true, topics: ['news'],
    summary: 'Why there is a blog here now, and what will be on it.',
    body: 'For a long time this website was a single page with an address on it. It still has the address, but now it has this too: a place to write things down as they happen.\n\nThere will be news, some gardening, some cooking, and the odd trip. Nothing on a timetable.\n\nIf you would like to hear when something new goes up, the mailing list is the easiest way.',
  },
  {
    slug: 'kitchen-garden', title: 'Starting a kitchen garden', author: 'pamela', on: '2026-03-21', published: true, topics: ['garden', 'kitchen'],
    summary: 'Four raised beds, one very old spade, and a plan that fits on the back of an envelope.',
    body: 'The plan was simple: grow the things we buy most often and throw away most often. That turned out to be herbs, salad leaves and courgettes.\n\nWe built four raised beds out of old scaffolding boards. The soil came from the compost heap, which has been waiting for this moment for years.\n\nThe first seeds went in last weekend. Nothing has come up yet, which is apparently normal.',
    extra: '<h3>What went where</h3><table><tbody>'
      + '<tr><th><p>Bed</p></th><th><p>What is in it</p></th><th><p>Sown</p></th></tr>'
      + '<tr><td><p>1</p></td><td><p>Herbs: basil, parsley, chives</p></td><td><p>14 March</p></td></tr>'
      + '<tr><td><p>2</p></td><td><p>Salad leaves and radishes</p></td><td><p>14 March</p></td></tr>'
      + '<tr><td><p>3</p></td><td><p>Courgettes</p></td><td><p>Not yet: after the last frost</p></td></tr>'
      + '<tr><td><p>4</p></td><td><p>Nothing yet. <strong>Ideas welcome.</strong></p></td><td><p>—</p></td></tr>'
      + '</tbody></table>',
  },
  {
    slug: 'seaside', title: 'A weekend by the sea', author: 'jo', on: '2026-04-11', published: true, topics: ['travel'],
    summary: 'Two days, one rainy, one glorious, and a very good fish supper.',
    body: 'Saturday was grey from start to finish, so we did what you do on a grey day at the seaside: a long walk on the front, a museum, and tea in a café with steamed-up windows.\n\nSunday was the opposite. We walked along the cliffs to the next bay and back, and still had time to sit on the harbour wall and watch the boats come in.\n\nThe fish supper on the way home was the best either of us could remember.',
  },
  {
    slug: 'first-harvest', title: 'The first harvest', author: 'pamela', on: '2026-05-30', published: true, topics: ['garden', 'kitchen'],
    summary: 'Radishes, a handful of salad, and more pride than is strictly reasonable.',
    body: 'Ten weeks after the first seeds, we picked something. Radishes first: small, peppery and very red. Then a colander of salad leaves, which went straight into lunch.\n\nThe courgettes are flowering. Everyone warns you about courgettes. We will see.',
  },
  {
    slug: 'summer-fair', title: 'See you at the summer fair', author: 'jo', on: '2026-06-14', published: true, topics: ['news'],
    summary: 'We will have a stall on the green, with cakes, seedlings and a lemon drizzle raffle.',
    body: 'The summer fair is on the last Saturday of the month, on the green from ten until four.\n\nWe will be there with cakes, spare seedlings from the garden, and a raffle for a whole lemon drizzle loaf.\n\nCome and say hello.',
  },
  {
    slug: 'courgette-glut', title: 'Everyone warned us about the courgettes', author: 'pamela', on: '2026-07-05', published: true, topics: ['garden', 'kitchen'],
    summary: 'Three plants, forty courgettes, and counting.',
    body: 'They were right. Three plants have given us more courgettes in a fortnight than we have eaten in the last five years.\n\nSo far: courgette soup, courgette fritters, a courgette cake that nobody guessed, and a great many courgettes given to the neighbours.\n\nIf you have a recipe, the comments are open.',
  },
  {
    slug: 'lemon-drizzle', title: 'The lemon drizzle loaf, at last', author: 'pamela', on: '2026-07-19', published: true, topics: ['kitchen', 'family'],
    summary: 'The raffle prize from the summer fair, written down for everyone who asked.',
    body: 'Half the people at the fair asked for the recipe, and the other half asked when the next one would be.\n\nThe secret is not much of a secret: pour the lemon syrup over while the loaf is still hot, and leave it in the tin until it is completely cold.\n\nThe whole recipe is in the recipe book.',
  },
  {
    slug: 'coast-path', title: 'Walking the coast path', author: 'jo', on: '2026-08-02', published: true, topics: ['travel'],
    summary: 'Twelve miles, two ferries and one very welcome pub.',
    body: 'We set off early, before the day got hot, and had the path almost to ourselves until lunchtime.\n\nThe two ferries were the best part: small boats, a bell to ring for the ferryman, and five minutes to sit down.\n\nNext time we will take more water and fewer sandwiches.',
  },
  {
    slug: 'jam-season', title: 'Jam season', author: 'pamela', on: '2026-08-16', published: true, topics: ['kitchen'],
    summary: 'Strawberry, gooseberry, and an experiment with plums that we will not repeat.',
    body: 'Every jar in the house is full, and so is every shelf.\n\nThe strawberry set beautifully, the gooseberry is sharp enough to make you blink, and the plum is best described as a sauce.\n\nLabels next year, so we know which is which.',
  },
  {
    slug: 'family-picnic', title: 'The family picnic', author: 'jo', on: '2026-08-30', published: true, topics: ['family', 'news'],
    summary: 'Four generations, one very large blanket, and no rain at all.',
    body: 'Everyone came, from the youngest at four months to the eldest at ninety-one.\n\nThere were far too many sandwiches, the cricket was fiercely contested, and the dog found the sausage rolls before anyone else did.\n\nSame time next year, the same blanket.',
  },
  {
    slug: 'seed-swap', title: 'A seed swap on the green', author: 'pamela', on: '2026-09-06', published: true, topics: ['garden', 'news'],
    summary: 'Bring what you have too much of, take what you have not tried.',
    body: 'The first seed swap on the green is on the second Saturday of October, from ten until twelve.\n\nBring seeds in paper envelopes, labelled if you can, and take home something you have never grown before.\n\nThere will be tea, and probably courgettes.',
  },
  {
    slug: 'rainy-weekend', title: 'A rainy weekend indoors', author: 'jo', on: '2026-09-13', published: true, topics: ['family'],
    summary: 'Board games, a jigsaw with three pieces missing, and a lot of soup.',
    body: 'It rained from Friday night until Monday morning without stopping once.\n\nWe finished a thousand-piece jigsaw, except for the three pieces the dog has, and learned that nobody in this family can lose at cards gracefully.\n\nThe soup was excellent.',
  },
  {
    slug: 'first-frost', title: 'The first frost', author: 'pamela', on: '2026-09-20', published: true, topics: ['garden'],
    summary: 'The end of the courgettes, and the start of the planning.',
    body: 'A white lawn this morning, and the courgette plants have finally given up.\n\nNow comes the best part of the gardening year: sitting indoors with the seed catalogues, planning what to grow next spring.\n\nFewer courgettes. Definitely fewer courgettes.',
  },
  {
    slug: 'autumn-plans', title: 'Plans for the autumn', author: 'pamela', on: null, published: false, topics: ['garden'],
    summary: 'Not finished yet -- so this one is not on the blog. It is here to show what "published" does.',
    body: 'Garlic, broad beans, and a new bed for the strawberries. More to follow when it is written.',
  },
];

const AUTHORS: [string, string, string][] = [
  ['pamela', 'Pamela', 'Writes most of what is here, usually from the garden.'],
  ['jo', 'Jo', 'Writes about everywhere that is not the garden.'],
];

const TOPICS = ['garden', 'kitchen', 'news', 'travel', 'family'];

function blogRows(): SeedRow[] {
  const rows: SeedRow[] = [];
  for (const [ref, name, about] of AUTHORS) rows.push({ table: 'authors', ref: `author:${ref}`, values: { name, about } });
  for (const t of TOPICS) rows.push({ table: 'topics', ref: `topic:${t}`, values: { name: t } });
  for (const p of POSTS) {
    rows.push({
      table: 'posts', ref: `post:${p.slug}`,
      values: {
        title: p.title, slug: p.slug, summary: p.summary, body: paras(p.body) + (p.extra ?? ''), published: p.published,
        published_on: p.on, author_id: { ref: `author:${p.author}` },
      },
    });
    for (const t of p.topics) rows.push({ table: 'post_topics', values: { post_id: { ref: `post:${p.slug}` }, topic_id: { ref: `topic:${t}` } } });
  }
  return rows;
}

// Sample comments (docs/comments-plan.md): a few posts have a conversation,
// most have none -- so the example shows each post with its own comments,
// and shows that a page with nothing said stays empty.
const COMMENTS: { post: string; author: string; body: string; daysAfter: number }[] = [
  { post: 'kitchen-garden', author: 'Sam', body: 'Scaffolding boards are a brilliant idea. How deep did you make the beds?', daysAfter: 1 },
  { post: 'kitchen-garden', author: 'Pamela', body: 'About a foot deep, Sam, which seems to be plenty for salad.', daysAfter: 2 },
  { post: 'kitchen-garden', author: 'Olivia', body: 'Good luck with the courgettes!', daysAfter: 5 },
  { post: 'first-harvest', author: 'Rose', body: 'Nothing tastes as good as the first radish.', daysAfter: 1 },
  { post: 'first-harvest', author: 'Sam', body: 'Ours were all leaf and no radish. What did you do differently?', daysAfter: 3 },
  { post: 'summer-fair', author: 'Dilip', body: 'I won the raffle last year. The loaf did not last the afternoon.', daysAfter: 2 },
  { post: 'courgette-glut', author: 'Auntie Jo', body: 'Grate them into a chocolate cake. Nobody will ever know.', daysAfter: 1 },
];

// ------------------------------------------------------------------ the two, as the panel uses them

const hidden: FieldPatch = { showInList: false };

export const DB_EXAMPLES: Record<DbExampleKind, DbExample> = {
  recipes: {
    kind: 'recipes',
    engine: 'postgres',
    database: 'example_recipes',
    title: 'Recipe book (example)',
    heading: 'Recipe book',
    about: 'Recipes with their cooks, ingredients and tags. The public page is a recipe book anyone can browse: search, pick a tag, open a recipe.',
    suggested: { name: 'recipes', title: 'Recipe book', pageName: 'recipes.html' },
    tables: recipeTables(),
    resources: {
      recipes: {
        patch: {
          enabled: true, singular: 'Recipe', plural: 'Recipes', titleField: 'title', sortField: 'title', sortDir: 'asc',
          description: 'Everything in the recipe book.', publicRead: true, can: { filter: true },
        },
        fields: {
          summary: { searchable: true, help: 'A line or two, shown under the title.' },
          method: { ...hidden, help: 'Leave a blank line between steps.' },
          vegetarian: { filterable: true },
          cook_id: { filterable: true },
          picture: { ...hidden, label: 'Picture', help: 'The address of a picture, like pictures/pancakes.jpg or https://…' },
          prep_minutes: { ...hidden, label: 'Minutes to prepare' },
          cook_minutes: { ...hidden, label: 'Minutes to cook' },
          created_at: hidden, updated_at: hidden,
        },
        // docs/field-order-plan.md O9: the form reads the way a recipe does
        order: ['title', 'summary', 'cook_id', 'many:tags', 'servings', 'prep_minutes', 'cook_minutes', 'vegetarian', 'method', 'picture'],
      },
      cooks: { patch: { enabled: true, singular: 'Cook', plural: 'Cooks', titleField: 'name', sortField: 'name', publicRead: true } },
      ingredients: {
        patch: { enabled: true, singular: 'Ingredient', plural: 'Ingredients', titleField: 'item', sortField: 'position', publicRead: true, can: { filter: true } },
        fields: { recipe_id: { filterable: true }, position: { label: 'Order' } },
      },
      tags: { patch: { enabled: true, singular: 'Tag', plural: 'Tags', titleField: 'name', sortField: 'name', publicRead: true } },
    },
    rows: recipeRows(),
    pictures: RECIPES.map((r) => r.picture),
  },
  blog: {
    kind: 'blog',
    engine: 'mariadb',
    database: 'example_blog',
    title: 'Blog (example)',
    heading: 'Blog',
    about: 'Posts with their authors and topics, and a tick for "published". The public page shows the newest published posts first, with a page for each.',
    suggested: { name: 'blog', title: 'Blog', pageName: 'blog.html' },
    tables: blogTables(),
    resources: {
      posts: {
        patch: {
          enabled: true, singular: 'Post', plural: 'Posts', titleField: 'title', sortField: 'published_on', sortDir: 'desc',
          description: 'Only published posts are on the public page.', publicRead: true, publicOnly: 'published', can: { filter: true },
        },
        fields: {
          slug: { label: 'Address', help: 'The end of the post\'s address: lowercase words joined with hyphens, like first-harvest.' },
          summary: { searchable: true },
          body: { ...hidden, control: 'rich', help: 'The post itself. Use the toolbar for headings, lists, links and tables.' },
          published: { filterable: true, help: 'Only published posts are on the public page.' },
          author_id: { filterable: true },
          created_at: hidden, updated_at: hidden,
        },
        // O9: title first -- before this, the settings above put Author above it
        order: ['title', 'slug', 'author_id', 'summary', 'body', 'many:topics', 'published', 'published_on'],
      },
      authors: { patch: { enabled: true, singular: 'Author', plural: 'Authors', titleField: 'name', sortField: 'name', publicRead: true } },
      topics: { patch: { enabled: true, singular: 'Topic', plural: 'Topics', titleField: 'name', sortField: 'name', publicRead: true } },
      // the approved comments are kept here too (docs/comments-plan.md C8-C10);
      // the page reads them from the comment area, not from these tables
      ...COMMENT_RESOURCES,
      post_comment_threads: linkResource('posts'),
    },
    rows: blogRows(),
    pictures: [],
    comments: {
      area: { name: 'example-blog-comments', fixture: 'blog-comments', title: 'Blog comments (example)', contentType: 'posts' },
      items: COMMENTS,
    },
  },
};

// The tables, as a snapshot of the database they go into -- the example's own,
// or hers (X3).
export const exampleSnapshot = (ex: Pick<DbExample, 'tables'>, engine: Engine, database: string): Snapshot =>
  ({ engine, database, tables: structuredClone(ex.tables), notes: [] });

// Put the sample rows in, one at a time and in order, each reference filled in
// from the id the engine gave back (X4). `insert` is the database helper's
// insert-row; `pictures` is where the pictures sit relative to the page.
export async function seedExample(
  // a database example, or a tutorial example (src/studio/tutorial-examples.ts)
  ex: { kind: string; rows: SeedRow[] }, pictures: string,
  insert: (table: string, values: Record<string, Scalar>) => Promise<Scalar>,
  // filled in with the id each named row was given ("post:kitchen-garden" ->
  // 4), so the sample comments can say which post they are on
  ids: Map<string, Scalar> = new Map(),
): Promise<number> {
  let n = 0;
  for (const row of ex.rows) {
    const values: Record<string, Scalar> = {};
    for (const [k, v] of Object.entries(row.values)) {
      if (v !== null && typeof v === 'object' && 'ref' in v) {
        if (!ids.has(v.ref)) throw new Error(`example ${ex.kind}: ${v.ref} is used before it is made`);
        values[k] = ids.get(v.ref)!;
      } else if (v !== null && typeof v === 'object' && 'picture' in v) {
        values[k] = `${pictures}${v.picture}`;
      } else {
        values[k] = v;
      }
    }
    const id = await insert(row.table, values);
    if (row.ref) ids.set(row.ref, id);
    n++;
  }
  return n;
}

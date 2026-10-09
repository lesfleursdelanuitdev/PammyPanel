// "What would you like to do?" (docs/getting-started-plan.md G2): the questions,
// one at a time, and the recommendation they end in. Pure: no database, no
// clock. The page asks the server for the next question with what she has
// answered so far, so the whole tree lives here and one test can walk all of it.
//
// Her own projects come first (D6): a blog, a pinboard, a recipe book.

export type Answers = Record<string, string>;
export type Option = { value: string; label: string; hint?: string };
export type Question = { key: string; text: string; hint?: string; options: Option[] };

export type PathKey =
  | 'blog' | 'pinboard' | 'recipes' | 'contact' | 'rsvp' | 'guestbook' | 'private' | 'media' | 'lists'
  | 'form' | 'database' | 'database-form' | 'database-signin' | 'comments';

const yesNo = (yes: string, no: string): Option[] => [{ value: 'yes', label: yes }, { value: 'no', label: no }];

export const GOAL: Question = {
  key: 'goal',
  text: 'What would you like to do?',
  hint: 'Pick the closest. You can start something else afterwards, as often as you like.',
  options: [
    { value: 'blog', label: 'Start a blog', hint: 'Posts you write, with topics, and comments if you like' },
    { value: 'pinboard', label: 'Put up a pinboard', hint: 'Visitors pin short notes, you choose which go up' },
    { value: 'recipes', label: 'Keep a recipe book', hint: 'Recipes, cooks, ingredients and tags, with photos' },
    { value: 'contact', label: 'Let people contact me', hint: 'A message box on a page' },
    { value: 'rsvp', label: "Find out who's coming to something", hint: 'Yes, no or maybe, and how many' },
    { value: 'guestbook', label: 'Have a guest book', hint: 'Visitors leave a few kind words' },
    { value: 'private', label: 'Keep a page or folder private', hint: 'Only the people you choose can open it' },
    { value: 'media', label: 'Put photos, music or documents on my site', hint: 'Galleries, players, lists of files' },
    { value: 'lists', label: 'Let people keep their own list', hint: 'Like a to-do list, one for each person' },
    { value: 'not-sure', label: "Something else, or I'm not sure", hint: 'A few questions to work it out together' },
  ],
};

// Only where the answer changes the path.
const FOLLOW_UPS: Record<string, Question[]> = {
  blog: [{ key: 'comments', text: 'Should readers be able to comment on your posts?', hint: 'Every comment waits for your OK before anyone sees it.',
    options: yesNo('Yes, let them comment', 'No, just the posts') }],
  pinboard: [
    { key: 'who', text: 'Who may pin notes?', options: [
      { value: 'anyone', label: 'Anyone who finds the page' },
      { value: 'people', label: 'Only people I know', hint: 'The page goes in a protected folder' }] },
    { key: 'when', text: 'Should notes go up at once, or after you have read them?', options: [
      { value: 'after', label: 'After I have read them', hint: 'Safest for a public page' },
      { value: 'now', label: 'At once', hint: 'For a board only friends use; you can still take one down' }] },
  ],
  recipes: [{ key: 'friends', text: 'Should friends be able to send you their recipes?', hint: 'They fill in a form; a recipe only goes in your book when you approve it.',
    options: yesNo('Yes, let them send recipes', 'No, just me') }],
  rsvp: [{ key: 'who', text: 'Who is it for?', options: [
    { value: 'anyone', label: 'Anyone who has the address' },
    { value: 'people', label: 'Only people I know', hint: 'The page goes in a protected folder' }] }],
  guestbook: [{ key: 'when', text: 'Should new entries show at once, or after you have read them?', options: [
    { value: 'after', label: 'After I have read them' },
    { value: 'now', label: 'At once', hint: 'You can still take one down' }] }],
  media: [{ key: 'media', text: 'What would you like to put up?', options: [
    { value: 'images', label: 'Photos and pictures' },
    { value: 'audio', label: 'Music or recordings' },
    { value: 'documents', label: 'Documents (PDFs and the like)' }] }],
  lists: [{ key: 'code', text: 'How would you like to build the page?', hint: 'Both make the same list; pick the one you would rather read.', options: [
    { value: 'js', label: 'HTML and JavaScript' },
    { value: 'php', label: 'PHP' }] }],
  // guide 19's questions, as choices
  'not-sure': [
    { key: 'writes', text: 'Who writes it?', options: [
      { value: 'visitors', label: 'Visitors send it, and that is that', hint: 'A message, a note, an answer' },
      { value: 'me', label: 'I write it, and keep working on it', hint: 'Posts, a list of events, a collection' },
      { value: 'suggest', label: 'Visitors suggest things, and I choose what goes in' },
      { value: 'own', label: 'People I know each keep their own' },
      { value: 'comment', label: 'Visitors comment on my pages or posts' }] },
  ],
};
const LATER: Question = {
  key: 'later', text: 'Once it has arrived, will you want to change it, sort it your way, tag it, or connect it to other things?',
  options: yesNo('Yes', 'No, reading it (and maybe showing it) is enough'),
};

const followUpsFor = (a: Answers): Question[] => {
  const qs = FOLLOW_UPS[a.goal ?? ''] ?? [];
  return a.goal === 'not-sure' && a.writes === 'visitors' ? [...qs, LATER] : qs;
};
const valid = (q: Question, v: string | undefined) => v !== undefined && q.options.some((o) => o.value === v);

// The next question, or null when the answers are enough for a recommendation.
// Answers that don't belong (or aren't one of the choices) are asked again.
export function nextQuestion(a: Answers): Question | null {
  if (!valid(GOAL, a.goal)) return GOAL;
  for (const q of followUpsFor(a)) if (!valid(q, a[q.key])) return q;
  return null;
}

// Only the answers the questions asked, so nothing else is ever stored.
export function cleanAnswers(a: Answers): Answers {
  const out: Answers = {};
  if (valid(GOAL, a.goal)) out.goal = a.goal!;
  for (const q of followUpsFor(out.goal ? { ...a, goal: out.goal } : {})) if (valid(q, a[q.key])) out[q.key] = a[q.key]!;
  return out;
}

// Which path the answers lead to, and why, in her words.
export function recommend(a: Answers): { path: PathKey; why: string } {
  switch (a.goal) {
    case 'blog': return { path: 'blog', why: 'Posts are yours: you write them, come back to fix them and give them topics, and a form can\'t change what it was sent.' };
    case 'pinboard': return { path: 'pinboard', why: 'Each note is sent once by a visitor and never changed, and you choose which go up: that is exactly what a form does.' };
    case 'recipes': return { path: 'recipes', why: a.friends === 'yes'
      ? 'A recipe book is several kinds of thing that belong together, which needs a database; your friends\' recipes come in through a form and go in when you approve them.'
      : 'A recipe book is several kinds of thing that belong together (recipes, cooks, ingredients, tags) that you will add to for years: that is a database.' };
    case 'contact': return { path: 'contact', why: 'A message is sent once and read by you: a form, and nothing more.' };
    case 'rsvp': return { path: 'rsvp', why: 'Each answer is sent once, and a page can show who is coming: a form.' };
    case 'guestbook': return { path: 'guestbook', why: 'A few kind words, sent once, shown once you are happy with them: a form.' };
    case 'private': return { path: 'private', why: 'A protected folder keeps a page, or a whole folder, behind a sign-in page only the people you choose can pass.' };
    case 'media': return { path: 'media', why: 'Media folders keep your files, and a page of yours can show them as a gallery, a player or a list.' };
    case 'lists': return { path: 'lists', why: 'Each person keeps their own records and changes them later: a database, which people signed in to a protected folder may change.' };
    default: break;
  }
  switch (a.writes) {
    case 'visitors': return a.later === 'yes'
      ? { path: 'database-form', why: 'Visitors send it, but you want to work on it afterwards, and a form can\'t change what it was sent: a form that saves into a database.' }
      : { path: 'form', why: 'Visitors send it once, and reading it (and maybe showing it) is enough: a form.' };
    case 'me': return { path: 'database', why: 'You write it and keep working on it: a database, with pages for adding and changing it.' };
    case 'suggest': return { path: 'database-form', why: 'Visitors suggest, you choose: a database for your collection, with a form that saves into it when you approve.' };
    case 'own': return { path: 'database-signin', why: 'Each person keeps their own and changes it later: a database, which people signed in to a protected folder may change.' };
    default: return { path: 'comments', why: 'Comments on your pages: a comment area, where every comment waits for your OK.' };
  }
}

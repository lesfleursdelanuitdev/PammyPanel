// journal.js -- the parts both pages share.

// Where your journal's posts are: the address under "Where
// programs ask", without the https://pammy.org at the front.
const POSTS = '/_pammy/api/data/postgres/journal/posts';

// Asks for posts, and gives back the answer. If the answer is
// "no", it stops with the reason pammy.org gave.
async function ask(path) {
  const answer = await fetch(POSTS + path);
  const body = await answer.json();
  if (!answer.ok) {
    throw new Error(body.message);
  }
  return body;
}

// "2026-03-21" -> "21 March 2026"
function niceDate(value) {
  if (!value) {
    return '';
  }
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
}

// "By Pamela · 21 March 2026"
function byline(post) {
  const parts = [];
  if (post.author) {
    parts.push('By ' + post.author.label);
  }
  if (post.published_on) {
    parts.push(niceDate(post.published_on));
  }
  return parts.join(' · ');
}

// "Garden · Kitchen"
function topicsOf(post) {
  return (post.topics || []).map((topic) => topic.label).join(' · ');
}

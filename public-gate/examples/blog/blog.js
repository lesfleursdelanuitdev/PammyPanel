// Example: Blog (14-databases-in-the-control-panel.txt, PART 16).
// Reads the blog database through the data API -- no key, because its tables
// are set to "Anyone can read these", and posts only where "published" is yes,
// so a post she is still writing is not there for anyone. Shows the newest
// posts first, a button for each topic, and one post at a time when its title
// is clicked. The address ends in #post-first-harvest while one is open.
//
// A post's writing is rich text: headings, lists, links and tables. The data
// API lists the fields that are rich text in `rich`, and only those are put on
// the page as HTML (innerHTML) -- they are cleaned by pammy.org on the way in
// AND on the way out, so a script or a trick link cannot be in them, whoever
// wrote the post. Every other field goes on the page as words (textContent),
// which is always safe. If the body is ever switched back to plain writing,
// it is shown as plain paragraphs again -- a blank line starts a new one.
//
// Comments (20-comments.txt): an opened post gets <pammy-comments> with
// the post's id as its content-id, so each post is its own conversation; the
// list shows how many each post has, asked for all at once (one request for
// a whole page of posts). The comment area's name is in data-comments.
(function () {
  var blog = document.querySelector('.blog');
  if (!blog) return;
  var api = blog.getAttribute('data-api');
  var commentArea = blog.getAttribute('data-comments') || '';
  var all = blog.querySelector('.all');
  var list = blog.querySelector('.posts');
  var more = blog.querySelector('.more');
  var topicsBox = blog.querySelector('.topics');
  var one = blog.querySelector('.post');

  var PER = 20;
  var posts = [];       // every post shown so far, newest first
  var page = 0;         // the last page asked for
  var total = 0;
  var showing = '';     // the topic picked, or '' for every post
  var rich = [];        // the fields of a POST the API says are rich text (safe as HTML)

  function ask(path) {
    return fetch(api + path).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error(body.message || 'The blog could not be read just now.');
        // each table has its own: only the posts' answer says which of a
        // post's fields are rich text (the topics' answer is about topics)
        if (path.indexOf('/posts') === 0 && body.rich) rich = body.rich;
        return body;
      });
    });
  }

  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  // "2026-03-21" -> "21 March 2026", in the visitor's own way of writing dates
  function day(value) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
    if (!m) return '';
    return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  }

  function byline(post) {
    return [post.author ? 'By ' + post.author.label : '', day(post.published_on)].filter(Boolean).join(' · ');
  }

  // ------------------------------------------------------------ the list

  function nextPage() {
    page += 1;
    return ask('/posts?sort=published_on&dir=desc&per=' + PER + '&page=' + page).then(function (body) {
      posts = posts.concat(body.items);
      total = body.total;
      more.hidden = posts.length >= total;
    });
  }

  function drawList() {
    var chosen = posts.filter(function (p) {
      return !showing || (p.topics || []).some(function (t) { return t.label === showing; });
    });
    list.textContent = '';
    if (!chosen.length) list.appendChild(el('li', 'note', posts.length ? 'Nothing about that yet.' : 'No posts yet.'));
    chosen.forEach(function (p) {
      var li = el('li', 'item');
      var h = el('h2');
      var a = el('a', null, p.title);
      a.href = '#post-' + encodeURIComponent(p.slug);
      h.appendChild(a);
      li.appendChild(h);
      li.appendChild(el('p', 'byline', byline(p)));
      if (p.summary) li.appendChild(el('p', 'summary', p.summary));
      var tags = (p.topics || []).map(function (t) { return t.label; }).join(' · ');
      if (tags) li.appendChild(el('p', 'topics-here', tags));
      if (commentArea) {
        var n = el('p', 'comment-count');
        n.setAttribute('data-post', String(p.id));
        li.appendChild(n);
      }
      list.appendChild(li);
    });
    countComments(chosen);
  }

  // How many approved comments each post has: one request for the lot.
  function countComments(shown) {
    if (!commentArea || !shown.length) return;
    var q = new URLSearchParams({ page: location.pathname, content: shown.map(function (p) { return p.id; }).join(',') });
    fetch('/_pammy/comments/' + encodeURIComponent(commentArea) + '/counts?' + q, { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : { counts: {} }; })
      .then(function (body) {
        list.querySelectorAll('.comment-count').forEach(function (p) {
          var n = body.counts[p.getAttribute('data-post')] || 0;
          p.textContent = n === 0 ? '' : n === 1 ? '1 comment' : n + ' comments';
        });
      })
      .catch(function () { /* the list is fine without the numbers */ });
  }

  function drawTopics(topics) {
    topicsBox.textContent = '';
    [''].concat(topics.map(function (t) { return t.name; })).forEach(function (name) {
      var b = el('button', 'topic', name || 'Everything');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(name === showing));
      b.addEventListener('click', function () {
        showing = name;
        drawTopics(topics);
        drawList();
      });
      topicsBox.appendChild(b);
    });
  }

  // ------------------------------------------------------------ one post

  function draw(post) {
    all.hidden = true;
    one.hidden = false;
    one.querySelector('.title').textContent = post.title;
    one.querySelector('.byline').textContent = byline(post);
    one.querySelector('.topics-here').textContent = (post.topics || []).map(function (t) { return t.label; }).join(' · ');
    var body = one.querySelector('.body');
    body.textContent = '';
    if (rich.indexOf('body') !== -1) {
      // rich text: cleaned by pammy.org, so safe to show as HTML (see the top)
      body.innerHTML = post.body || '';
    } else {
      (post.body || '').split(/\n\s*\n/).forEach(function (para) {
        if (para.trim()) body.appendChild(el('p', null, para.trim()));
      });
    }
    // this post's conversation, and no other
    var comments = one.querySelector('.comments');
    comments.textContent = '';
    if (commentArea) {
      var c = document.createElement('pammy-comments');
      c.setAttribute('name', commentArea);
      c.setAttribute('content-id', String(post.id));
      c.setAttribute('order', 'oldest');
      comments.appendChild(c);
    }
    document.title = post.title;
    window.scrollTo(0, 0);
  }

  function open(slug) {
    var known = posts.filter(function (p) { return p.slug === slug; })[0];
    if (known) return draw(known);
    // a link straight to an older post: ask for that one by its address
    ask('/posts?where.slug=' + encodeURIComponent(slug)).then(function (body) {
      if (body.items[0]) draw(body.items[0]);
      else location.hash = '';
    }).catch(function () { location.hash = ''; });
  }

  function route() {
    var m = /^#post-(.+)$/.exec(location.hash);
    if (m) return open(decodeURIComponent(m[1]));
    one.hidden = true;
    all.hidden = false;
    document.title = blog.ownerDocument.querySelector('h1').textContent;
  }

  // ------------------------------------------------------------ start

  more.querySelector('button').addEventListener('click', function () { nextPage().then(drawList); });
  window.addEventListener('hashchange', route);

  Promise.all([nextPage(), ask('/topics?sort=name&per=100')]).then(function (got) {
    drawTopics(got[1].items);
    drawList();
    route();
  }).catch(function (e) {
    list.textContent = '';
    list.appendChild(el('li', 'note', e.message));
  });
})();

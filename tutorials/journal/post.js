// post.js -- shows the post named in the address, like
// post.html?id=3

async function showPost() {
  const id = new URLSearchParams(location.search).get('id');
  const answer = await ask('/' + encodeURIComponent(id));
  const post = answer.item;

  document.title = post.title;
  document.getElementById('title').textContent = post.title;
  document.getElementById('about').textContent = byline(post);
  document.getElementById('topics').textContent = topicsOf(post);

  // The writing is rich text, so it is HTML. pammy.org cleaned it,
  // so it is safe to put on the page as HTML. Everything else goes
  // on as words (textContent), which is always safe.
  const writing = document.getElementById('writing');
  if (answer.rich.includes('body')) {
    writing.innerHTML = post.body || '';
  } else {
    writing.textContent = post.body || '';
  }

  // This post's comments, and a box to write one: the comment area
  // journal-comments, with the post's id saying which conversation.
  const comments = document.createElement('pammy-comments');
  comments.setAttribute('name', 'journal-comments');
  comments.setAttribute('content-id', String(post.id));
  comments.setAttribute('order', 'oldest');
  document.getElementById('comments').append(comments);
}

showPost().catch((problem) => {
  document.getElementById('title').textContent = 'Not here';
  document.getElementById('writing').textContent = problem.message;
});

// list.js -- puts the newest posts on index.html.

async function showPosts() {
  const list = document.getElementById('posts');
  const answer = await ask('?sort=published_on&dir=desc&per=20');
  list.textContent = '';

  if (answer.items.length === 0) {
    const empty = document.createElement('li');
    empty.textContent = 'Nothing here yet.';
    list.append(empty);
  }

  for (const post of answer.items) {
    const link = document.createElement('a');
    link.href = 'post.html?id=' + post.id;
    link.textContent = post.title;

    const heading = document.createElement('h2');
    heading.append(link);

    const about = document.createElement('p');
    about.className = 'about';
    about.textContent = byline(post);

    const item = document.createElement('li');
    item.append(heading, about);
    list.append(item);
  }
}

showPosts().catch((problem) => {
  document.getElementById('posts').textContent = problem.message;
});

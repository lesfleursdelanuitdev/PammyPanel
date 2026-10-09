// Example: Recipe book (14-databases-in-the-control-panel.txt, PART 16).
// Reads the recipe book database through the data API -- no key, because its
// tables are set to "Anyone can read these" -- and draws it: cards for every
// recipe, a search box, a button for each tag, and one recipe at a time when
// its card is clicked. The address ends in #recipe-12 while one is open, so a
// recipe can be linked to, and the browser's Back button works.
//
// Everything that comes from the database is put on the page as text, never
// as HTML, so nothing typed into a recipe can change the page itself.
(function () {
  var book = document.querySelector('.book');
  if (!book) return;
  var api = book.getAttribute('data-api');
  var all = book.querySelector('.all');
  var cards = book.querySelector('.cards');
  var tagsBox = book.querySelector('.tags');
  var find = book.querySelector('#find-text');
  var one = book.querySelector('.recipe');

  var recipes = [];     // every recipe, with its cook and tags (the API adds them)
  var showing = '';     // the tag picked, or '' for every recipe

  // One request to the data API. Its answer is JSON; a refusal says why.
  function ask(path) {
    return fetch(api + path).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error(body.message || 'The recipes could not be read just now.');
        return body;
      });
    });
  }

  // Every recipe, a hundred at a time (the most the API gives in one go).
  function everyRecipe(page, so_far) {
    return ask('/recipes?sort=title&per=100&page=' + page).then(function (body) {
      so_far = so_far.concat(body.items);
      return so_far.length < body.total ? everyRecipe(page + 1, so_far) : so_far;
    });
  }

  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  // A picture from the database, or the recipe's first letter on a coloured square.
  function picture(recipe) {
    var box = el('div', 'pic');
    if (recipe.picture) {
      var img = el('img');
      img.src = recipe.picture;
      img.alt = '';
      img.loading = 'lazy';
      box.appendChild(img);
    } else {
      box.classList.add('blank');
      box.textContent = (recipe.title || '?').charAt(0);
    }
    return box;
  }

  function minutes(recipe) {
    var total = (recipe.prep_minutes || 0) + (recipe.cook_minutes || 0);
    if (!total) return '';
    return total < 60 ? total + ' min' : Math.floor(total / 60) + ' h' + (total % 60 ? ' ' + (total % 60) + ' min' : '');
  }

  // ------------------------------------------------------------ the cards

  function drawCards() {
    var words = find.value.trim().toLowerCase();
    var chosen = recipes.filter(function (r) {
      var inTag = !showing || (r.tags || []).some(function (t) { return t.label === showing; });
      var said = !words || ((r.title || '') + ' ' + (r.summary || '')).toLowerCase().indexOf(words) >= 0;
      return inTag && said;
    });
    cards.textContent = '';
    if (!chosen.length) {
      cards.appendChild(el('li', 'note', recipes.length ? 'No recipes match that.' : 'No recipes yet.'));
      return;
    }
    chosen.forEach(function (r) {
      var li = el('li', 'card');
      var a = el('a');
      a.href = '#recipe-' + r.id;
      a.appendChild(picture(r));
      var words = el('div', 'words');
      words.appendChild(el('h2', null, r.title));
      var about = [r.cook ? r.cook.label : '', minutes(r)].filter(Boolean).join(' · ');
      if (about) words.appendChild(el('p', 'about', about));
      if (r.summary) words.appendChild(el('p', 'summary', r.summary));
      a.appendChild(words);
      li.appendChild(a);
      cards.appendChild(li);
    });
  }

  function drawTags(tags) {
    tagsBox.textContent = '';
    [''].concat(tags.map(function (t) { return t.name; })).forEach(function (name) {
      var b = el('button', 'tag', name || 'Everything');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(name === showing));
      b.addEventListener('click', function () {
        showing = name;
        drawTags(tags);
        drawCards();
      });
      tagsBox.appendChild(b);
    });
  }

  // ------------------------------------------------------------ one recipe

  function open(id) {
    var recipe = recipes.filter(function (r) { return String(r.id) === id; })[0];
    if (!recipe) { location.hash = ''; return; }
    all.hidden = true;
    one.hidden = false;
    var pic = one.querySelector('.picture');
    pic.textContent = '';
    pic.appendChild(picture(recipe));
    one.querySelector('.title').textContent = recipe.title;
    one.querySelector('.summary').textContent = recipe.summary || '';
    one.querySelector('.facts').textContent = [
      recipe.cook ? 'From ' + recipe.cook.label : '',
      recipe.servings ? 'Serves ' + recipe.servings : '',
      minutes(recipe),
    ].filter(Boolean).join(' · ');
    one.querySelector('.tags-here').textContent = (recipe.tags || []).map(function (t) { return t.label; }).join(' · ');

    // the method: a blank line in the database starts a new step
    var method = one.querySelector('.method');
    method.textContent = '';
    (recipe.method || '').split(/\n\s*\n/).forEach(function (step) {
      if (step.trim()) method.appendChild(el('li', null, step.trim()));
    });

    // the ingredients are their own table: the ones whose recipe is this one
    var list = one.querySelector('.ingredients');
    list.textContent = '';
    list.appendChild(el('li', 'note', 'Loading…'));
    ask('/ingredients?where.recipe_id=' + encodeURIComponent(recipe.id) + '&sort=position&per=100').then(function (body) {
      list.textContent = '';
      body.items.forEach(function (i) {
        var li = el('li');
        if (i.amount) li.appendChild(el('strong', null, i.amount + ' '));
        li.appendChild(document.createTextNode(i.item));
        list.appendChild(li);
      });
      if (!body.items.length) list.appendChild(el('li', 'note', 'Nothing written down yet.'));
    }).catch(function (e) { list.textContent = e.message; });
    window.scrollTo(0, 0);
  }

  function route() {
    var m = /^#recipe-(.+)$/.exec(location.hash);
    if (m) return open(decodeURIComponent(m[1]));
    one.hidden = true;
    all.hidden = false;
  }

  // ------------------------------------------------------------ start

  find.addEventListener('input', drawCards);
  book.querySelector('.find').addEventListener('submit', function (e) { e.preventDefault(); });
  window.addEventListener('hashchange', route);

  Promise.all([everyRecipe(1, []), ask('/tags?sort=name&per=100')]).then(function (got) {
    recipes = got[0];
    drawTags(got[1].items);
    drawCards();
    route();
  }).catch(function (e) {
    cards.textContent = '';
    cards.appendChild(el('li', 'note', e.message));
  });
})();

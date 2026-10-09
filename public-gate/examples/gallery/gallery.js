// Example: Gallery (12-media-on-your-pages.txt).
// Asks the media API for the pictures in data-api, shows their small versions
// in a grid, and opens one big when clicked: arrows (or the keyboard's left and
// right, or a swipe on a phone) go through them; Escape closes it.
(function () {
  var list = document.querySelector('.gallery');
  var more = document.querySelector('.more');
  var box = document.querySelector('.lightbox');
  if (!list || !box) return;
  var api = list.getAttribute('data-api');
  var pictures = [];            // everything shown so far
  var next = 0;                 // where the next "Show more" starts
  var at = 0;                   // the one open in the big view

  function load() {
    var sep = api.indexOf('?') < 0 ? '?' : '&';
    fetch(api + sep + 'limit=24&offset=' + next)
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function (data) {
        data.files.forEach(add);
        next = data.next;
        more.hidden = next === null;
        if (pictures.length === 0) empty(list.getAttribute('data-empty'));
      })
      .catch(function () { empty('The pictures could not be loaded just now.'); });
  }

  function empty(text) {
    var li = document.createElement('li');
    li.className = 'empty';
    li.textContent = text;
    list.appendChild(li);
  }

  function add(file) {
    var n = pictures.push(file) - 1;
    var li = document.createElement('li');
    var figure = document.createElement('figure');
    var button = document.createElement('button');
    button.type = 'button';
    var img = document.createElement('img');
    img.src = file.thumb ? file.thumb.src : file.src;
    img.alt = file.alt || file.title || '';
    img.loading = 'lazy';
    button.appendChild(img);
    button.addEventListener('click', function () { open(n); });
    figure.appendChild(button);
    if (file.title) {
      var caption = document.createElement('figcaption');
      caption.textContent = file.title;
      figure.appendChild(caption);
    }
    li.appendChild(figure);
    list.appendChild(li);
  }

  function open(n) {
    at = (n + pictures.length) % pictures.length;
    var file = pictures[at];
    var img = box.querySelector('img');
    img.src = file.src;
    img.alt = file.alt || file.title || '';
    box.querySelector('figcaption').textContent = file.title || '';
    if (!box.open) box.showModal();
  }

  box.querySelector('.prev').addEventListener('click', function () { open(at - 1); });
  box.querySelector('.next').addEventListener('click', function () { open(at + 1); });
  box.querySelector('.close').addEventListener('click', function () { box.close(); });
  box.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft') open(at - 1);
    if (e.key === 'ArrowRight') open(at + 1);
  });
  // a swipe left or right on a phone
  var startX = null;
  box.addEventListener('pointerdown', function (e) { startX = e.clientX; });
  box.addEventListener('pointerup', function (e) {
    if (startX !== null && Math.abs(e.clientX - startX) > 50) open(at + (e.clientX < startX ? 1 : -1));
    startX = null;
  });
  more.querySelector('button').addEventListener('click', load);
  load();
})();

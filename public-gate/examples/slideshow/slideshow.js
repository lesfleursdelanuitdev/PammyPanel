// Example: Slide show (12-media-on-your-pages.txt).
// Asks the media API for the pictures in data-api and shows one at a time. It
// moves on by itself every data-seconds, stops while you point at it or use the
// keyboard in it, and never moves by itself for people whose device asks for
// less motion. "Pause" stops it for good.
(function () {
  var show = document.querySelector('.slideshow');
  if (!show) return;
  var img = show.querySelector('.slide img');
  var caption = show.querySelector('figcaption');
  var dots = show.querySelector('.dots');
  var pause = show.querySelector('.pause');
  var seconds = Number(show.getAttribute('data-seconds')) || 0;
  var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var pictures = [];
  var at = 0;
  var timer = null;
  var paused = still || seconds === 0;
  var hovering = false;

  fetch(show.getAttribute('data-api') + (show.getAttribute('data-api').indexOf('?') < 0 ? '?' : '&') + 'limit=50')
    .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
    .then(function (data) {
      pictures = data.files;
      if (!pictures.length) return empty(show.getAttribute('data-empty'));
      pictures.forEach(function (file, n) {
        var dot = document.createElement('button');
        dot.type = 'button';
        dot.setAttribute('aria-label', 'Picture ' + (n + 1) + (file.title ? ': ' + file.title : ''));
        dot.addEventListener('click', function () { go(n); });
        dots.appendChild(dot);
      });
      pause.setAttribute('aria-pressed', String(paused));
      pause.textContent = paused ? 'Play' : 'Pause';
      pause.hidden = seconds === 0;
      go(0);
    })
    .catch(function () { empty('The pictures could not be loaded just now.'); });

  function empty(text) {
    show.innerHTML = '';
    var p = document.createElement('p');
    p.className = 'empty';
    p.textContent = text;
    show.appendChild(p);
  }

  function go(n) {
    at = (n + pictures.length) % pictures.length;
    var file = pictures[at];
    img.classList.add('fading');
    setTimeout(function () {
      img.src = file.src;
      img.alt = file.alt || file.title || '';
      img.classList.remove('fading');
    }, still ? 0 : 200);
    caption.textContent = file.title || '';
    Array.prototype.forEach.call(dots.children, function (d, i) { d.setAttribute('aria-current', String(i === at)); });
    // the next one, fetched early so it appears at once
    var ahead = new Image();
    ahead.src = pictures[(at + 1) % pictures.length].src;
    restart();
  }

  function restart() {
    clearTimeout(timer);
    if (!paused && !hovering && pictures.length > 1) timer = setTimeout(function () { go(at + 1); }, seconds * 1000);
  }

  show.querySelector('.prev').addEventListener('click', function () { go(at - 1); });
  show.querySelector('.next').addEventListener('click', function () { go(at + 1); });
  pause.addEventListener('click', function () {
    paused = !paused;
    pause.setAttribute('aria-pressed', String(paused));
    pause.textContent = paused ? 'Play' : 'Pause';
    restart();
  });
  show.addEventListener('mouseenter', function () { hovering = true; restart(); });
  show.addEventListener('mouseleave', function () { hovering = false; restart(); });
  show.addEventListener('focusin', function () { hovering = true; restart(); });
  show.addEventListener('focusout', function () { hovering = false; restart(); });
  show.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft') go(at - 1);
    if (e.key === 'ArrowRight') go(at + 1);
  });
})();

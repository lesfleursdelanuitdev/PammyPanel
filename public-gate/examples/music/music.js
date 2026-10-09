// Example: Music player (12-media-on-your-pages.txt).
// Asks the media API for the songs in data-api and plays them one after another:
// play and pause, the next and previous song, a bar to skip about in the song,
// each song's cover picture, and the list to pick from.
(function () {
  var player = document.querySelector('.player');
  if (!player) return;
  var audio = player.querySelector('audio');
  var list = player.querySelector('.songs');
  var play = player.querySelector('.play');
  var seek = player.querySelector('.seek');
  var cover = player.querySelector('.cover');
  var playing = player.querySelector('.playing');
  var songs = [];
  var at = 0;

  var api = player.getAttribute('data-api');
  fetch(api + (api.indexOf('?') < 0 ? '?' : '&') + 'limit=100&order=name')
    .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
    .then(function (data) {
      songs = data.files;
      if (!songs.length) return empty(player.getAttribute('data-empty'));
      songs.forEach(add);
      choose(0, false);
    })
    .catch(function () { empty('The songs could not be loaded just now.'); });

  function empty(text) {
    player.innerHTML = '';
    var p = document.createElement('p');
    p.className = 'empty';
    p.textContent = text;
    player.appendChild(p);
  }

  function add(song, n) {
    var li = document.createElement('li');
    var button = document.createElement('button');
    button.type = 'button';
    var number = document.createElement('span');
    number.className = 'number';
    number.textContent = String(n + 1);
    button.appendChild(number);
    if (song.thumb) {
      var img = document.createElement('img');
      img.src = song.thumb.src;
      img.alt = '';
      img.loading = 'lazy';
      button.appendChild(img);
    }
    button.appendChild(document.createTextNode(song.title || song.name));
    button.addEventListener('click', function () { choose(n, true); });
    li.appendChild(button);
    list.appendChild(li);
  }

  function choose(n, start) {
    at = (n + songs.length) % songs.length;
    var song = songs[at];
    audio.src = song.src;
    playing.textContent = song.title || song.name;
    if (song.thumb) { cover.src = song.thumb.src; cover.alt = song.alt || ''; } else { cover.removeAttribute('src'); }
    Array.prototype.forEach.call(list.querySelectorAll('button'), function (b, i) { b.setAttribute('aria-current', String(i === at)); });
    if (start) audio.play();
  }

  function time(s) {
    s = Math.floor(s || 0);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  play.addEventListener('click', function () { if (audio.paused) audio.play(); else audio.pause(); });
  player.querySelector('.prev').addEventListener('click', function () {
    // like most players: back to the start first, then the song before
    if (audio.currentTime > 3) audio.currentTime = 0; else choose(at - 1, !audio.paused);
  });
  player.querySelector('.next').addEventListener('click', function () { choose(at + 1, !audio.paused); });
  audio.addEventListener('play', function () { play.innerHTML = '&#10074;&#10074;'; play.setAttribute('aria-label', 'Pause'); });
  audio.addEventListener('pause', function () { play.innerHTML = '&#9654;'; play.setAttribute('aria-label', 'Play'); });
  audio.addEventListener('ended', function () { if (at < songs.length - 1) choose(at + 1, true); });
  audio.addEventListener('loadedmetadata', function () {
    seek.max = String(Math.floor(audio.duration || 0));
    player.querySelector('.length').textContent = time(audio.duration);
  });
  audio.addEventListener('timeupdate', function () {
    seek.value = String(Math.floor(audio.currentTime));
    player.querySelector('.time').textContent = time(audio.currentTime);
  });
  seek.addEventListener('input', function () { audio.currentTime = Number(seek.value); });
})();

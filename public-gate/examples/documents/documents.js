// Example: Documents (12-media-on-your-pages.txt).
// Asks the media API for the files in data-api and lists them: the first page's
// picture where there is one (PDFs), else the file's ending; its title, kind,
// size and date; and a Download button.
(function () {
  var list = document.querySelector('.documents');
  if (!list) return;
  var api = list.getAttribute('data-api');

  fetch(api + (api.indexOf('?') < 0 ? '?' : '&') + 'limit=100&order=name')
    .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
    .then(function (data) {
      if (!data.files.length) return empty(list.getAttribute('data-empty'));
      data.files.forEach(add);
    })
    .catch(function () { empty('The list could not be loaded just now.'); });

  function empty(text) {
    var li = document.createElement('li');
    li.className = 'empty';
    li.textContent = text;
    list.appendChild(li);
  }

  function size(bytes) {
    if (bytes < 1024) return bytes + ' bytes';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  function add(file) {
    var ending = (file.name.split('.').pop() || '').toUpperCase();
    var li = document.createElement('li');

    var picture = document.createElement('span');
    picture.className = 'picture';
    if (file.thumb) {
      var img = document.createElement('img');
      img.src = file.thumb.src;
      img.alt = '';
      img.loading = 'lazy';
      picture.appendChild(img);
    } else {
      picture.textContent = ending;
    }

    var about = document.createElement('span');
    about.className = 'about';
    var title = document.createElement('a');
    title.className = 'title';
    title.href = file.src;
    title.textContent = file.title || file.name;
    var facts = document.createElement('span');
    facts.className = 'facts';
    facts.textContent = [ending, size(file.size), new Date(file.addedAt).toLocaleDateString()].join(' · ');
    about.appendChild(title);
    about.appendChild(facts);

    var download = document.createElement('a');
    download.className = 'download';
    download.href = file.src;
    download.setAttribute('download', file.name);
    download.textContent = 'Download';
    download.setAttribute('aria-label', 'Download ' + (file.title || file.name));

    li.appendChild(picture);
    li.appendChild(about);
    li.appendChild(download);
    list.appendChild(li);
  }
})();

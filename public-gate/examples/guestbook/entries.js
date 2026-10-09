// Shows the guest book messages that have been approved.
//
// It asks the website for them, then puts each one on the page with textContent,
// which puts words on the page as words. Never innerHTML: what a visitor typed
// would then become part of the page's own code, and that is how websites get
// broken into.
//
// Nothing here needs changing when you change the questions: it uses whatever
// the answer comes back with.
(function () {
  var list = document.querySelector('.entries');
  if (!list) return;
  var form = list.dataset.form;
  var shown = 0;
  var next = null;

  function when(iso) {
    var d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  function add(response) {
    var entry = document.createElement('li');
    entry.className = 'entry';

    var head = document.createElement('p');
    head.className = 'who';
    var name = document.createElement('span');
    name.className = 'name';
    name.textContent = response.answers['your-name'] || 'A friend';
    head.append(name);
    if (response.answers.from) {
      var from = document.createElement('span');
      from.className = 'from';
      from.textContent = 'from ' + response.answers.from;
      head.append(' ', from);
    }
    var date = document.createElement('span');
    date.className = 'when';
    date.textContent = when(response.sentAt);
    head.append(' ', date);

    var said = document.createElement('p');
    said.className = 'said';
    said.textContent = response.answers.message || '';

    entry.append(head, said);
    list.append(entry);
    shown++;
  }

  function empty(words) {
    var note = document.createElement('li');
    note.className = 'empty';
    note.textContent = words;
    list.append(note);
  }

  function load(after) {
    var url = '/_pammy/api/forms/by-name/' + form + '/approved?order=desc&limit=10';
    if (after) url += '&after=' + encodeURIComponent(after);
    return fetch(url)
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function (data) {
        var more = document.querySelector('.more');
        if (more) more.remove();
        data.responses.forEach(add);
        next = data.next;
        if (shown === 0) return empty(list.dataset.empty);
        if (!next) return;
        var button = document.createElement('button');
        button.className = 'more';
        button.type = 'button';
        button.textContent = 'More messages';
        button.addEventListener('click', function () { load(next); });
        list.after(button);
      })
      .catch(function () {
        if (shown === 0) empty('The messages can’t be shown at the moment.');
      });
  }

  load(null);
})();

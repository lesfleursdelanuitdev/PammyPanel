// Shows who is coming, from the replies that have been approved.
//
// It asks twice, once for each answer it wants: "filterby" narrows the replies
// down to one answer to one question, so the page never has to sort through
// replies it isn't showing.
//
// What people said in "Anything I should know" is NOT ticked as public in the
// form, so it never arrives here at all -- it stays in the control panel, where
// only you can read it. The same goes for their email address.
(function () {
  var box = document.querySelector('.who');
  if (!box) return;
  var form = box.dataset.form;

  function ask(answer) {
    return fetch('/_pammy/api/forms/by-name/' + form + '/approved/filterby/coming/' + answer + '?limit=100')
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); });
  }

  function heads(responses) {
    return responses.reduce(function (n, r) {
      var many = Number(r.answers['how-many']);
      return n + (many > 0 ? many : 1);
    }, 0);
  }

  function nameOf(response) {
    var name = response.answers['your-name'] || 'A friend';
    var many = Number(response.answers['how-many']);
    return many > 1 ? name + ' (' + many + ' of them)' : name;
  }

  Promise.all([ask('Yes'), ask('Maybe')]).then(function (both) {
    var yes = both[0].responses;
    var maybe = both[1].responses;
    var people = heads(yes);

    box.querySelector('.count').textContent = people === 0
      ? 'Nobody has replied yet. Be the first!'
      : people === 1 ? '1 person coming so far' : people + ' people coming so far';

    var list = box.querySelector('.coming');
    yes.forEach(function (r) {
      var line = document.createElement('li');
      line.textContent = nameOf(r);
      list.append(line);
    });

    if (maybe.length) {
      var note = document.createElement('p');
      note.className = 'maybe';
      note.textContent = 'Might come: ' + maybe.map(nameOf).join(', ');
      box.querySelector('.maybes').append(note);
    }
  }).catch(function () {
    box.querySelector('.count').textContent = 'The replies can’t be shown at the moment.';
  });
})();

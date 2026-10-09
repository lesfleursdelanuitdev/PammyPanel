// Pins the notes that have been approved onto the board.
//
// Two things here keep the page safe, and both matter:
//
//   * every word a visitor wrote goes in with textContent, never innerHTML;
//   * the colour they picked is looked up in the list below, and only the
//     answer that is found decides the colour. The answer itself is NEVER put
//     into the page's own code -- not as a class, not as a style, not anywhere.
//     Looking a visitor's answer up, instead of using it, is the whole trick.
(function () {
  var board = document.querySelector('.board');
  if (!board) return;

  var COLOURS = { Yellow: 'yellow', Pink: 'pink', Mint: 'mint', Blue: 'blue' };
  var TILTS = ['tilt-a', 'tilt-b', 'tilt-c', 'tilt-d'];

  function pin(response) {
    var note = document.createElement('article');
    // the same note always leans the same way, so the board doesn't jump about
    note.className = 'note ' + (COLOURS[response.answers.colour] || 'yellow')
      + ' ' + TILTS[response.id % TILTS.length];

    var words = document.createElement('p');
    words.className = 'words';
    words.textContent = response.answers.note || '';

    var who = document.createElement('p');
    who.className = 'who';
    who.textContent = response.answers['your-name'] || 'A friend';

    note.append(words, who);
    board.append(note);
  }

  fetch('/_pammy/api/forms/by-name/' + board.dataset.form + '/approved?order=desc&limit=30')
    .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
    .then(function (data) {
      if (!data.responses.length) {
        var note = document.createElement('p');
        note.className = 'empty';
        note.textContent = board.dataset.empty;
        return board.append(note);
      }
      data.responses.forEach(pin);
    })
    .catch(function () {
      var note = document.createElement('p');
      note.className = 'empty';
      note.textContent = 'The notes can’t be shown at the moment.';
      board.append(note);
    });
})();

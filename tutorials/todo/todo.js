// todo.js -- your list: read it, add to it, tick things off.

// Where the tasks are: the address under "Where programs ask",
// without the https://pammy.org at the front.
const TASKS = '/_pammy/api/data/postgres/todo/tasks';

// Asks for tasks, or (with values) sends a change. pammy.org knows
// who is signed in, so it only ever shows and changes their own.
async function ask(path, values) {
  const options = {};
  if (values) {
    options.method = 'POST';
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify({ values: values });
  }
  const answer = await fetch(TASKS + path, options);
  const body = await answer.json();
  if (!answer.ok) {
    throw new Error(body.message);
  }
  return body;
}

// Shows what went wrong, or nothing
function problem(message) {
  const box = document.getElementById('problem');
  box.textContent = message || '';
  box.hidden = !message;
}

async function showTasks() {
  const answer = await ask('?sort=id&per=100');
  const list = document.getElementById('tasks');
  list.textContent = '';

  if (answer.items.length === 0) {
    const empty = document.createElement('li');
    empty.textContent = 'Nothing to do. Well done!';
    list.append(empty);
  }

  for (const task of answer.items) {
    const tick = document.createElement('input');
    tick.type = 'checkbox';
    tick.checked = task.done;
    tick.addEventListener('change', () => change('/' + task.id + '/save', { done: tick.checked }));

    const words = document.createElement('span');
    words.textContent = task.title;

    const label = document.createElement('label');
    label.append(tick, ' ', words);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove';
    remove.textContent = 'Delete';
    remove.setAttribute('aria-label', 'Delete ' + task.title);
    remove.addEventListener('click', () => change('/' + task.id + '/delete', {}));

    const item = document.createElement('li');
    item.className = task.done ? 'done' : '';
    item.append(label, remove);
    list.append(item);
  }
}

// Sends one change, then shows the list again
async function change(path, values) {
  try {
    await ask(path, values);
    problem('');
  } catch (error) {
    problem(error.message);
  }
  await showTasks();
}

// A new task, from the form
document.getElementById('add').addEventListener('submit', async (event) => {
  event.preventDefault();
  const box = document.getElementById('new-task');
  await change('/new', { title: box.value.trim(), done: false });
  box.value = '';
  box.focus();
});

// Who is signed in, for the line at the top: their username
fetch('/_pammy/me')
  .then((answer) => answer.json())
  .then((me) => {
    document.getElementById('who').textContent = me.username;
  });

showTasks().catch((error) => problem(error.message));

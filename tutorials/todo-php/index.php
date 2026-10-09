<?php
require __DIR__ . '/tasks.php';

// Who is signed in. pammy.org says so, only inside a protected
// folder, and nobody can pretend to be someone else here.
$me = $_SERVER['PAMMY_USER'] ?? '';
if ($me === '') {
    http_response_code(403);
    exit('This page only works inside a protected folder.');
}

// A button was pressed: do it, then show the list again.
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    // only from this website's own pages
    if (($_SERVER['HTTP_ORIGIN'] ?? '') !== 'https://' . $_SERVER['HTTP_HOST']) {
        http_response_code(403);
        exit('Changes can only be made from this page.');
    }
    $do = $_POST['do'] ?? '';
    $id = (int) ($_POST['id'] ?? 0);
    $title = trim($_POST['title'] ?? '');

    if ($do === 'add' && $title !== '') {
        ask('/new', ['title' => $title, 'done' => false, 'owner' => $me]);
    } elseif ($id > 0 && mine($id, $me)) {
        if ($do === 'done') {
            ask('/' . $id . '/save', ['done' => true]);
        } elseif ($do === 'undo') {
            ask('/' . $id . '/save', ['done' => false]);
        } elseif ($do === 'delete') {
            ask('/' . $id . '/delete', []);
        }
    }
    header('Location: ./', true, 303);
    exit;
}

$answer = ask('?sort=id&per=100&where.owner=' . rawurlencode($me));
?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>To do</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <main>
    <h1>To do</h1>
    <p class="who">Signed in as <?= h($me) ?>. <a href="logout.html">Sign out</a></p>

    <form id="add" method="post">
      <label for="new-task">Something to do</label>
      <input id="new-task" name="title" required maxlength="200" autocomplete="off">
      <button name="do" value="add">Add it</button>
    </form>

<?php if ($answer['status'] !== 200): ?>
    <p id="problem" role="alert"><?= h($answer['message'] ?? '') ?></p>
<?php endif; ?>

    <ul id="tasks">
<?php if (($answer['items'] ?? null) === []): ?>
      <li>Nothing to do. Well done!</li>
<?php endif; ?>
<?php foreach ($answer['items'] ?? [] as $task): ?>
      <li class="<?= $task['done'] ? 'done' : '' ?>">
        <form method="post">
          <input type="hidden" name="id" value="<?= (int) $task['id'] ?>">
          <button name="do" value="<?= $task['done'] ? 'undo' : 'done' ?>"
                  aria-label="<?= $task['done'] ? 'Not done: ' : 'Done: ' ?><?= h($task['title']) ?>"><?= $task['done'] ? '&#9745;' : '&#9744;' ?></button>
          <span><?= h($task['title']) ?></span>
        </form>
        <form method="post">
          <input type="hidden" name="id" value="<?= (int) $task['id'] ?>">
          <button class="remove" name="do" value="delete" aria-label="Delete <?= h($task['title']) ?>">Delete</button>
        </form>
      </li>
<?php endforeach; ?>
    </ul>
  </main>
</body>
</html>

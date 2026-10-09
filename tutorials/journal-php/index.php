<?php
require __DIR__ . '/api.php';

$answer = ask('/posts?sort=published_on&dir=desc&per=20');
?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>My journal</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <main>
    <h1>My journal</h1>
    <p class="intro">Notes from the garden, the kitchen and further away.</p>

    <ol id="posts">
<?php if ($answer['status'] !== 200): ?>
      <li><?= h($answer['message'] ?? '') ?></li>
<?php elseif (count($answer['items']) === 0): ?>
      <li>Nothing here yet.</li>
<?php endif; ?>
<?php foreach ($answer['items'] ?? [] as $post): ?>
      <li>
        <h2><a href="post.php?id=<?= (int) $post['id'] ?>"><?= h($post['title']) ?></a></h2>
        <p class="about"><?= h(byline($post)) ?></p>
      </li>
<?php endforeach; ?>
    </ol>
  </main>
</body>
</html>

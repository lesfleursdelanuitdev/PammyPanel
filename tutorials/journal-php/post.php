<?php
require __DIR__ . '/api.php';

// post.php?id=3 -- (int) makes sure it is a number, whatever was typed
$id = (int) ($_GET['id'] ?? 0);
$answer = ask('/posts/' . $id);
$post = $answer['item'] ?? null;

if ($post === null) {
    http_response_code(404);
}
?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title><?= h($post['title'] ?? 'Not here') ?></title>
  <link rel="stylesheet" href="style.css">
  <!-- the comments under each post (guide 20) -->
  <script src="/_pammy/comments.js" defer></script>
</head>
<body>
  <main>
    <p class="back"><a href="./">&larr; All posts</a></p>

<?php if ($post === null): ?>
    <h1>Not here</h1>
    <p>That post isn't here. It may not be published yet.</p>
<?php else: ?>
    <article>
      <h1><?= h($post['title']) ?></h1>
      <p class="about"><?= h(byline($post)) ?></p>
      <div class="writing">
<?php // rich text is HTML that pammy.org cleaned: safe to put on as it is ?>
<?php if (in_array('body', $answer['rich'], true)): ?>
        <?= $post['body'] ?? '' ?>
<?php else: ?>
        <p><?= nl2br(h($post['body'])) ?></p>
<?php endif; ?>
      </div>
      <p class="topics"><?= h(topics_of($post)) ?></p>
    </article>

    <!-- this post's comments: the post's id says which conversation -->
    <pammy-comments name="journal-comments" content-id="<?= (int) $post['id'] ?>" order="oldest"></pammy-comments>
<?php endif; ?>
  </main>
</body>
</html>

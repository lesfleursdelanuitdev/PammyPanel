<?php
// tasks.php -- asking for tasks, and changing them.

// Where the tasks are: the address under "Where programs ask",
// without the https://pammy.org at the front.
const TASKS = '/_pammy/api/data/postgres/todo/tasks';

// Asks for tasks, or (with values) sends a change, with the key
// from settings.php. The key can reach everybody's tasks, so the
// page must only ever ask about the signed-in person's own.
function ask(string $path, ?array $values = null): array
{
    $key = require __DIR__ . '/settings.php';
    $headers = ['Authorization: Bearer ' . $key];
    $request = curl_init('http://pammy.org' . TASKS . $path);
    curl_setopt_array($request, [
        CURLOPT_UNIX_SOCKET_PATH => getenv('PAMMY_API_SOCKET'),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 10,
    ]);
    if ($values !== null) {
        $headers[] = 'Content-Type: application/json';
        curl_setopt($request, CURLOPT_POST, true);
        curl_setopt($request, CURLOPT_POSTFIELDS, json_encode(['values' => $values]));
    }
    curl_setopt($request, CURLOPT_HTTPHEADER, $headers);
    $text = curl_exec($request);
    $answer = is_string($text) ? json_decode($text, true) : null;
    if (!is_array($answer)) {
        $answer = ['message' => 'The list could not be reached just now.'];
    }
    $answer['status'] = curl_getinfo($request, CURLINFO_RESPONSE_CODE);
    return $answer;
}

// Is task number $id one of $me's? Asked every time, because the
// number came from the page, and anyone can change a page.
function mine(int $id, string $me): bool
{
    $answer = ask('/' . $id);
    return ($answer['item']['owner'] ?? null) === $me;
}

// Words, made safe to put on a page: a < or & in them can't
// start a tag.
function h(?string $text): string
{
    return htmlspecialchars($text ?? '', ENT_QUOTES);
}

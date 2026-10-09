<?php
// api.php -- the parts both pages share.

// Where your journal's records are: the start of the address under
// "Where programs ask", without the https://pammy.org at the front.
const JOURNAL = '/_pammy/api/data/postgres/journal';

// Asks for records, and gives back the answer as a PHP array. PHP
// on pammy.org can't reach the internet: it asks through its own
// door, whose address is in PAMMY_API_SOCKET.
function ask(string $path): array
{
    $request = curl_init('http://pammy.org' . JOURNAL . $path);
    curl_setopt_array($request, [
        CURLOPT_UNIX_SOCKET_PATH => getenv('PAMMY_API_SOCKET'),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 10,
    ]);
    $text = curl_exec($request);
    $answer = is_string($text) ? json_decode($text, true) : null;
    if (!is_array($answer)) {
        $answer = ['message' => 'The journal could not be read just now.'];
    }
    $answer['status'] = curl_getinfo($request, CURLINFO_RESPONSE_CODE);
    return $answer;
}

// Words, made safe to put on a page: a < or & in them can't
// start a tag. Use it for everything except rich text.
function h(?string $text): string
{
    return htmlspecialchars($text ?? '', ENT_QUOTES);
}

// "2026-03-21" -> "21 March 2026"
function nice_date(?string $value): string
{
    $day = DateTime::createFromFormat('Y-m-d', substr($value ?? '', 0, 10));
    return $day ? $day->format('j F Y') : '';
}

// "By Pamela · 21 March 2026"
function byline(array $post): string
{
    $parts = [];
    if (!empty($post['author'])) {
        $parts[] = 'By ' . $post['author']['label'];
    }
    if (!empty($post['published_on'])) {
        $parts[] = nice_date($post['published_on']);
    }
    return implode(' · ', $parts);
}

// "Garden · Kitchen"
function topics_of(array $post): string
{
    return implode(' · ', array_column($post['topics'] ?? [], 'label'));
}

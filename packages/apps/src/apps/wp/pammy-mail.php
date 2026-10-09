<?php
/**
 * Plugin Name: pammy mail
 * Description: Sends this site's email through Resend (SMTP), with the settings the pammy.org control panel keeps in /etc/pammywp/mail.json. Put here by the panel (docs/apps-plan.md phase 3); changes to this file are overwritten.
 */
if (!defined('ABSPATH')) {
    exit;
}

// The panel's settings: host, port, user, pass (the Resend key), from, replyTo.
// Without them (or unreadable) WordPress sends as it always did.
function pammy_mail_settings() {
    static $s = null;
    if ($s === null) {
        $raw = @file_get_contents('/etc/pammywp/mail.json');
        $s = $raw ? json_decode($raw, true) : false;
        if (!is_array($s) || empty($s['pass']) || empty($s['from'])) {
            $s = false;
        }
    }
    return $s;
}

add_action('phpmailer_init', function ($mailer) {
    $s = pammy_mail_settings();
    if (!$s) {
        return;
    }
    $mailer->isSMTP();
    $mailer->Host = $s['host'];
    $mailer->Port = (int) $s['port'];
    $mailer->SMTPSecure = 'tls';          // STARTTLS on 587
    $mailer->SMTPAuth = true;
    $mailer->Username = $s['user'];
    $mailer->Password = $s['pass'];
    $mailer->Timeout = 20;
    if (!empty($s['replyTo']) && !$mailer->getReplyToAddresses()) {
        $mailer->addReplyTo($s['replyTo']);
    }
});

add_filter('wp_mail_from', function ($from) {
    $s = pammy_mail_settings();
    return $s ? $s['from'] : $from;
});

// Her site's own name ("Pamela's blog"), as WordPress calls it in Settings
add_filter('wp_mail_from_name', function ($name) {
    $s = pammy_mail_settings();
    if (!$s) {
        return $name;
    }
    $site = wp_specialchars_decode(get_bloginfo('name'), ENT_QUOTES);
    return $site !== '' ? $site : $name;
});

// A failure goes to the container's log, which the panel shows under
// "What it complained about lately".
add_action('wp_mail_failed', function ($error) {
    error_log('pammy-mail: ' . $error->get_error_message());
});

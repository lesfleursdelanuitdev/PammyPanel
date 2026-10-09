# Comments: plan

Status: **built 2026-09-22, not installed** (amendments in section 0; as built just below).

### As built

- **The blog example has comments (2026-09-22, after ec647830):** 14 posts (13 published, 7
  sample comments on 4 of them). One fixture area `example-blog-comments` (fixture
  `blog-comments`, about `posts`) on the gate's own `/_pammy/examples/blog/` -- allowed only for
  fixture areas (`exampleTarget` in src/gate/app.ts). "Set up" / "Put it back" runs the admin op
  `comments.example`: samples back, approved, copied into the example DB's `comments` /
  `comment_threads` / `post_comment_threads`. Like the form examples it keeps only the newest 50
  and never counts towards `commentsWaiting`. "Make my own" makes `<db>-comments` for her copy.
  blog.js: one `/counts` request for the list, `<pammy-comments content-id>` per post. Reading
  writes nothing: a thread starts with its first comment (gate test: 14 posts read, 0 rows).
- **Phase 1 (any page):** migration 0013 (`forms.kind`, `forms.content_type`,
  `responses.content_type/content_id` + index, `form_links.mode`); comment areas are forms with
  approvals forced on and "show right away" refused (C15); gate routes
  `/_pammy/comments.js`, `/_pammy/comments/<area>` (read, ETag), `/form`, POST, `/counts`
  (src/gate/app.ts); `components/comments.ts` (`<pammy-comments>`, carrying `<pammy-form>`, which
  gained a comments mode). Page threads are the resolved file with a folder's `index.html`
  filled in; a page may give `content-id`. **Reading filters by the page each comment was
  sent from**, so a thread shared by a public and a protected page never shows the protected
  page's comments outside it.
- **Limits are per form for every form** (section 0) -- two older gate tests changed with it.
- **Phase 2:** Inbox > Comments (`web/src/pages/Comments.tsx`, route `/api/comments`), its own
  red number (`commentsWaiting`); comments kept out of Responses and its number; comment areas
  kept out of the Forms list, with the line pointing to Comments. Approve/hide/trash reuse the
  responses routes.
- **Phases 3 and 4:** "This app takes comments" (`POST /api/databases/:e/:n/comments`) and
  "People can comment on these" (`.../app/:table/commentable`) draw the tables into the draft
  (`src/studio/comments-tables.ts`) and save what the app says about them; the first also
  makes `<db>-comments` and its copy link (C9). The copy is `form_links.mode = 'comments'`,
  written by `saveComment` in src/gate/form-links.ts, checked against the catalog, following
  approval both ways (A1), recounting the thread each time. "Keep the approved comments in"
  on each area chooses or clears the app.
- **Correction to C11:** with the link table pointing at both the post and the thread,
  deleting a post deletes its **link** only; the thread and its comments stay (their
  `content_id` still names the post). Deleting the thread deletes its comments. Guide 14 says
  exactly that.
- **Found on the way:** form links wrote "when it was sent" as ISO text with a `Z`, which
  MariaDB's DATETIME refuses -- a latent bug in docs/form-to-database-plan.md's writer. Both
  writers now use `momentFor(engine, ...)`; proved on real MariaDB and Postgres.
- **Not built:** the data API answering a post with its comment count (phase 4's last line);
  closing one conversation (the `open` column is there; the area's Open switch closes all of
  it); a shortened question list in the builder for comment areas (C7); replies and emails
  (phase 5). Follows docs/db-examples-plan.md X11 ("a later version
can take comments through a Form"), docs/form-to-database-plan.md (the response is kept, the
database gets a copy) and docs/auto-approve-plan.md (who decides what shows).

Comments are three things the panel already has, in a new arrangement:

- a **write** anyone on the internet may make -- that is a Form, with its honeypot, its
  10-an-hour, its 64 KB, its unread caps and its approving;
- a **read** anyone may make -- that is the forms API's keyless `/approved`, which the guest
  book example has used since Forms shipped;
- somewhere to **keep them she can join and query** -- that is a table in one of her databases,
  filled in the way a form fills a table today.

So this plan adds no fourth store and no second idea of "approved". It adds a thread key on a
response, one new element, one new page in the panel, and two switches in the Database Manager
that draw tables into the draft.

## 0. Amendments (momolig and Claude, 2026-09-22) -- these win over anything below

momolig's answers:
- **No Turnstile first.** It needs Pamela to make the widget, so comments are built now, with
  C15 as the guard: **every comment waits for her OK** before anyone sees it. (Q4)
- **Limits per form, not for the whole site.** Today the gate refuses every new response
  once there are 10,000 stored or 1,000 unread **across all forms together** -- at thirty
  comments a day, comments alone would stop her contact forms within a year. Both limits
  become per form (per comment area), for every form.
- **Comments are approved before they are shown** (C15, confirmed).
- **Pages are known by their file.** The gate already resolves a page's address to the real
  file under the website (`pageTarget`: shortcuts followed, `?query` dropped, a folder
  subdomain's address turned into its folder) and records it for "Used on". A page thread's
  content id is that path, with a folder's `index.html` filled in, so `/about/` and
  `/about/index.html` are one conversation. A page may instead give `content-id` from a
  database of hers (an id of her own), which then wins.
- **The site has no users yet**, so the tables ported from SQLite (gate.forms,
  gate.responses) may take new columns; test/pg.test.ts learns which columns came after the
  port, instead of forcing side tables.

Claude's corrections to the plan below:
- **A1 -- the table copy follows approval both ways** (replaces "copied once" in section 5).
  Form links (docs/form-to-database-plan.md) write one row once and never touch it again; a
  comment that is hidden after being approved would stay "approved" in her table. So the
  comments writer is its own mode: approving writes the comment (or sets `approved` yes on
  the row it wrote before), un-approving or trashing sets `approved` no, and the thread's
  `comments` count and `last_at` are worked out again from the approved rows each time.
- **A2 -- it is a new writer, not the one-table link.** Per comment it finds or makes the
  thread (and, for a commentable resource, its link row -- after checking the post exists),
  writes or updates the comment, and brings the thread's count up to date. Built beside
  `src/gate/form-links.ts`, sharing its catalog check and its "kept on the response, said in
  her words" failures. **Since 2026-09-22** (docs/refactor-plan.md phase 2) both writers live in
  `src/gate/saves/` and neither writes down how it went: they hand back an outcome and the queue
  writes it. Three things about comments changed with it -- a copy that still has something left
  to do stays in the retry queue even though it has been written once (B1), the recount happens
  under a lock so two approvals at once cannot leave a stale count (B6), and a try that never
  heard the answer is simply tried again, because `comments.response_id` is unique (W4).
- **A6 -- the count a page is told is the count that page may see** (2026-09-22, refactor-plan
  B7/W8). The public total for a thread is worked out from the whole thread grouped by the page
  each comment was sent from, leaving out the pages this visitor may not open -- not from the
  page of comments being sent back. A comment behind a protected door no longer swells the
  number under a public post.
- **A3 -- one thread per thing**: `comment_threads` is unique on (area, content_type,
  content_id), so two comments arriving at once cannot make two threads.
- **A4 -- numbering**: C6 and C7 cite Q1 and Q2 as decided; Q1 is decided as C6 says, and C7's
  "Q2" means "should Forms list comment areas", decided no.

---

## 1. Decisions

| # | Decision | Source |
|---|---|---|
| C1 | **A comment area is a form.** Same table, same builder, same spam guards, same Approve, same "Show right away" / "Wait for my OK". A form gains a kind (`form` or `comments`) and a response gains `content_type` and `content_id`. Everything else about a comment is a thing forms already do. | Claude |
| C2 | **The gate keeps the comment; a table gets a copy** -- F1, unchanged. A comment is never lost because a database was asleep, and comments work on a website with no database at all. The tables in C8 are the copy that lets her join, count and sort. | Claude |
| C3 | **The element is `<pammy-comments>`**, built from `components/comments.ts`, served at `/_pammy/comments.js`, classes `pammy-comment-*`, styles inside `:where()`, `styles="off"` to leave them out. Everything a visitor's browser loads is `pammy-`; Pamela is the person, pammy.org is the website. | Claude |
| C4 | **The page names the area and the content, nothing else**: `<pammy-comments name="blog-comments" content-id="12">`. Which app and which content type are **settings of the area**, set once in the panel. Repeating them in every page's HTML is four chances to mistype something that silently splits one conversation into two. | Claude |
| C5 | **`content-id` defaults to the page's path** -- which is point 3 in one line: `<pammy-comments name="page-comments">` on any page of her website comments that page, with no database, no app and nothing to set up. But an area attached to a **table** requires `content-id`; an empty one is an error shown on the page, never a fall back to the path. A blog template at `/blog.html?id=12` must not pour every post's comments into one thread. | Claude |
| C6 | **Comments are seen on their own page, Comments, under Inbox** -- not mixed into Responses. Same rows, same store, a different door: Responses is "somebody sent me something to read", Comments is "there is a conversation on one of my pages". One contact form gets three a month; comments get thirty a day, and they would bury the forms. The waiting count joins the red dot that Responses and Home already use. | Claude (Q1) |
| C7 | **Forms does not list comment areas.** A line at the bottom -- "Comment areas live in Comments" -- and that is all. Each tab means one thing. Underneath it is the same builder component with a shorter list of question types. | Claude (Q2) |
| C8 | **"This app takes comments"** on a database's Application tab draws two tables **into the draft** and sends her to Review: `comment_threads` and `comments`. It does not run anything. Nothing in the studio has ever touched her database without Review then Apply, and a switch that quietly made tables would be the one place that broke it. | momolig / draft *(Claude)* |
| C9 | **The same switch also makes the area and the link**: a comment area (a form) for that app, and the form-to-database link, already paired, so one switch and one Apply give her a working set. | Claude |
| C10 | **"People can comment on these"** on a resource (blog posts) draws **one link table** into the draft: `post_comment_threads (post_id -> posts, thread_id -> comment_threads, one row per post)`. Not a junction: a junction says one comment belongs to many posts, which is not true of any comment. This is a one-to-one link, drawn as a table for the reasons in C11. | Claude, correcting momolig's point 5 |
| C11 | **The link is to the thread, not to the comment**, and it is a table rather than a column because: a column on `comment_threads` means **altering the shared table** every time another kind of thing becomes commentable (on MariaDB, on a big table, that is the change the studio already warns about), while a new link table is only ever added; a column on `posts` puts comments machinery into her content table, where the app's Add form and the data API's field list would show it; and a real foreign key on each side gives real on-delete -- delete a post and the link, the thread and its comments go with it, which a `content_type`/`content_id` pair could never do. | Claude |
| C12 | **Pages are the honest exception.** A thread with content type `page` and content id `/about.html` has no link row, because her website's pages are not a table in anybody's database. Everything else about it is the same. | Claude |
| C13 | **The public read is keyless and carries the forms API's rules unchanged**: approved only, only the fields marked "Show publicly", never the email, the address it came from, whether she has read it or which page it was sent from; an ETag so a page polling it costs a 304; the open allowance (120 a minute an address); and `decide()` on both the read and the write, so comments on a page inside a protected folder are as private as the page. | Claude |
| C14 | **A counts route**, `GET /_pammy/comments/<area>/counts?content=1,2,3`. A blog index showing "3 comments" under twenty posts must cost one request, not twenty. | Claude |
| C15 | **"Wait for my OK" is forced on for comment areas until the Turnstile CAPTCHA is in.** Comments are the most exposed thing the panel has ever offered: a write from anyone, on every page, for ever. The honeypot, 10 an hour and the unread caps are what stands there today, and auto-approve's own plan says in writing that junk can get through until the CAPTCHA lands. "Show right away" on a contact form is a small bet; on every page of her website it is not. | Claude |
| C16 | **Flat in the first version.** No replies. `parent_id` is the easy part; what is not easy is moderating a reply to something not approved yet, ordering a tree, and saying any of it in her words. "In reply to" can be a switch later. | Claude |
| C17 | **Nobody edits or deletes their own comment.** There is no identity behind an anonymous name to check it against. A visitor who is signed in could, later; for now, she can hide anything. | Claude |
| C18 | **Who may comment** reuses what forms already have: anyone, or signed-in visitors only. A signed-in visitor's name comes from the session (`signedInAs`); everyone else answers a Name question, which is text and nothing more -- no claim is made that two "Olivia"s are different people. | Claude |
| C19 | **Nothing is emailed**, as everywhere else. New comments are unread, and unread is the red dot. This is more of a cost here than it is for forms -- a conversation can wait a week -- and it is worth a line in her guide rather than a silent surprise. | Claude |

## 2. On her page

```html
<script src="/_pammy/comments.js" defer></script>

<!-- a blog post -->
<pammy-comments name="blog-comments" content-id="12"></pammy-comments>

<!-- any ordinary page: the path is the content id -->
<pammy-comments name="page-comments"></pammy-comments>
```

`content-id` is a reactive property, because her blog page draws itself from the data API and
only learns the post id after the first request -- `el.setAttribute('content-id', post.id)`
has to load that thread, and changing it has to load the other one.

Wording attributes, as forms: `heading`, `intro`, `button`, `sent-text`, `empty-text`,
`closed-text`, `loading-text`, `more-text`. Classes: `pammy-comments`, `pammy-comment-count`,
`pammy-comment-list`, `pammy-comment`, `pammy-comment-author`, `pammy-comment-when`,
`pammy-comment-body`, `pammy-comment-form`, `pammy-more`. `order="newest|oldest"`, `per="20"`.

The comment box inside it **is** `<pammy-form>` -- the same element, the same fields, the same
sending. `comments.js` carries both and guards its `customElements.define`, so a page with a
form and a comment area does not end up with two copies of the same element.

## 3. The gate

```
GET  /_pammy/comments.js
GET  /_pammy/comments/<area>?content=<id>&order=newest&after=<cursor>
POST /_pammy/comments/<area>              { content, answers }  -- a form send with a thread
GET  /_pammy/comments/<area>/counts?content=1,2,3
```

Underneath, every one of these is the forms code with a filter on the thread. `addResponse`
learns two more columns; `queryResponses` learns to filter by them. The answer is shaped like
the `/approved` answer so that anyone who has read guide 10 already knows how to draw it.

Data: `forms` gains `kind` and the area's content type; `responses` gains `content_type` and
`content_id`, indexed together with `form_id`. No new table in the gate.

## 4. The panel

**Comments** (Inbox > Comments), two levels:

- *Waiting*: everything unapproved across every area, newest first, each one showing the
  comment, who wrote it, and the page or record it is on, with a link to go and look at it.
  Approve and Hide, from the list.
- *A conversation*: one thread in order, with the content's title (a record's title field, or
  the page's path), for when she wants to read the whole thing.
- *Areas*: the settings -- what it asks, who may comment, which app and content type, open or
  closed. The same builder components as Forms, with the question list cut down.

**Database Manager**: the two switches in C8 and C10. Both put their tables in the draft and
take her to Review; both are undone the way any other change is. Turning C10 back off would
drop a table with her visitors' words in it, so it goes through the destructive-change
warning that Apply already shows, saying how many comments.

The tables' kinds are the ones `kindOf` already names: `comments` is a **thing** she may
browse and edit, `comment_threads` is **machinery** (offered, off unless she ticks it), the
link tables are **connections**.

## 5. The tables the switches draw

```text
comment_threads    id, area (short text), content_type (short text), content_id (short text),
                   open (yes/no, starts yes), comments (whole number, starts 0),
                   last_at (date and time)
comments           id, thread_id -> comment_threads (delete with the thread, required),
                   author (short text), body (text), approved (yes/no, starts no),
                   sent_at (date and time),
                   response_id (whole number, all different)   <- so a comment is copied once

post_comment_threads   post_id -> posts (delete the link with the post),
                       thread_id -> comment_threads (delete with the thread),
                       one row per post
```

`response_id` being "all different" is F11 in a column: approving, unapproving and approving
again writes one row, not three.

## 6. Phases

1. **It works on any page.** Form kind, thread columns, the three routes, `<pammy-comments>`.
   No database, no switches -- point 3 finished on its own.
2. **The Comments page**, the waiting count, the red dot, the area settings.
3. **The tables** (C8, C9): the app switch, the draft, the area and the link, through the
   form-to-database machinery that already exists.
4. **Commentable resources** (C10): the per-resource switch, the link table, and the data API
   answering a post with its comment count.
5. **Later**: replies, letting her know, comment counts on the app's list pages.

## 7. Tests

- Unit: the thread key on a send; an area attached to a table refusing an empty `content-id`;
  the counts route; public fields only, on both the list and the counts.
- Gate: a comment on a page inside a protected folder is refused to a visitor who may not open
  the page, on both the read and the write; the honeypot and the hourly limit run before
  anything is written; an approved comment reaches the table once, however many times it is
  approved.
- Studio: both switches produce a draft that Apply can run on Postgres and MariaDB; deleting a
  post takes its link, its thread and its comments; turning the resource switch off warns with
  a count.
- Browser: comment on a blog post from a page, see it waiting in the panel, approve it, see it
  on the page; comment on an ordinary page with no database anywhere.

## 8. Open questions

- **Q1.** Comments on their own page (recommended, C6), or a filter inside Responses?
- **Q2.** Should `app` and `content-type` be allowed on the element after all, as overrides, so
  one area can serve several content types? *(Claude: no in the first version -- one area per
  kind of thing is one idea, and the attributes can be added later without breaking a page.)*
- **Q3.** Does an area belong to a database at all, or does the link (C9) belong to the
  resource? Asked differently: one `comments` table per app, or per commentable thing?
  *(Claude: one per app. Moderating is one query, and the link tables keep the joins honest.)*
- **Q4.** Turnstile first, or comments first with C15? *(Claude: Turnstile first if it is close.
  This feature is the reason it exists.)*
- **Q5.** What does the Comments page call a thread, in her words? "The comments on *Lemon
  drizzle loaf*" reads well and "thread" does not.
- **Q6.** When a post is deleted, its comments go (C11). Is that right, or should she be asked?
  *(Claude: they go, and the warning before Apply says how many.)*

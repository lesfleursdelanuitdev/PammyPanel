CREATE SCHEMA catalog;
ALTER SCHEMA catalog OWNER TO pammy_owner;
CREATE SCHEMA files;
ALTER SCHEMA files OWNER TO pammy_owner;
CREATE SCHEMA gate;
ALTER SCHEMA gate OWNER TO pammy_owner;
CREATE SCHEMA media;
ALTER SCHEMA media OWNER TO pammy_owner;
CREATE SCHEMA panel;
ALTER SCHEMA panel OWNER TO pammy_owner;
CREATE SCHEMA thumbs;
ALTER SCHEMA thumbs OWNER TO pammy_owner;
CREATE FUNCTION catalog.check_item_key() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM catalog.links x JOIN catalog.labels l ON l.id = x.label_id
              WHERE x.item_id = NEW.id AND NOT catalog.label_fits(l.scope_id, NEW.id)) THEN
    RAISE EXCEPTION 'move the labels to the new scope first' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
ALTER FUNCTION catalog.check_item_key() OWNER TO pammy_owner;
CREATE FUNCTION catalog.check_label_scope() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM catalog.links x WHERE x.label_id = NEW.id AND NOT catalog.label_fits(NEW.scope_id, x.item_id)) THEN
    RAISE EXCEPTION 'files in another scope still have this label' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
ALTER FUNCTION catalog.check_label_scope() OWNER TO pammy_owner;
CREATE FUNCTION catalog.check_link() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  IF NOT catalog.label_fits((SELECT scope_id FROM catalog.labels WHERE id = NEW.label_id), NEW.item_id) THEN
    IF (SELECT kind FROM catalog.labels WHERE id = NEW.label_id) = 'tag' THEN
      RAISE EXCEPTION 'a tag only goes on files in its own scope' USING ERRCODE = 'check_violation';
    END IF;
    RAISE EXCEPTION 'a category only goes on files in its own scope' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION catalog.check_link() OWNER TO pammy_owner;
CREATE FUNCTION catalog.check_scope_path() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM catalog.labels l JOIN catalog.links x ON x.label_id = l.id
              WHERE l.scope_id = NEW.id AND NOT catalog.label_fits(NEW.id, x.item_id)) THEN
    RAISE EXCEPTION 'files in another scope still have this label' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
ALTER FUNCTION catalog.check_scope_path() OWNER TO pammy_owner;
CREATE FUNCTION catalog.drop_source(source bigint) RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
DECLARE n integer;
BEGIN
  DELETE FROM catalog.labels WHERE scope_id IN (SELECT id FROM catalog.scopes WHERE source_id = source);
  DELETE FROM catalog.items WHERE resource_id IN (SELECT id FROM catalog.resources WHERE source_id = source);
  DELETE FROM catalog.sources WHERE id = source;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
ALTER FUNCTION catalog.drop_source(source bigint) OWNER TO pammy_owner;
CREATE FUNCTION catalog.path_under(scope_path text, key text) RETURNS boolean
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    RETURN ((scope_path = '/'::text) OR (key = substr(scope_path, 2)) OR starts_with(key, (substr(scope_path, 2) || '/'::text)));
ALTER FUNCTION catalog.path_under(scope_path text, key text) OWNER TO pammy_owner;
CREATE TABLE catalog.items (
    id bigint NOT NULL,
    resource_id bigint NOT NULL,
    key text NOT NULL,
    scope_id bigint NOT NULL,
    kind text NOT NULL,
    title text,
    state text DEFAULT 'present'::text NOT NULL,
    state_at bigint,
    changed_at bigint NOT NULL,
    CONSTRAINT items_key_check CHECK (((length(key) >= 1) AND (length(key) <= 4096))),
    CONSTRAINT items_kind_check CHECK ((kind ~ '^[a-z][a-z0-9-]{0,31}$'::text)),
    CONSTRAINT items_state_check CHECK ((state = ANY (ARRAY['present'::text, 'trashed'::text, 'missing'::text])))
);
ALTER TABLE catalog.items OWNER TO pammy_owner;
CREATE TABLE catalog.resources (
    id bigint NOT NULL,
    source_id bigint NOT NULL,
    key text NOT NULL,
    label text NOT NULL,
    list_path text,
    open_url text,
    scopes_field text,
    uses jsonb DEFAULT '{}'::jsonb NOT NULL,
    visitor_labels text DEFAULT 'none'::text NOT NULL,
    visitor_new_labels boolean DEFAULT false NOT NULL,
    CONSTRAINT resources_key_check CHECK ((key ~ '^[a-z][a-z0-9-]{0,39}$'::text)),
    CONSTRAINT resources_label_check CHECK (((length(label) >= 1) AND (length(label) <= 200))),
    CONSTRAINT resources_list_path_check CHECK (((list_path IS NULL) OR (((length(list_path) >= 1) AND (length(list_path) <= 200)) AND ("left"(list_path, 1) = '/'::text)))),
    CONSTRAINT resources_open_url_check CHECK (((open_url IS NULL) OR (length(open_url) <= 500))),
    CONSTRAINT resources_scopes_field_check CHECK (((scopes_field IS NULL) OR (length(scopes_field) <= 40))),
    CONSTRAINT resources_visitor_labels_check CHECK ((visitor_labels = ANY (ARRAY['none'::text, 'personal'::text, 'shared'::text, 'both'::text])))
);
ALTER TABLE catalog.resources OWNER TO pammy_owner;
CREATE TABLE catalog.scopes (
    id bigint NOT NULL,
    parent_id bigint,
    source_id bigint,
    path text,
    label text NOT NULL,
    automatic boolean DEFAULT false NOT NULL,
    created_at bigint NOT NULL,
    created_by text,
    CONSTRAINT scopes_check CHECK (((parent_id IS NULL) = (source_id IS NULL))),
    CONSTRAINT scopes_check1 CHECK (((source_id IS NULL) = (path IS NULL))),
    CONSTRAINT scopes_label_check CHECK (((length(label) >= 1) AND (length(label) <= 400))),
    CONSTRAINT scopes_path_check CHECK (((path IS NULL) OR (path = '/'::text) OR ((length(path) >= 2) AND ("left"(path, 1) = '/'::text) AND ("right"(path, 1) <> '/'::text) AND (strpos(path, '//'::text) = 0))))
);
ALTER TABLE catalog.scopes OWNER TO pammy_owner;
CREATE FUNCTION catalog.label_fits(label_scope bigint, item bigint) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO ''
    RETURN (SELECT ((s.parent_id IS NULL) OR ((s.source_id = r.source_id) AND catalog.path_under(s.path, i.key))) FROM catalog.scopes s, (catalog.items i JOIN catalog.resources r ON ((r.id = i.resource_id))) WHERE ((s.id = label_fits.label_scope) AND (i.id = label_fits.item)));
ALTER FUNCTION catalog.label_fits(label_scope bigint, item bigint) OWNER TO pammy_owner;
CREATE FUNCTION files.check_record() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
DECLARE
  r record;
  want text;
  rid bigint;
BEGIN
  IF TG_TABLE_NAME = 'items' THEN rid := NEW.id; ELSE rid := NEW.item_id; END IF;
  SELECT i.key, i.state, s.path AS scope, f.item_id, f.name, f.trash_id INTO r
    FROM catalog.items i JOIN catalog.scopes s ON s.id = i.scope_id LEFT JOIN files.files f ON f.item_id = i.id
   WHERE i.id = rid AND i.resource_id = 1;
  IF NOT FOUND THEN RETURN NULL; END IF;       -- (not the website's file, or deleted since)
  IF r.item_id IS NULL THEN
    RAISE EXCEPTION 'a file''s record has no file columns: %', r.key USING ERRCODE = 'check_violation';
  END IF;
  want := CASE WHEN strpos(r.key, '/') = 0 OR left(r.key, 6) = 'media/' THEN '/' ELSE '/' || left(r.key, strpos(r.key, '/') - 1) END;
  IF r.scope <> want OR NOT (r.key = r.name OR right(r.key, length(r.name) + 1) = '/' || r.name) THEN
    RAISE EXCEPTION 'a file''s record disagrees with its path (check constraint): %', r.key USING ERRCODE = 'check_violation';
  END IF;
  IF (r.state = 'trashed') <> (r.trash_id IS NOT NULL) THEN
    RAISE EXCEPTION 'a trashed file needs its trash id, and only a trashed one has one (check constraint): %', r.key USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
ALTER FUNCTION files.check_record() OWNER TO pammy_owner;
CREATE TABLE gate.role_sets (
    id bigint NOT NULL,
    key text,
    label text NOT NULL,
    built_in boolean DEFAULT false NOT NULL,
    created_at bigint NOT NULL,
    signed_in_role_id bigint,
    manifest text,
    manifest_read_at bigint,
    area_id bigint,
    copied_from bigint,
    CONSTRAINT role_sets_check CHECK ((built_in = (key IS NOT NULL))),
    CONSTRAINT role_sets_copy_of_area CHECK (((NOT built_in) OR (area_id IS NULL))),
    CONSTRAINT role_sets_key_check CHECK (((key IS NULL) OR (key ~ '^[a-z][a-z0-9-]{0,63}$'::text))),
    CONSTRAINT role_sets_label_check CHECK (((length(label) >= 1) AND (length(label) <= 80))),
    CONSTRAINT role_sets_manifest_read CHECK (((manifest IS NULL) = (manifest_read_at IS NULL)))
);
ALTER TABLE gate.role_sets OWNER TO pammy_owner;
CREATE FUNCTION gate.built_in_set(k text) RETURNS bigint
    LANGUAGE sql STABLE
    RETURN (SELECT role_sets.id FROM gate.role_sets WHERE (role_sets.key = built_in_set.k));
ALTER FUNCTION gate.built_in_set(k text) OWNER TO pammy_owner;
CREATE FUNCTION gate.note_deleted_account() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO gate.deleted_accounts (visitor_id, username, deleted_at, next_at)
  VALUES (OLD.id, OLD.username, extract(epoch FROM now())::bigint, extract(epoch FROM now())::bigint)
  ON CONFLICT (visitor_id) DO NOTHING;
  RETURN OLD;
END $$;
ALTER FUNCTION gate.note_deleted_account() OWNER TO pammy_owner;
CREATE FUNCTION panel.hosts_home_domain() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.domain_id IS NULL THEN
    NEW.domain_id := (SELECT id FROM panel.domains WHERE home);
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION panel.hosts_home_domain() OWNER TO pammy_owner;
CREATE FUNCTION panel.studio_resource_gone() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  IF OLD.catalog_source IS NOT NULL THEN PERFORM catalog.drop_source(OLD.catalog_source); END IF;
  RETURN NULL;
END $$;
ALTER FUNCTION panel.studio_resource_gone() OWNER TO pammy_owner;
ALTER TABLE catalog.items ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME catalog.items_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE catalog.labels (
    id bigint NOT NULL,
    scope_id bigint NOT NULL,
    kind text NOT NULL,
    name text NOT NULL,
    public boolean DEFAULT false NOT NULL,
    created_at bigint NOT NULL,
    created_by text,
    CONSTRAINT labels_kind_check CHECK ((kind = ANY (ARRAY['tag'::text, 'category'::text]))),
    CONSTRAINT labels_name_check CHECK ((((length(name) >= 1) AND (length(name) <= 40)) AND (name !~ '[^a-z0-9-]'::text)))
);
ALTER TABLE catalog.labels OWNER TO pammy_owner;
ALTER TABLE catalog.labels ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME catalog.labels_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE catalog.links (
    item_id bigint NOT NULL,
    label_id bigint NOT NULL,
    made_by text,
    made_at bigint
);
ALTER TABLE catalog.links OWNER TO pammy_owner;
ALTER TABLE catalog.resources ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME catalog.resources_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
ALTER TABLE catalog.scopes ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME catalog.scopes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE catalog.sources (
    id bigint NOT NULL,
    kind text NOT NULL,
    ref text NOT NULL,
    label text NOT NULL,
    created_at bigint NOT NULL,
    CONSTRAINT sources_kind_check CHECK ((kind = ANY (ARRAY['files'::text, 'studio'::text, 'app'::text]))),
    CONSTRAINT sources_label_check CHECK (((length(label) >= 1) AND (length(label) <= 200))),
    CONSTRAINT sources_ref_check CHECK (((length(ref) >= 1) AND (length(ref) <= 200)))
);
ALTER TABLE catalog.sources OWNER TO pammy_owner;
ALTER TABLE catalog.sources ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME catalog.sources_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE catalog.sync_state (
    key text NOT NULL,
    value text
);
ALTER TABLE catalog.sync_state OWNER TO pammy_owner;
CREATE TABLE files.files (
    item_id bigint NOT NULL,
    name text NOT NULL,
    size bigint NOT NULL,
    hash text,
    modified_at bigint NOT NULL,
    added_at bigint NOT NULL,
    added_by text,
    how text NOT NULL,
    trash_id text,
    alt text,
    CONSTRAINT files_how_check CHECK ((how = ANY (ARRAY['uploaded'::text, 'copied'::text, 'found'::text])))
);
ALTER TABLE files.files OWNER TO pammy_owner;
CREATE TABLE files.imported_notes (
    path text NOT NULL,
    added_by text NOT NULL,
    added_at bigint NOT NULL,
    how text NOT NULL,
    CONSTRAINT imported_notes_how_check CHECK ((how = ANY (ARRAY['uploaded'::text, 'copied'::text])))
);
ALTER TABLE files.imported_notes OWNER TO pammy_owner;
CREATE VIEW files.records AS
 SELECT i.id,
    i.key AS path,
    s.path AS scope,
    i.kind,
    f.name,
    f.size,
    f.hash,
    f.modified_at,
    f.added_at,
    f.added_by,
    f.how,
    i.state,
    i.state_at,
    f.trash_id,
    i.changed_at,
    i.title,
    f.alt
   FROM ((catalog.items i
     JOIN files.files f ON ((f.item_id = i.id)))
     JOIN catalog.scopes s ON ((s.id = i.scope_id)))
  WHERE (i.resource_id = 1);
ALTER VIEW files.records OWNER TO pammy_owner;
CREATE TABLE gate.actions (
    role_set_id bigint NOT NULL,
    key text NOT NULL,
    label text NOT NULL,
    CONSTRAINT actions_key_check CHECK (((key ~ '^[a-z][a-z0-9-]{0,31}$'::text) AND (key <> ALL (ARRAY['read'::text, 'create'::text, 'update'::text, 'delete'::text])))),
    CONSTRAINT actions_label_check CHECK (((length(label) >= 1) AND (length(label) <= 80)))
);
ALTER TABLE gate.actions OWNER TO pammy_owner;
CREATE TABLE gate.api_keys (
    id bigint NOT NULL,
    label text NOT NULL,
    prefix text NOT NULL,
    key_hash text NOT NULL,
    level text NOT NULL,
    forms text NOT NULL,
    created_at bigint NOT NULL,
    created_by text,
    last_used_at bigint,
    revoked_at bigint,
    revoked_by text,
    media text DEFAULT 'null'::text NOT NULL,
    CONSTRAINT api_keys_level_check CHECK ((level = ANY (ARRAY['approved'::text, 'all'::text])))
);
ALTER TABLE gate.api_keys OWNER TO pammy_owner;
ALTER TABLE gate.api_keys ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME gate.api_keys_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE gate.areas (
    id bigint NOT NULL,
    token text NOT NULL,
    path text NOT NULL,
    created_at bigint NOT NULL,
    requests_open integer DEFAULT 1 NOT NULL,
    role_set_id bigint DEFAULT gate.built_in_set('protected-folder'::text) NOT NULL,
    kind text DEFAULT 'folder'::text NOT NULL,
    route_id bigint,
    label text,
    CONSTRAINT areas_kind_check CHECK ((kind = ANY (ARRAY['folder'::text, 'route'::text]))),
    CONSTRAINT areas_kind_check2 CHECK ((((kind = 'folder'::text) AND (route_id IS NULL) AND (path !~ '^/'::text)) OR ((kind = 'route'::text) AND (route_id IS NOT NULL) AND (path = ('/route/'::text || route_id))))),
    CONSTRAINT areas_label_check CHECK (((label IS NULL) OR ((length(label) >= 1) AND (length(label) <= 300))))
);
ALTER TABLE gate.areas OWNER TO pammy_owner;
ALTER TABLE gate.areas ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME gate.areas_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE gate.deleted_accounts (
    visitor_id bigint NOT NULL,
    username text NOT NULL,
    deleted_at bigint NOT NULL,
    told text[] DEFAULT '{}'::text[] NOT NULL,
    tries integer DEFAULT 0 NOT NULL,
    next_at bigint NOT NULL,
    last_error text
);
ALTER TABLE gate.deleted_accounts OWNER TO pammy_owner;
CREATE TABLE gate.events (
    id bigint NOT NULL,
    at bigint NOT NULL,
    visitor_id bigint,
    username text,
    area_id bigint,
    event text NOT NULL,
    host text,
    ip text
);
ALTER TABLE gate.events OWNER TO pammy_owner;
ALTER TABLE gate.events ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME gate.events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE gate.form_links (
    form_id bigint NOT NULL,
    database_id bigint NOT NULL,
    engine text NOT NULL,
    name text NOT NULL,
    table_name text NOT NULL,
    write_when text NOT NULL,
    pairs text NOT NULL,
    fixed text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    updated_at bigint NOT NULL,
    updated_by text,
    mode text DEFAULT 'row'::text NOT NULL,
    CONSTRAINT form_links_engine_check CHECK ((engine = ANY (ARRAY['postgres'::text, 'mariadb'::text]))),
    CONSTRAINT form_links_mode_check CHECK ((mode = ANY (ARRAY['row'::text, 'comments'::text]))),
    CONSTRAINT form_links_name_check CHECK ((name ~ '^[a-z][a-z0-9_]{0,62}$'::text)),
    CONSTRAINT form_links_table_name_check CHECK ((table_name ~ '^[a-z][a-z0-9_]{0,62}$'::text)),
    CONSTRAINT form_links_write_when_check CHECK ((write_when = ANY (ARRAY['approved'::text, 'arrived'::text])))
);
ALTER TABLE gate.form_links OWNER TO pammy_owner;
CREATE TABLE gate.form_pages (
    form_id bigint NOT NULL,
    page text NOT NULL,
    last_seen bigint NOT NULL
);
ALTER TABLE gate.form_pages OWNER TO pammy_owner;
CREATE TABLE gate.forms (
    id bigint NOT NULL,
    name text NOT NULL,
    title text NOT NULL,
    items text NOT NULL,
    settings text NOT NULL,
    used_keys text DEFAULT '[]'::text NOT NULL,
    enabled integer DEFAULT 1 NOT NULL,
    approvable integer DEFAULT 0 NOT NULL,
    public_approved integer DEFAULT 0 NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    created_at bigint NOT NULL,
    created_by text,
    updated_at bigint NOT NULL,
    updated_by text,
    trashed_at bigint,
    trashed_by text,
    fixture text,
    auto_approve integer DEFAULT 0 NOT NULL,
    scope text DEFAULT '/'::text NOT NULL,
    kind text DEFAULT 'form'::text NOT NULL,
    content_type text DEFAULT 'page'::text NOT NULL,
    CONSTRAINT forms_content_type_check CHECK (((content_type = 'page'::text) OR (content_type ~ '^[a-z][a-z0-9_]{0,62}$'::text))),
    CONSTRAINT forms_kind_check CHECK ((kind = ANY (ARRAY['form'::text, 'comments'::text])))
);
ALTER TABLE gate.forms OWNER TO pammy_owner;
ALTER TABLE gate.forms ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME gate.forms_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE gate.group_privileges (
    group_id bigint NOT NULL,
    privilege text NOT NULL,
    CONSTRAINT group_privileges_privilege_check CHECK ((privilege ~ '^[a-z][a-z0-9-]{0,31}\.[a-z][a-z0-9-]{0,31}(:(own|any))?$'::text))
);
ALTER TABLE gate.group_privileges OWNER TO pammy_owner;
CREATE TABLE gate.groups (
    id bigint NOT NULL,
    role_set_id bigint NOT NULL,
    key text NOT NULL,
    label text NOT NULL,
    CONSTRAINT groups_key_check CHECK ((key ~ '^[a-z][a-z0-9-]{0,63}$'::text)),
    CONSTRAINT groups_label_check CHECK (((length(label) >= 1) AND (length(label) <= 80)))
);
ALTER TABLE gate.groups OWNER TO pammy_owner;
ALTER TABLE gate.groups ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME gate.groups_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE gate.links (
    id bigint NOT NULL,
    token_hash text NOT NULL,
    visitor_id bigint NOT NULL,
    area_id bigint,
    created_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    used_at bigint,
    cancelled_at bigint,
    purpose text DEFAULT 'setup'::text NOT NULL,
    new_email text,
    CONSTRAINT links_email_change_check CHECK (((purpose = 'email-change'::text) = (new_email IS NOT NULL))),
    CONSTRAINT links_new_email_check CHECK (((new_email IS NULL) OR ((new_email = lower(new_email)) AND (length(new_email) <= 254)))),
    CONSTRAINT links_purpose_check CHECK ((purpose = ANY (ARRAY['setup'::text, 'confirm'::text, 'reset'::text, 'email-change'::text])))
);
ALTER TABLE gate.links OWNER TO pammy_owner;
ALTER TABLE gate.links ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME gate.links_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE gate.memberships (
    visitor_id bigint NOT NULL,
    area_id bigint NOT NULL,
    role_set_id bigint NOT NULL,
    role_id bigint NOT NULL,
    created_at bigint NOT NULL
);
ALTER TABLE gate.memberships OWNER TO pammy_owner;
CREATE TABLE gate.never_together (
    role_set_id bigint NOT NULL,
    role_a bigint NOT NULL,
    role_b bigint NOT NULL,
    from_manifest boolean DEFAULT false NOT NULL,
    CONSTRAINT never_together_check CHECK ((role_a < role_b))
);
ALTER TABLE gate.never_together OWNER TO pammy_owner;
CREATE TABLE gate.record_labels (
    database_id bigint NOT NULL,
    table_name text NOT NULL,
    key text NOT NULL,
    kind text NOT NULL,
    name text NOT NULL,
    public boolean NOT NULL,
    CONSTRAINT record_labels_key_check CHECK (((length(key) >= 1) AND (length(key) <= 4096))),
    CONSTRAINT record_labels_kind_check CHECK ((kind = ANY (ARRAY['tag'::text, 'category'::text]))),
    CONSTRAINT record_labels_name_check CHECK ((((length(name) >= 1) AND (length(name) <= 40)) AND (name !~ '[^a-z0-9-]'::text))),
    CONSTRAINT record_labels_table_name_check CHECK ((table_name ~ '^[a-z][a-z0-9_]{0,62}$'::text))
);
ALTER TABLE gate.record_labels OWNER TO pammy_owner;
CREATE TABLE gate.record_touches (
    id bigint NOT NULL,
    database_id bigint NOT NULL,
    table_name text NOT NULL,
    key text,
    what text NOT NULL,
    at bigint NOT NULL,
    CONSTRAINT record_touches_key_check CHECK (((key IS NULL) OR ((length(key) >= 1) AND (length(key) <= 4096)))),
    CONSTRAINT record_touches_table_name_check CHECK ((table_name ~ '^[a-z][a-z0-9_]{0,62}$'::text)),
    CONSTRAINT record_touches_what_check CHECK ((what = ANY (ARRAY['changed'::text, 'deleted'::text])))
);
ALTER TABLE gate.record_touches OWNER TO pammy_owner;
ALTER TABLE gate.record_touches ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME gate.record_touches_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE gate.requests (
    id bigint NOT NULL,
    kind text NOT NULL,
    area_id bigint,
    visitor_id bigint,
    name text DEFAULT ''::text NOT NULL,
    contact text DEFAULT ''::text NOT NULL,
    message text DEFAULT ''::text NOT NULL,
    host text,
    ip text,
    created_at bigint NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    handled_at bigint,
    handled_by text,
    CONSTRAINT requests_kind_check CHECK ((kind = ANY (ARRAY['access'::text, 'reset'::text]))),
    CONSTRAINT requests_status_check CHECK ((status = ANY (ARRAY['open'::text, 'done'::text, 'declined'::text])))
);
ALTER TABLE gate.requests OWNER TO pammy_owner;
ALTER TABLE gate.requests ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME gate.requests_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE gate.resource_actions (
    resource_id bigint NOT NULL,
    action text NOT NULL,
    CONSTRAINT resource_actions_action_check CHECK ((action ~ '^[a-z][a-z0-9-]{0,31}$'::text))
);
ALTER TABLE gate.resource_actions OWNER TO pammy_owner;
CREATE TABLE gate.resources (
    id bigint NOT NULL,
    role_set_id bigint NOT NULL,
    key text NOT NULL,
    label text NOT NULL,
    owned boolean DEFAULT false NOT NULL,
    CONSTRAINT resources_key_check CHECK (((key ~ '^[a-z][a-z0-9-]{0,31}$'::text) AND (key <> 'pages'::text))),
    CONSTRAINT resources_label_check CHECK (((length(label) >= 1) AND (length(label) <= 80)))
);
ALTER TABLE gate.resources OWNER TO pammy_owner;
ALTER TABLE gate.resources ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME gate.resources_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE gate.response_saves (
    response_id bigint NOT NULL,
    saved_to text,
    save_problem text,
    save_retry boolean DEFAULT false NOT NULL,
    save_tries bigint DEFAULT 0 NOT NULL,
    save_claimed_at bigint,
    save_state text DEFAULT 'waiting'::text NOT NULL,
    save_tried_at bigint,
    CONSTRAINT response_saves_save_state_check CHECK ((save_state = ANY (ARRAY['waiting'::text, 'saved'::text, 'problem'::text, 'retrying'::text, 'unsure'::text])))
);
ALTER TABLE gate.response_saves OWNER TO pammy_owner;
CREATE TABLE gate.response_values (
    response_id bigint NOT NULL,
    form_id bigint,
    key text NOT NULL,
    value text NOT NULL
);
ALTER TABLE gate.response_values OWNER TO pammy_owner;
CREATE TABLE gate.responses (
    id bigint NOT NULL,
    form_id bigint,
    form_name text NOT NULL,
    page text NOT NULL,
    answers text NOT NULL,
    visitor_id bigint,
    visitor_username text,
    visitor_name text,
    host text,
    ip text,
    created_at bigint NOT NULL,
    read_at bigint,
    read_by text,
    trashed_at bigint,
    trashed_by text,
    approved_at bigint,
    approved_by text,
    approved_auto integer DEFAULT 0 NOT NULL,
    content_type text,
    content_id text,
    CONSTRAINT responses_content_id_check CHECK (((content_id IS NULL) OR ((length(content_id) >= 1) AND (length(content_id) <= 300))))
);
ALTER TABLE gate.responses OWNER TO pammy_owner;
ALTER TABLE gate.responses ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME gate.responses_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE gate.role_groups (
    role_id bigint NOT NULL,
    group_id bigint NOT NULL,
    role_set_id bigint NOT NULL
);
ALTER TABLE gate.role_groups OWNER TO pammy_owner;
CREATE TABLE gate.role_parts (
    role_id bigint NOT NULL,
    part_id bigint NOT NULL,
    role_set_id bigint NOT NULL,
    CONSTRAINT role_parts_check CHECK ((role_id <> part_id))
);
ALTER TABLE gate.role_parts OWNER TO pammy_owner;
CREATE TABLE gate.role_privileges (
    role_id bigint NOT NULL,
    privilege text NOT NULL,
    CONSTRAINT role_privileges_privilege_check CHECK ((privilege ~ '^[a-z][a-z0-9-]{0,31}\.[a-z][a-z0-9-]{0,31}(:(own|any))?$'::text))
);
ALTER TABLE gate.role_privileges OWNER TO pammy_owner;
CREATE VIEW gate.role_all_privileges AS
 WITH direct AS (
         SELECT role_privileges.role_id,
            role_privileges.privilege
           FROM gate.role_privileges
        UNION
         SELECT rg.role_id,
            gp.privilege
           FROM (gate.role_groups rg
             JOIN gate.group_privileges gp ON ((gp.group_id = rg.group_id)))
        )
 SELECT direct.role_id,
    direct.privilege
   FROM direct
UNION
 SELECT rp.role_id,
    d.privilege
   FROM (gate.role_parts rp
     JOIN direct d ON ((d.role_id = rp.part_id)));
ALTER VIEW gate.role_all_privileges OWNER TO pammy_owner;
ALTER TABLE gate.role_sets ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME gate.role_sets_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE gate.roles (
    id bigint NOT NULL,
    role_set_id bigint NOT NULL,
    key text NOT NULL,
    label text NOT NULL,
    slot text,
    CONSTRAINT roles_key_check CHECK ((key ~ '^[a-z][a-z0-9-]{0,63}$'::text)),
    CONSTRAINT roles_label_check CHECK (((length(label) >= 1) AND (length(label) <= 80))),
    CONSTRAINT roles_slot_check CHECK ((slot = 'not-signed-in'::text))
);
ALTER TABLE gate.roles OWNER TO pammy_owner;
ALTER TABLE gate.roles ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME gate.roles_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE gate.sessions (
    id bigint NOT NULL,
    token_hash text NOT NULL,
    visitor_id bigint NOT NULL,
    host text NOT NULL,
    created_at bigint NOT NULL,
    last_seen_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    revoked_at bigint,
    ip text
);
ALTER TABLE gate.sessions OWNER TO pammy_owner;
ALTER TABLE gate.sessions ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME gate.sessions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE gate.studio_app_keys (
    id bigint NOT NULL,
    database_id bigint NOT NULL,
    label text NOT NULL,
    prefix text NOT NULL,
    key_hash text NOT NULL,
    grants text DEFAULT '"all"'::text NOT NULL,
    can_write boolean DEFAULT false NOT NULL,
    created_at bigint NOT NULL,
    created_by text,
    last_used_at bigint,
    revoked_at bigint,
    revoked_by text
);
ALTER TABLE gate.studio_app_keys OWNER TO pammy_owner;
ALTER TABLE gate.studio_app_keys ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME gate.studio_app_keys_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE gate.studio_catalog (
    database_id bigint NOT NULL,
    engine text NOT NULL,
    name text NOT NULL,
    api_read boolean DEFAULT false NOT NULL,
    api_write boolean DEFAULT false NOT NULL,
    catalog_json text NOT NULL,
    updated_at bigint NOT NULL,
    CONSTRAINT studio_catalog_engine_check CHECK ((engine = ANY (ARRAY['postgres'::text, 'mariadb'::text]))),
    CONSTRAINT studio_catalog_name_check CHECK ((name ~ '^[a-z][a-z0-9_]{0,62}$'::text))
);
ALTER TABLE gate.studio_catalog OWNER TO pammy_owner;
CREATE TABLE gate.visitor_settings (
    id integer DEFAULT 1 NOT NULL,
    emailed_links boolean DEFAULT false NOT NULL,
    self_register boolean DEFAULT false NOT NULL,
    change_password boolean DEFAULT false NOT NULL,
    delete_account boolean DEFAULT false NOT NULL,
    open_areas boolean DEFAULT false NOT NULL,
    changed_by text,
    changed_at bigint,
    roles boolean DEFAULT false NOT NULL,
    CONSTRAINT visitor_settings_check CHECK ((emailed_links OR (NOT self_register))),
    CONSTRAINT visitor_settings_check1 CHECK ((self_register OR (NOT open_areas))),
    CONSTRAINT visitor_settings_id_check CHECK ((id = 1))
);
ALTER TABLE gate.visitor_settings OWNER TO pammy_owner;
CREATE TABLE gate.visitors (
    id bigint NOT NULL,
    username text NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    password_hash text NOT NULL,
    active integer DEFAULT 1 NOT NULL,
    created_at bigint NOT NULL,
    password_changed_at bigint NOT NULL,
    contact text DEFAULT ''::text NOT NULL,
    email text,
    email_confirmed_at bigint,
    registered boolean DEFAULT false NOT NULL,
    CONSTRAINT visitors_check CHECK (((email_confirmed_at IS NULL) OR (email IS NOT NULL))),
    CONSTRAINT visitors_email_check CHECK (((email IS NULL) OR ((email = lower(email)) AND (length(email) <= 254) AND (email ~ '^[^@[:space:]]+@[^@[:space:]]+$'::text))))
);
ALTER TABLE gate.visitors OWNER TO pammy_owner;
ALTER TABLE gate.visitors ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME gate.visitors_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE panel.activity (
    id bigint NOT NULL,
    at bigint NOT NULL,
    actor_id bigint,
    actor_label text NOT NULL,
    action text NOT NULL,
    target text,
    detail text,
    ip text
);
ALTER TABLE panel.activity OWNER TO pammy_owner;
ALTER TABLE panel.activity ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME panel.activity_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE panel.backup_settings (
    id integer DEFAULT 1 NOT NULL,
    keep_days integer DEFAULT 60 NOT NULL,
    pruned_at bigint,
    pruned_note text,
    CONSTRAINT backup_settings_id_check CHECK ((id = 1)),
    CONSTRAINT backup_settings_keep_days_check CHECK (((keep_days >= 7) AND (keep_days <= 365))),
    CONSTRAINT backup_settings_pruned_note_check CHECK ((length(pruned_note) <= 500))
);
ALTER TABLE panel.backup_settings OWNER TO pammy_owner;
CREATE TABLE panel.ceremonies (
    id_hash text NOT NULL,
    kind text NOT NULL,
    challenge text NOT NULL,
    user_id bigint,
    invite_id bigint,
    session_id bigint,
    expires_at bigint NOT NULL
);
ALTER TABLE panel.ceremonies OWNER TO pammy_owner;
CREATE TABLE panel.domains (
    id bigint NOT NULL,
    name text NOT NULL,
    home boolean DEFAULT false NOT NULL,
    dns text NOT NULL,
    front text NOT NULL,
    cert text NOT NULL,
    tls jsonb NOT NULL,
    wildcard_record boolean DEFAULT false NOT NULL,
    folder_hosts boolean DEFAULT false NOT NULL,
    zone_checked_at bigint,
    zone_readable boolean,
    created_by text,
    created_at bigint NOT NULL,
    cert_names text[] DEFAULT '{}'::text[] NOT NULL,
    CONSTRAINT domains_cert_check CHECK ((cert = ANY (ARRAY['wildcard-dns'::text, 'per-host'::text, 'cloudflare-origin'::text, 'files'::text, 'names'::text]))),
    CONSTRAINT domains_cert_names_check CHECK ((cardinality(cert_names) <= 50)),
    CONSTRAINT domains_dns_check CHECK ((dns = ANY (ARRAY['cloudflare'::text, 'dreamhost'::text, 'manual'::text]))),
    CONSTRAINT domains_front_check CHECK ((front = ANY (ARRAY['cloudflare'::text, 'direct'::text]))),
    CONSTRAINT domains_name_check CHECK (((length(name) <= 253) AND (name ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'::text))),
    CONSTRAINT domains_names_cert_check CHECK (((cert = 'names'::text) = (cardinality(cert_names) > 0))),
    CONSTRAINT domains_tls_check CHECK (((jsonb_typeof(tls) = 'object'::text) AND (tls ? 'cert'::text) AND (tls ? 'key'::text)))
);
ALTER TABLE panel.domains OWNER TO pammy_owner;
ALTER TABLE panel.domains ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME panel.domains_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE panel.first_steps (
    user_id bigint NOT NULL,
    read_at bigint,
    hidden_at bigint
);
ALTER TABLE panel.first_steps OWNER TO pammy_owner;
CREATE TABLE panel.git_tokens (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    label text NOT NULL,
    hash text NOT NULL,
    hint text NOT NULL,
    created_at bigint NOT NULL,
    expires_at bigint,
    last_used_at bigint,
    CONSTRAINT git_tokens_hash_check CHECK ((hash ~ '^[A-Za-z0-9_-]{43}$'::text)),
    CONSTRAINT git_tokens_hint_check CHECK ((hint ~ '^[A-Za-z0-9_-]{4}$'::text)),
    CONSTRAINT git_tokens_label_check CHECK (((length(label) >= 1) AND (length(label) <= 60)))
);
ALTER TABLE panel.git_tokens OWNER TO pammy_owner;
ALTER TABLE panel.git_tokens ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME panel.git_tokens_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE panel.hosts (
    id bigint NOT NULL,
    name text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_by text,
    created_at bigint NOT NULL,
    with_www boolean DEFAULT false NOT NULL,
    adopted boolean DEFAULT false NOT NULL,
    domain_id bigint,
    origin text DEFAULT 'hand'::text NOT NULL,
    CONSTRAINT hosts_name_check CHECK (((name = '@'::text) OR (name ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'::text))),
    CONSTRAINT hosts_origin_check CHECK ((origin = ANY (ARRAY['hand'::text, 'folder'::text, 'adopted'::text]))),
    CONSTRAINT hosts_with_www_check CHECK (((NOT with_www) OR (name = '@'::text)))
);
ALTER TABLE panel.hosts OWNER TO pammy_owner;
ALTER TABLE panel.hosts ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME panel.hosts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE panel.invites (
    id bigint NOT NULL,
    token_hash text NOT NULL,
    user_id bigint NOT NULL,
    created_by bigint,
    created_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    used_at bigint,
    cancelled_at bigint
);
ALTER TABLE panel.invites OWNER TO pammy_owner;
ALTER TABLE panel.invites ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME panel.invites_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE panel.mail_notices (
    id integer DEFAULT 1 NOT NULL,
    forms text DEFAULT '[]'::text NOT NULL,
    comment_areas text DEFAULT '[]'::text NOT NULL,
    requests boolean DEFAULT false NOT NULL,
    seen_response bigint,
    seen_request bigint,
    last_sent_at bigint,
    last_problem text,
    last_problem_at bigint,
    changed_by text,
    changed_at bigint,
    CONSTRAINT mail_notices_id_check CHECK ((id = 1))
);
ALTER TABLE panel.mail_notices OWNER TO pammy_owner;
CREATE TABLE panel.monitor_baseline (
    key text NOT NULL,
    value text NOT NULL,
    since bigint NOT NULL,
    CONSTRAINT monitor_baseline_key_check CHECK ((key ~ '^[a-z0-9-]{1,40}$'::text)),
    CONSTRAINT monitor_baseline_value_check CHECK ((length(value) <= 4000))
);
ALTER TABLE panel.monitor_baseline OWNER TO pammy_owner;
CREATE TABLE panel.monitor_checks (
    key text NOT NULL,
    grp text NOT NULL,
    subject text NOT NULL,
    label text NOT NULL,
    state text NOT NULL,
    fails integer DEFAULT 0 NOT NULL,
    since bigint NOT NULL,
    last_at bigint NOT NULL,
    why text DEFAULT ''::text NOT NULL,
    link text,
    reminded_at bigint,
    CONSTRAINT monitor_checks_fails_check CHECK ((fails >= 0)),
    CONSTRAINT monitor_checks_grp_check CHECK ((grp ~ '^[a-z]{1,20}$'::text)),
    CONSTRAINT monitor_checks_key_check CHECK ((length(key) <= 300)),
    CONSTRAINT monitor_checks_label_check CHECK ((length(label) <= 300)),
    CONSTRAINT monitor_checks_link_check CHECK ((length(link) <= 300)),
    CONSTRAINT monitor_checks_state_check CHECK ((state = ANY (ARRAY['up'::text, 'down'::text, 'warn'::text, 'stopped'::text]))),
    CONSTRAINT monitor_checks_subject_check CHECK ((length(subject) <= 300)),
    CONSTRAINT monitor_checks_why_check CHECK ((length(why) <= 500))
);
ALTER TABLE panel.monitor_checks OWNER TO pammy_owner;
CREATE TABLE panel.monitor_events (
    id bigint NOT NULL,
    key text NOT NULL,
    label text NOT NULL,
    kind text NOT NULL,
    why text DEFAULT ''::text NOT NULL,
    at bigint NOT NULL,
    mail text DEFAULT 'no'::text NOT NULL,
    CONSTRAINT monitor_events_kind_check CHECK ((kind = ANY (ARRAY['down'::text, 'back'::text, 'warn'::text, 'stopped'::text, 'started'::text, 'still-down'::text]))),
    CONSTRAINT monitor_events_mail_check CHECK ((mail = ANY (ARRAY['sent'::text, 'held'::text, 'no'::text, 'quiet'::text])))
);
ALTER TABLE panel.monitor_events OWNER TO pammy_owner;
ALTER TABLE panel.monitor_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME panel.monitor_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE panel.monitor_mail (
    day date NOT NULL,
    sent integer DEFAULT 0 NOT NULL,
    held integer DEFAULT 0 NOT NULL
);
ALTER TABLE panel.monitor_mail OWNER TO pammy_owner;
CREATE TABLE panel.monitor_quiet (
    id bigint NOT NULL,
    subject text NOT NULL,
    until bigint NOT NULL,
    created_by text,
    created_at bigint NOT NULL,
    ended_at bigint,
    CONSTRAINT monitor_quiet_subject_check CHECK ((length(subject) <= 300))
);
ALTER TABLE panel.monitor_quiet OWNER TO pammy_owner;
ALTER TABLE panel.monitor_quiet ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME panel.monitor_quiet_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE panel.monitor_settings (
    id integer DEFAULT 1 NOT NULL,
    mail boolean DEFAULT true NOT NULL,
    round_at bigint,
    round_ms integer,
    round_note text,
    CONSTRAINT monitor_settings_id_check CHECK ((id = 1))
);
ALTER TABLE panel.monitor_settings OWNER TO pammy_owner;
CREATE TABLE panel.passkeys (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    credential_id text NOT NULL,
    public_key bytea NOT NULL,
    counter bigint NOT NULL,
    transports text,
    device_type text,
    backed_up integer DEFAULT 0 NOT NULL,
    name text NOT NULL,
    created_at bigint NOT NULL,
    last_used_at bigint
);
ALTER TABLE panel.passkeys OWNER TO pammy_owner;
ALTER TABLE panel.passkeys ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME panel.passkeys_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE panel.path_steps (
    started_path_id bigint NOT NULL,
    step text NOT NULL,
    state text NOT NULL,
    by text NOT NULL,
    at bigint NOT NULL,
    CONSTRAINT path_steps_state_check CHECK ((state = ANY (ARRAY['skipped'::text, 'done-by-hand'::text]))),
    CONSTRAINT path_steps_step_check CHECK ((step ~ '^[a-z][a-z0-9-]{0,40}$'::text))
);
ALTER TABLE panel.path_steps OWNER TO pammy_owner;
CREATE TABLE panel.routes (
    id bigint NOT NULL,
    host_id bigint NOT NULL,
    path text NOT NULL,
    target_kind text NOT NULL,
    folder_id bigint,
    enabled boolean DEFAULT true NOT NULL,
    created_by text,
    created_at bigint NOT NULL,
    area_token text,
    accounts text,
    target_ref jsonb NOT NULL,
    CONSTRAINT routes_accounts_check CHECK (((accounts IS NULL) OR (accounts = ANY (ARRAY['open'::text, 'private'::text])))),
    CONSTRAINT routes_accounts_check2 CHECK (((area_token IS NULL) = (accounts IS NULL))),
    CONSTRAINT routes_area_token_check CHECK (((area_token IS NULL) OR (area_token ~ '^[A-Za-z0-9_-]{32}$'::text))),
    CONSTRAINT routes_folder_check CHECK (((target_kind = 'folder'::text) = (folder_id IS NOT NULL))),
    CONSTRAINT routes_path_check CHECK (((path ~ '^/([A-Za-z0-9_~-][A-Za-z0-9._~-]*/)*$'::text) AND (path !~ '/\.'::text))),
    CONSTRAINT routes_target_kind_check CHECK ((target_kind ~ '^[a-z][a-z-]{0,30}[a-z]$'::text)),
    CONSTRAINT routes_target_ref_check CHECK (((jsonb_typeof(target_ref) = 'object'::text) AND (octet_length((target_ref)::text) <= 16384)))
);
ALTER TABLE panel.routes OWNER TO pammy_owner;
ALTER TABLE panel.routes ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME panel.routes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE panel.sessions (
    id bigint NOT NULL,
    token_hash text NOT NULL,
    user_id bigint NOT NULL,
    passkey_id bigint,
    created_at bigint NOT NULL,
    auth_at bigint NOT NULL,
    last_seen_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    revoked_at bigint,
    ip text,
    user_agent text
);
ALTER TABLE panel.sessions OWNER TO pammy_owner;
ALTER TABLE panel.sessions ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME panel.sessions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE panel.site_folders (
    id bigint NOT NULL,
    name text NOT NULL,
    run_php boolean DEFAULT true NOT NULL,
    adopted boolean DEFAULT false NOT NULL,
    created_by text,
    created_at bigint NOT NULL,
    CONSTRAINT site_folders_name_check CHECK ((name ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'::text))
);
ALTER TABLE panel.site_folders OWNER TO pammy_owner;
ALTER TABLE panel.site_folders ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME panel.site_folders_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE panel.started_paths (
    id bigint NOT NULL,
    path text NOT NULL,
    answers text DEFAULT '{}'::text NOT NULL,
    links text DEFAULT '{}'::text NOT NULL,
    started_by text NOT NULL,
    started_at bigint NOT NULL,
    finished_at bigint,
    put_away_at bigint,
    CONSTRAINT started_paths_path_check CHECK ((path ~ '^[a-z][a-z0-9-]{0,40}$'::text))
);
ALTER TABLE panel.started_paths OWNER TO pammy_owner;
ALTER TABLE panel.started_paths ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME panel.started_paths_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE panel.studio_catalog_records (
    item_id bigint NOT NULL,
    picture text,
    CONSTRAINT studio_catalog_records_picture_check CHECK (((picture IS NULL) OR (length(picture) <= 2000)))
);
ALTER TABLE panel.studio_catalog_records OWNER TO pammy_owner;
CREATE TABLE panel.studio_databases (
    id bigint NOT NULL,
    engine text NOT NULL,
    name text NOT NULL,
    display_name text DEFAULT ''::text NOT NULL,
    adopted_at bigint NOT NULL,
    last_applied_at bigint,
    last_introspect_json text,
    status text DEFAULT 'inactive'::text NOT NULL,
    activated_at bigint,
    api_read integer DEFAULT 0 NOT NULL,
    api_write integer DEFAULT 0 NOT NULL,
    example text,
    copied_from text,
    page text,
    copied_rows boolean DEFAULT false NOT NULL,
    CONSTRAINT studio_databases_copied_from_check CHECK (((copied_from IS NULL) OR (copied_from = ANY (ARRAY['recipes'::text, 'blog'::text])))),
    CONSTRAINT studio_databases_engine_check CHECK ((engine = ANY (ARRAY['postgres'::text, 'mariadb'::text]))),
    CONSTRAINT studio_databases_example_check CHECK (((example IS NULL) OR (example = ANY (ARRAY['recipes'::text, 'blog'::text, 'tutorial-journal'::text, 'tutorial-todo'::text])))),
    CONSTRAINT studio_databases_name_check CHECK ((name ~ '^[a-z][a-z0-9_]{0,62}$'::text)),
    CONSTRAINT studio_databases_status_check CHECK ((status = ANY (ARRAY['inactive'::text, 'active'::text])))
);
ALTER TABLE panel.studio_databases OWNER TO pammy_owner;
ALTER TABLE panel.studio_databases ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME panel.studio_databases_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE panel.studio_db_users (
    id bigint NOT NULL,
    engine text NOT NULL,
    name text NOT NULL,
    note text DEFAULT ''::text NOT NULL,
    created_at bigint NOT NULL,
    CONSTRAINT studio_db_users_engine_check CHECK ((engine = ANY (ARRAY['postgres'::text, 'mariadb'::text]))),
    CONSTRAINT studio_db_users_name_check CHECK ((name ~ '^[a-z][a-z0-9_]{0,62}$'::text))
);
ALTER TABLE panel.studio_db_users OWNER TO pammy_owner;
ALTER TABLE panel.studio_db_users ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME panel.studio_db_users_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE panel.studio_drafts (
    database_id bigint NOT NULL,
    draft_json text NOT NULL,
    based_on text NOT NULL,
    updated_at bigint NOT NULL,
    updated_by text DEFAULT ''::text NOT NULL
);
ALTER TABLE panel.studio_drafts OWNER TO pammy_owner;
CREATE TABLE panel.studio_fields (
    id bigint NOT NULL,
    database_id bigint NOT NULL,
    table_name text NOT NULL,
    field_name text NOT NULL,
    exposed boolean DEFAULT true NOT NULL,
    label text DEFAULT ''::text NOT NULL,
    help text DEFAULT ''::text NOT NULL,
    control text DEFAULT ''::text NOT NULL,
    show_in_list boolean DEFAULT true NOT NULL,
    searchable boolean DEFAULT false NOT NULL,
    filterable boolean DEFAULT false NOT NULL,
    form_order bigint DEFAULT 0 NOT NULL,
    CONSTRAINT studio_fields_field_name_check CHECK ((field_name ~ '^[a-z][a-z0-9_]{0,62}$'::text)),
    CONSTRAINT studio_fields_table_name_check CHECK ((table_name ~ '^[a-z][a-z0-9_]{0,62}$'::text))
);
ALTER TABLE panel.studio_fields OWNER TO pammy_owner;
ALTER TABLE panel.studio_fields ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME panel.studio_fields_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE panel.studio_layouts (
    database_id bigint NOT NULL,
    layout_json text NOT NULL,
    updated_at bigint NOT NULL,
    updated_by text DEFAULT ''::text NOT NULL
);
ALTER TABLE panel.studio_layouts OWNER TO pammy_owner;
CREATE TABLE panel.studio_resources (
    id bigint NOT NULL,
    database_id bigint NOT NULL,
    table_name text NOT NULL,
    enabled boolean,
    singular text DEFAULT ''::text NOT NULL,
    plural text DEFAULT ''::text NOT NULL,
    icon text DEFAULT ''::text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    title_field text DEFAULT ''::text NOT NULL,
    sort_field text DEFAULT ''::text NOT NULL,
    sort_dir text DEFAULT 'asc'::text NOT NULL,
    can_create boolean DEFAULT true NOT NULL,
    can_view boolean DEFAULT true NOT NULL,
    can_edit boolean DEFAULT true NOT NULL,
    can_delete boolean DEFAULT true NOT NULL,
    can_duplicate boolean DEFAULT true NOT NULL,
    can_search boolean DEFAULT true NOT NULL,
    can_sort boolean DEFAULT true NOT NULL,
    can_filter boolean DEFAULT false NOT NULL,
    on_delete text DEFAULT 'follow'::text NOT NULL,
    public_read boolean DEFAULT false NOT NULL,
    public_only text DEFAULT ''::text NOT NULL,
    field_order text DEFAULT '[]'::text NOT NULL,
    visitor_area bigint,
    visitor_owner text DEFAULT ''::text NOT NULL,
    catalog_source bigint,
    picture_field text DEFAULT ''::text NOT NULL,
    CONSTRAINT studio_resources_field_order_check CHECK (((field_order ~~ '[%]'::text) AND (length(field_order) <= 20000))),
    CONSTRAINT studio_resources_on_delete_check CHECK ((on_delete = ANY (ARRAY['follow'::text, 'confirm'::text]))),
    CONSTRAINT studio_resources_public_only_check CHECK (((public_only = ''::text) OR (public_only ~ '^[a-z][a-z0-9_]{0,62}$'::text))),
    CONSTRAINT studio_resources_sort_dir_check CHECK ((sort_dir = ANY (ARRAY['asc'::text, 'desc'::text]))),
    CONSTRAINT studio_resources_table_name_check CHECK ((table_name ~ '^[a-z][a-z0-9_]{0,62}$'::text)),
    CONSTRAINT studio_resources_visitor_area_check CHECK (((visitor_area IS NULL) OR (visitor_area > 0))),
    CONSTRAINT studio_resources_visitor_owner_check CHECK (((visitor_owner = ''::text) OR (visitor_owner ~ '^[a-z][a-z0-9_]{0,62}$'::text)))
);
ALTER TABLE panel.studio_resources OWNER TO pammy_owner;
ALTER TABLE panel.studio_resources ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME panel.studio_resources_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE panel.user_places (
    user_id bigint NOT NULL,
    place text NOT NULL,
    CONSTRAINT user_places_place_check CHECK ((((place ~ '^/[^/\\[:cntrl:]]{1,200}$'::text) AND (place !~ '^/\.'::text)) OR (place ~ '^software:[a-z0-9][a-z0-9-]{0,39}$'::text)))
);
ALTER TABLE panel.user_places OWNER TO pammy_owner;
CREATE TABLE panel.user_rights (
    user_id bigint NOT NULL,
    name text NOT NULL,
    CONSTRAINT user_rights_name_check CHECK ((name ~ '^[a-z][a-z-]{0,39}$'::text))
);
ALTER TABLE panel.user_rights OWNER TO pammy_owner;
CREATE TABLE panel.users (
    id bigint NOT NULL,
    username text NOT NULL,
    display_name text NOT NULL,
    role text NOT NULL,
    active integer DEFAULT 1 NOT NULL,
    webauthn_user_id text NOT NULL,
    created_at bigint NOT NULL,
    getting_started_open boolean DEFAULT true NOT NULL,
    CONSTRAINT users_role_check CHECK ((role = ANY (ARRAY['manager'::text, 'member'::text])))
);
ALTER TABLE panel.users OWNER TO pammy_owner;
ALTER TABLE panel.users ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME panel.users_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
CREATE TABLE public.schema_migrations (
    name text NOT NULL,
    checksum text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE public.schema_migrations OWNER TO pammy_owner;
CREATE TABLE thumbs.thumbs (
    item_id bigint NOT NULL,
    hash text NOT NULL,
    result text NOT NULL,
    icon text,
    width bigint,
    height bigint,
    why text,
    made_at bigint NOT NULL,
    CONSTRAINT thumbs_result_check CHECK ((result = ANY (ARRAY['picture'::text, 'icon'::text])))
);
ALTER TABLE thumbs.thumbs OWNER TO pammy_owner;
ALTER TABLE ONLY catalog.items
    ADD CONSTRAINT items_pkey PRIMARY KEY (id);
ALTER TABLE ONLY catalog.labels
    ADD CONSTRAINT labels_pkey PRIMARY KEY (id);
ALTER TABLE ONLY catalog.labels
    ADD CONSTRAINT labels_scope_id_kind_name_key UNIQUE (scope_id, kind, name);
ALTER TABLE ONLY catalog.links
    ADD CONSTRAINT links_pkey PRIMARY KEY (item_id, label_id);
ALTER TABLE ONLY catalog.resources
    ADD CONSTRAINT resources_pkey PRIMARY KEY (id);
ALTER TABLE ONLY catalog.resources
    ADD CONSTRAINT resources_source_id_key_key UNIQUE (source_id, key);
ALTER TABLE ONLY catalog.scopes
    ADD CONSTRAINT scopes_pkey PRIMARY KEY (id);
ALTER TABLE ONLY catalog.scopes
    ADD CONSTRAINT scopes_source_id_path_key UNIQUE (source_id, path);
ALTER TABLE ONLY catalog.sources
    ADD CONSTRAINT sources_kind_ref_key UNIQUE (kind, ref);
ALTER TABLE ONLY catalog.sources
    ADD CONSTRAINT sources_pkey PRIMARY KEY (id);
ALTER TABLE ONLY catalog.sync_state
    ADD CONSTRAINT sync_state_pkey PRIMARY KEY (key);
ALTER TABLE ONLY files.files
    ADD CONSTRAINT files_pkey PRIMARY KEY (item_id);
ALTER TABLE ONLY files.imported_notes
    ADD CONSTRAINT imported_notes_pkey PRIMARY KEY (path);
ALTER TABLE ONLY gate.actions
    ADD CONSTRAINT actions_pkey PRIMARY KEY (role_set_id, key);
ALTER TABLE ONLY gate.api_keys
    ADD CONSTRAINT api_keys_key_hash_key UNIQUE (key_hash);
ALTER TABLE ONLY gate.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);
ALTER TABLE ONLY gate.areas
    ADD CONSTRAINT areas_id_role_set UNIQUE (id, role_set_id);
ALTER TABLE ONLY gate.areas
    ADD CONSTRAINT areas_path_key UNIQUE (path);
ALTER TABLE ONLY gate.areas
    ADD CONSTRAINT areas_pkey PRIMARY KEY (id);
ALTER TABLE ONLY gate.areas
    ADD CONSTRAINT areas_route_id_key UNIQUE (route_id);
ALTER TABLE ONLY gate.areas
    ADD CONSTRAINT areas_token_key UNIQUE (token);
ALTER TABLE ONLY gate.deleted_accounts
    ADD CONSTRAINT deleted_accounts_pkey PRIMARY KEY (visitor_id);
ALTER TABLE ONLY gate.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);
ALTER TABLE ONLY gate.form_links
    ADD CONSTRAINT form_links_pkey PRIMARY KEY (form_id);
ALTER TABLE ONLY gate.form_pages
    ADD CONSTRAINT form_pages_pkey PRIMARY KEY (form_id, page);
ALTER TABLE ONLY gate.forms
    ADD CONSTRAINT forms_name_key UNIQUE (name);
ALTER TABLE ONLY gate.forms
    ADD CONSTRAINT forms_pkey PRIMARY KEY (id);
ALTER TABLE ONLY gate.group_privileges
    ADD CONSTRAINT group_privileges_pkey PRIMARY KEY (group_id, privilege);
ALTER TABLE ONLY gate.groups
    ADD CONSTRAINT groups_id_role_set_id_key UNIQUE (id, role_set_id);
ALTER TABLE ONLY gate.groups
    ADD CONSTRAINT groups_pkey PRIMARY KEY (id);
ALTER TABLE ONLY gate.groups
    ADD CONSTRAINT groups_role_set_id_key_key UNIQUE (role_set_id, key);
ALTER TABLE ONLY gate.links
    ADD CONSTRAINT links_pkey PRIMARY KEY (id);
ALTER TABLE ONLY gate.links
    ADD CONSTRAINT links_token_hash_key UNIQUE (token_hash);
ALTER TABLE ONLY gate.memberships
    ADD CONSTRAINT memberships_pkey PRIMARY KEY (visitor_id, area_id);
ALTER TABLE ONLY gate.never_together
    ADD CONSTRAINT never_together_pkey PRIMARY KEY (role_a, role_b);
ALTER TABLE ONLY gate.record_labels
    ADD CONSTRAINT record_labels_pkey PRIMARY KEY (database_id, table_name, key, kind, name);
ALTER TABLE ONLY gate.record_touches
    ADD CONSTRAINT record_touches_pkey PRIMARY KEY (id);
ALTER TABLE ONLY gate.requests
    ADD CONSTRAINT requests_pkey PRIMARY KEY (id);
ALTER TABLE ONLY gate.resource_actions
    ADD CONSTRAINT resource_actions_pkey PRIMARY KEY (resource_id, action);
ALTER TABLE ONLY gate.resources
    ADD CONSTRAINT resources_pkey PRIMARY KEY (id);
ALTER TABLE ONLY gate.resources
    ADD CONSTRAINT resources_role_set_id_key_key UNIQUE (role_set_id, key);
ALTER TABLE ONLY gate.response_saves
    ADD CONSTRAINT response_saves_pkey PRIMARY KEY (response_id);
ALTER TABLE ONLY gate.responses
    ADD CONSTRAINT responses_pkey PRIMARY KEY (id);
ALTER TABLE ONLY gate.role_groups
    ADD CONSTRAINT role_groups_pkey PRIMARY KEY (role_id, group_id);
ALTER TABLE ONLY gate.role_parts
    ADD CONSTRAINT role_parts_pkey PRIMARY KEY (role_id, part_id);
ALTER TABLE ONLY gate.role_privileges
    ADD CONSTRAINT role_privileges_pkey PRIMARY KEY (role_id, privilege);
ALTER TABLE ONLY gate.role_sets
    ADD CONSTRAINT role_sets_key_key UNIQUE (key);
ALTER TABLE ONLY gate.role_sets
    ADD CONSTRAINT role_sets_pkey PRIMARY KEY (id);
ALTER TABLE ONLY gate.roles
    ADD CONSTRAINT roles_id_role_set_id_key UNIQUE (id, role_set_id);
ALTER TABLE ONLY gate.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);
ALTER TABLE ONLY gate.roles
    ADD CONSTRAINT roles_role_set_id_key_key UNIQUE (role_set_id, key);
ALTER TABLE ONLY gate.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY gate.sessions
    ADD CONSTRAINT sessions_token_hash_key UNIQUE (token_hash);
ALTER TABLE ONLY gate.studio_app_keys
    ADD CONSTRAINT studio_app_keys_key_hash_key UNIQUE (key_hash);
ALTER TABLE ONLY gate.studio_app_keys
    ADD CONSTRAINT studio_app_keys_pkey PRIMARY KEY (id);
ALTER TABLE ONLY gate.studio_catalog
    ADD CONSTRAINT studio_catalog_engine_name_key UNIQUE (engine, name);
ALTER TABLE ONLY gate.studio_catalog
    ADD CONSTRAINT studio_catalog_pkey PRIMARY KEY (database_id);
ALTER TABLE ONLY gate.visitor_settings
    ADD CONSTRAINT visitor_settings_pkey PRIMARY KEY (id);
ALTER TABLE ONLY gate.visitors
    ADD CONSTRAINT visitors_pkey PRIMARY KEY (id);
ALTER TABLE ONLY gate.visitors
    ADD CONSTRAINT visitors_username_key UNIQUE (username);
ALTER TABLE ONLY panel.activity
    ADD CONSTRAINT activity_pkey PRIMARY KEY (id);
ALTER TABLE ONLY panel.backup_settings
    ADD CONSTRAINT backup_settings_pkey PRIMARY KEY (id);
ALTER TABLE ONLY panel.ceremonies
    ADD CONSTRAINT ceremonies_pkey PRIMARY KEY (id_hash);
ALTER TABLE ONLY panel.domains
    ADD CONSTRAINT domains_name_key UNIQUE (name);
ALTER TABLE ONLY panel.domains
    ADD CONSTRAINT domains_pkey PRIMARY KEY (id);
ALTER TABLE ONLY panel.first_steps
    ADD CONSTRAINT first_steps_pkey PRIMARY KEY (user_id);
ALTER TABLE ONLY panel.git_tokens
    ADD CONSTRAINT git_tokens_hash_key UNIQUE (hash);
ALTER TABLE ONLY panel.git_tokens
    ADD CONSTRAINT git_tokens_pkey PRIMARY KEY (id);
ALTER TABLE ONLY panel.hosts
    ADD CONSTRAINT hosts_domain_name_key UNIQUE (domain_id, name);
ALTER TABLE ONLY panel.hosts
    ADD CONSTRAINT hosts_pkey PRIMARY KEY (id);
ALTER TABLE ONLY panel.invites
    ADD CONSTRAINT invites_pkey PRIMARY KEY (id);
ALTER TABLE ONLY panel.invites
    ADD CONSTRAINT invites_token_hash_key UNIQUE (token_hash);
ALTER TABLE ONLY panel.mail_notices
    ADD CONSTRAINT mail_notices_pkey PRIMARY KEY (id);
ALTER TABLE ONLY panel.monitor_baseline
    ADD CONSTRAINT monitor_baseline_pkey PRIMARY KEY (key);
ALTER TABLE ONLY panel.monitor_checks
    ADD CONSTRAINT monitor_checks_pkey PRIMARY KEY (key);
ALTER TABLE ONLY panel.monitor_events
    ADD CONSTRAINT monitor_events_pkey PRIMARY KEY (id);
ALTER TABLE ONLY panel.monitor_mail
    ADD CONSTRAINT monitor_mail_pkey PRIMARY KEY (day);
ALTER TABLE ONLY panel.monitor_quiet
    ADD CONSTRAINT monitor_quiet_pkey PRIMARY KEY (id);
ALTER TABLE ONLY panel.monitor_settings
    ADD CONSTRAINT monitor_settings_pkey PRIMARY KEY (id);
ALTER TABLE ONLY panel.passkeys
    ADD CONSTRAINT passkeys_credential_id_key UNIQUE (credential_id);
ALTER TABLE ONLY panel.passkeys
    ADD CONSTRAINT passkeys_pkey PRIMARY KEY (id);
ALTER TABLE ONLY panel.path_steps
    ADD CONSTRAINT path_steps_pkey PRIMARY KEY (started_path_id, step);
ALTER TABLE ONLY panel.routes
    ADD CONSTRAINT routes_area_token_key UNIQUE (area_token);
ALTER TABLE ONLY panel.routes
    ADD CONSTRAINT routes_host_id_path_key UNIQUE (host_id, path);
ALTER TABLE ONLY panel.routes
    ADD CONSTRAINT routes_pkey PRIMARY KEY (id);
ALTER TABLE ONLY panel.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY panel.sessions
    ADD CONSTRAINT sessions_token_hash_key UNIQUE (token_hash);
ALTER TABLE ONLY panel.site_folders
    ADD CONSTRAINT site_folders_name_key UNIQUE (name);
ALTER TABLE ONLY panel.site_folders
    ADD CONSTRAINT site_folders_pkey PRIMARY KEY (id);
ALTER TABLE ONLY panel.started_paths
    ADD CONSTRAINT started_paths_pkey PRIMARY KEY (id);
ALTER TABLE ONLY panel.studio_catalog_records
    ADD CONSTRAINT studio_catalog_records_pkey PRIMARY KEY (item_id);
ALTER TABLE ONLY panel.studio_databases
    ADD CONSTRAINT studio_databases_engine_name_key UNIQUE (engine, name);
ALTER TABLE ONLY panel.studio_databases
    ADD CONSTRAINT studio_databases_pkey PRIMARY KEY (id);
ALTER TABLE ONLY panel.studio_db_users
    ADD CONSTRAINT studio_db_users_engine_name_key UNIQUE (engine, name);
ALTER TABLE ONLY panel.studio_db_users
    ADD CONSTRAINT studio_db_users_pkey PRIMARY KEY (id);
ALTER TABLE ONLY panel.studio_drafts
    ADD CONSTRAINT studio_drafts_pkey PRIMARY KEY (database_id);
ALTER TABLE ONLY panel.studio_fields
    ADD CONSTRAINT studio_fields_database_id_table_name_field_name_key UNIQUE (database_id, table_name, field_name);
ALTER TABLE ONLY panel.studio_fields
    ADD CONSTRAINT studio_fields_pkey PRIMARY KEY (id);
ALTER TABLE ONLY panel.studio_layouts
    ADD CONSTRAINT studio_layouts_pkey PRIMARY KEY (database_id);
ALTER TABLE ONLY panel.studio_resources
    ADD CONSTRAINT studio_resources_catalog_source_key UNIQUE (catalog_source);
ALTER TABLE ONLY panel.studio_resources
    ADD CONSTRAINT studio_resources_database_id_table_name_key UNIQUE (database_id, table_name);
ALTER TABLE ONLY panel.studio_resources
    ADD CONSTRAINT studio_resources_pkey PRIMARY KEY (id);
ALTER TABLE ONLY panel.user_places
    ADD CONSTRAINT user_places_pkey PRIMARY KEY (user_id, place);
ALTER TABLE ONLY panel.user_rights
    ADD CONSTRAINT user_rights_pkey PRIMARY KEY (user_id, name);
ALTER TABLE ONLY panel.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);
ALTER TABLE ONLY panel.users
    ADD CONSTRAINT users_username_key UNIQUE (username);
ALTER TABLE ONLY panel.users
    ADD CONSTRAINT users_webauthn_user_id_key UNIQUE (webauthn_user_id);
ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (name);
ALTER TABLE ONLY thumbs.thumbs
    ADD CONSTRAINT thumbs_pkey PRIMARY KEY (item_id);
CREATE INDEX items_key ON catalog.items USING btree (resource_id, key);
CREATE UNIQUE INDEX items_present_key ON catalog.items USING btree (resource_id, key) WHERE (state = 'present'::text);
CREATE INDEX items_scope ON catalog.items USING btree (scope_id, kind, state);
CREATE INDEX links_label ON catalog.links USING btree (label_id);
CREATE UNIQUE INDEX scopes_one_all ON catalog.scopes USING btree ((true)) WHERE (parent_id IS NULL);
CREATE INDEX scopes_parent ON catalog.scopes USING btree (parent_id);
CREATE INDEX files_trash ON files.files USING btree (trash_id) WHERE (trash_id IS NOT NULL);
CREATE INDEX deleted_accounts_next ON gate.deleted_accounts USING btree (next_at);
CREATE INDEX events_at ON gate.events USING btree (at);
CREATE INDEX form_links_database ON gate.form_links USING btree (database_id);
CREATE UNIQUE INDEX forms_fixture ON gate.forms USING btree (fixture) WHERE (fixture IS NOT NULL);
CREATE INDEX links_visitor ON gate.links USING btree (visitor_id);
CREATE INDEX memberships_area ON gate.memberships USING btree (area_id);
CREATE INDEX record_labels_name ON gate.record_labels USING btree (database_id, table_name, kind, name);
CREATE INDEX requests_status ON gate.requests USING btree (status, created_at);
CREATE INDEX response_saves_retry ON gate.response_saves USING btree (save_tried_at, response_id) WHERE save_retry;
CREATE INDEX response_values_find ON gate.response_values USING btree (form_id, key, value);
CREATE INDEX response_values_response ON gate.response_values USING btree (response_id, key);
CREATE INDEX responses_approved ON gate.responses USING btree (form_id, approved_at);
CREATE INDEX responses_created ON gate.responses USING btree (created_at);
CREATE INDEX responses_form ON gate.responses USING btree (form_id, created_at, id);
CREATE INDEX responses_thread ON gate.responses USING btree (form_id, content_type, content_id, approved_at);
CREATE UNIQUE INDEX role_sets_one_copy_per_area ON gate.role_sets USING btree (area_id) WHERE (area_id IS NOT NULL);
CREATE UNIQUE INDEX roles_one_slot ON gate.roles USING btree (role_set_id, slot) WHERE (slot IS NOT NULL);
CREATE INDEX sessions_visitor ON gate.sessions USING btree (visitor_id);
CREATE INDEX studio_app_keys_database ON gate.studio_app_keys USING btree (database_id) WHERE (revoked_at IS NULL);
CREATE UNIQUE INDEX visitors_email ON gate.visitors USING btree (email) WHERE (email IS NOT NULL);
CREATE INDEX activity_at ON panel.activity USING btree (at);
CREATE UNIQUE INDEX domains_one_home ON panel.domains USING btree (home) WHERE home;
CREATE INDEX git_tokens_user ON panel.git_tokens USING btree (user_id);
CREATE INDEX hosts_domain ON panel.hosts USING btree (domain_id);
CREATE INDEX monitor_events_at ON panel.monitor_events USING btree (at);
CREATE INDEX monitor_events_key ON panel.monitor_events USING btree (key, at);
CREATE INDEX routes_folder ON panel.routes USING btree (folder_id);
CREATE INDEX sessions_user ON panel.sessions USING btree (user_id);
CREATE UNIQUE INDEX studio_databases_active_display_name ON panel.studio_databases USING btree (lower(display_name)) WHERE ((status = 'active'::text) AND (display_name <> ''::text));
CREATE UNIQUE INDEX studio_databases_example ON panel.studio_databases USING btree (example) WHERE (example IS NOT NULL);
CREATE TRIGGER items_key_change AFTER UPDATE OF key, resource_id ON catalog.items FOR EACH ROW EXECUTE FUNCTION catalog.check_item_key();
CREATE CONSTRAINT TRIGGER items_record AFTER INSERT OR UPDATE ON catalog.items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION files.check_record();
CREATE TRIGGER labels_scope_change AFTER UPDATE OF scope_id ON catalog.labels FOR EACH ROW EXECUTE FUNCTION catalog.check_label_scope();
CREATE TRIGGER links_scope BEFORE INSERT OR UPDATE ON catalog.links FOR EACH ROW EXECUTE FUNCTION catalog.check_link();
CREATE CONSTRAINT TRIGGER scopes_path_change AFTER UPDATE OF path ON catalog.scopes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION catalog.check_scope_path();
CREATE CONSTRAINT TRIGGER files_record AFTER INSERT OR UPDATE ON files.files DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION files.check_record();
CREATE TRIGGER visitors_deleted AFTER DELETE ON gate.visitors FOR EACH ROW EXECUTE FUNCTION gate.note_deleted_account();
CREATE TRIGGER hosts_home_domain BEFORE INSERT ON panel.hosts FOR EACH ROW EXECUTE FUNCTION panel.hosts_home_domain();
CREATE TRIGGER studio_resources_gone AFTER DELETE ON panel.studio_resources FOR EACH ROW EXECUTE FUNCTION panel.studio_resource_gone();
ALTER TABLE ONLY catalog.items
    ADD CONSTRAINT items_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES catalog.resources(id) ON DELETE CASCADE;
ALTER TABLE ONLY catalog.items
    ADD CONSTRAINT items_scope_id_fkey FOREIGN KEY (scope_id) REFERENCES catalog.scopes(id) ON DELETE RESTRICT;
ALTER TABLE ONLY catalog.labels
    ADD CONSTRAINT labels_scope_id_fkey FOREIGN KEY (scope_id) REFERENCES catalog.scopes(id) ON DELETE RESTRICT;
ALTER TABLE ONLY catalog.links
    ADD CONSTRAINT links_item_id_fkey FOREIGN KEY (item_id) REFERENCES catalog.items(id) ON DELETE CASCADE;
ALTER TABLE ONLY catalog.links
    ADD CONSTRAINT links_label_id_fkey FOREIGN KEY (label_id) REFERENCES catalog.labels(id) ON DELETE CASCADE;
ALTER TABLE ONLY catalog.resources
    ADD CONSTRAINT resources_source_id_fkey FOREIGN KEY (source_id) REFERENCES catalog.sources(id) ON DELETE CASCADE;
ALTER TABLE ONLY catalog.scopes
    ADD CONSTRAINT scopes_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES catalog.scopes(id);
ALTER TABLE ONLY catalog.scopes
    ADD CONSTRAINT scopes_source_id_fkey FOREIGN KEY (source_id) REFERENCES catalog.sources(id) ON DELETE CASCADE;
ALTER TABLE ONLY files.files
    ADD CONSTRAINT files_item_id_fkey FOREIGN KEY (item_id) REFERENCES catalog.items(id) ON DELETE CASCADE;
ALTER TABLE ONLY gate.actions
    ADD CONSTRAINT actions_role_set_id_fkey FOREIGN KEY (role_set_id) REFERENCES gate.role_sets(id) ON DELETE CASCADE;
ALTER TABLE ONLY gate.areas
    ADD CONSTRAINT areas_role_set_id_fkey FOREIGN KEY (role_set_id) REFERENCES gate.role_sets(id);
ALTER TABLE ONLY gate.events
    ADD CONSTRAINT events_visitor_id_fkey FOREIGN KEY (visitor_id) REFERENCES gate.visitors(id) ON DELETE SET NULL;
ALTER TABLE ONLY gate.form_links
    ADD CONSTRAINT form_links_form_id_fkey FOREIGN KEY (form_id) REFERENCES gate.forms(id) ON DELETE CASCADE;
ALTER TABLE ONLY gate.form_pages
    ADD CONSTRAINT form_pages_form_id_fkey FOREIGN KEY (form_id) REFERENCES gate.forms(id) ON DELETE CASCADE;
ALTER TABLE ONLY gate.group_privileges
    ADD CONSTRAINT group_privileges_group_id_fkey FOREIGN KEY (group_id) REFERENCES gate.groups(id) ON DELETE CASCADE;
ALTER TABLE ONLY gate.groups
    ADD CONSTRAINT groups_role_set_id_fkey FOREIGN KEY (role_set_id) REFERENCES gate.role_sets(id) ON DELETE CASCADE;
ALTER TABLE ONLY gate.links
    ADD CONSTRAINT links_area_id_fkey FOREIGN KEY (area_id) REFERENCES gate.areas(id) ON DELETE SET NULL;
ALTER TABLE ONLY gate.links
    ADD CONSTRAINT links_visitor_id_fkey FOREIGN KEY (visitor_id) REFERENCES gate.visitors(id) ON DELETE CASCADE;
ALTER TABLE ONLY gate.memberships
    ADD CONSTRAINT memberships_area_id_role_set_id_fkey FOREIGN KEY (area_id, role_set_id) REFERENCES gate.areas(id, role_set_id) ON DELETE CASCADE DEFERRABLE;
ALTER TABLE ONLY gate.memberships
    ADD CONSTRAINT memberships_role_id_role_set_id_fkey FOREIGN KEY (role_id, role_set_id) REFERENCES gate.roles(id, role_set_id) ON DELETE CASCADE DEFERRABLE;
ALTER TABLE ONLY gate.memberships
    ADD CONSTRAINT memberships_visitor_id_fkey FOREIGN KEY (visitor_id) REFERENCES gate.visitors(id) ON DELETE CASCADE;
ALTER TABLE ONLY gate.never_together
    ADD CONSTRAINT never_together_role_a_role_set_id_fkey FOREIGN KEY (role_a, role_set_id) REFERENCES gate.roles(id, role_set_id) ON DELETE CASCADE;
ALTER TABLE ONLY gate.never_together
    ADD CONSTRAINT never_together_role_b_role_set_id_fkey FOREIGN KEY (role_b, role_set_id) REFERENCES gate.roles(id, role_set_id) ON DELETE CASCADE;
ALTER TABLE ONLY gate.requests
    ADD CONSTRAINT requests_area_id_fkey FOREIGN KEY (area_id) REFERENCES gate.areas(id) ON DELETE SET NULL;
ALTER TABLE ONLY gate.requests
    ADD CONSTRAINT requests_visitor_id_fkey FOREIGN KEY (visitor_id) REFERENCES gate.visitors(id) ON DELETE SET NULL;
ALTER TABLE ONLY gate.resource_actions
    ADD CONSTRAINT resource_actions_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES gate.resources(id) ON DELETE CASCADE;
ALTER TABLE ONLY gate.resources
    ADD CONSTRAINT resources_role_set_id_fkey FOREIGN KEY (role_set_id) REFERENCES gate.role_sets(id) ON DELETE CASCADE;
ALTER TABLE ONLY gate.response_saves
    ADD CONSTRAINT response_saves_response_id_fkey FOREIGN KEY (response_id) REFERENCES gate.responses(id) ON DELETE CASCADE;
ALTER TABLE ONLY gate.response_values
    ADD CONSTRAINT response_values_response_id_fkey FOREIGN KEY (response_id) REFERENCES gate.responses(id) ON DELETE CASCADE;
ALTER TABLE ONLY gate.responses
    ADD CONSTRAINT responses_form_id_fkey FOREIGN KEY (form_id) REFERENCES gate.forms(id) ON DELETE SET NULL;
ALTER TABLE ONLY gate.responses
    ADD CONSTRAINT responses_visitor_id_fkey FOREIGN KEY (visitor_id) REFERENCES gate.visitors(id) ON DELETE SET NULL;
ALTER TABLE ONLY gate.role_groups
    ADD CONSTRAINT role_groups_group_id_role_set_id_fkey FOREIGN KEY (group_id, role_set_id) REFERENCES gate.groups(id, role_set_id) ON DELETE CASCADE;
ALTER TABLE ONLY gate.role_groups
    ADD CONSTRAINT role_groups_role_id_role_set_id_fkey FOREIGN KEY (role_id, role_set_id) REFERENCES gate.roles(id, role_set_id) ON DELETE CASCADE;
ALTER TABLE ONLY gate.role_parts
    ADD CONSTRAINT role_parts_part_id_role_set_id_fkey FOREIGN KEY (part_id, role_set_id) REFERENCES gate.roles(id, role_set_id) ON DELETE CASCADE;
ALTER TABLE ONLY gate.role_parts
    ADD CONSTRAINT role_parts_role_id_role_set_id_fkey FOREIGN KEY (role_id, role_set_id) REFERENCES gate.roles(id, role_set_id) ON DELETE CASCADE;
ALTER TABLE ONLY gate.role_privileges
    ADD CONSTRAINT role_privileges_role_id_fkey FOREIGN KEY (role_id) REFERENCES gate.roles(id) ON DELETE CASCADE;
ALTER TABLE ONLY gate.role_sets
    ADD CONSTRAINT role_sets_area_id_fkey FOREIGN KEY (area_id) REFERENCES gate.areas(id) ON DELETE CASCADE;
ALTER TABLE ONLY gate.role_sets
    ADD CONSTRAINT role_sets_copied_from_fkey FOREIGN KEY (copied_from) REFERENCES gate.role_sets(id) ON DELETE SET NULL;
ALTER TABLE ONLY gate.role_sets
    ADD CONSTRAINT role_sets_signed_in_role FOREIGN KEY (signed_in_role_id, id) REFERENCES gate.roles(id, role_set_id) ON DELETE SET NULL (signed_in_role_id);
ALTER TABLE ONLY gate.roles
    ADD CONSTRAINT roles_role_set_id_fkey FOREIGN KEY (role_set_id) REFERENCES gate.role_sets(id) ON DELETE CASCADE;
ALTER TABLE ONLY gate.sessions
    ADD CONSTRAINT sessions_visitor_id_fkey FOREIGN KEY (visitor_id) REFERENCES gate.visitors(id) ON DELETE CASCADE;
ALTER TABLE ONLY panel.activity
    ADD CONSTRAINT activity_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES panel.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY panel.first_steps
    ADD CONSTRAINT first_steps_user_id_fkey FOREIGN KEY (user_id) REFERENCES panel.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY panel.git_tokens
    ADD CONSTRAINT git_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES panel.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY panel.hosts
    ADD CONSTRAINT hosts_domain_id_fkey FOREIGN KEY (domain_id) REFERENCES panel.domains(id) ON DELETE RESTRICT;
ALTER TABLE ONLY panel.invites
    ADD CONSTRAINT invites_created_by_fkey FOREIGN KEY (created_by) REFERENCES panel.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY panel.invites
    ADD CONSTRAINT invites_user_id_fkey FOREIGN KEY (user_id) REFERENCES panel.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY panel.passkeys
    ADD CONSTRAINT passkeys_user_id_fkey FOREIGN KEY (user_id) REFERENCES panel.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY panel.path_steps
    ADD CONSTRAINT path_steps_started_path_id_fkey FOREIGN KEY (started_path_id) REFERENCES panel.started_paths(id) ON DELETE CASCADE;
ALTER TABLE ONLY panel.routes
    ADD CONSTRAINT routes_folder_id_fkey FOREIGN KEY (folder_id) REFERENCES panel.site_folders(id) ON DELETE RESTRICT;
ALTER TABLE ONLY panel.routes
    ADD CONSTRAINT routes_host_id_fkey FOREIGN KEY (host_id) REFERENCES panel.hosts(id) ON DELETE CASCADE;
ALTER TABLE ONLY panel.sessions
    ADD CONSTRAINT sessions_passkey_id_fkey FOREIGN KEY (passkey_id) REFERENCES panel.passkeys(id) ON DELETE CASCADE;
ALTER TABLE ONLY panel.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES panel.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY panel.studio_catalog_records
    ADD CONSTRAINT studio_catalog_records_item_id_fkey FOREIGN KEY (item_id) REFERENCES catalog.items(id) ON DELETE CASCADE;
ALTER TABLE ONLY panel.studio_drafts
    ADD CONSTRAINT studio_drafts_database_id_fkey FOREIGN KEY (database_id) REFERENCES panel.studio_databases(id) ON DELETE CASCADE;
ALTER TABLE ONLY panel.studio_fields
    ADD CONSTRAINT studio_fields_database_id_fkey FOREIGN KEY (database_id) REFERENCES panel.studio_databases(id) ON DELETE CASCADE;
ALTER TABLE ONLY panel.studio_layouts
    ADD CONSTRAINT studio_layouts_database_id_fkey FOREIGN KEY (database_id) REFERENCES panel.studio_databases(id) ON DELETE CASCADE;
ALTER TABLE ONLY panel.studio_resources
    ADD CONSTRAINT studio_resources_catalog_source_fkey FOREIGN KEY (catalog_source) REFERENCES catalog.sources(id) ON DELETE SET NULL;
ALTER TABLE ONLY panel.studio_resources
    ADD CONSTRAINT studio_resources_database_id_fkey FOREIGN KEY (database_id) REFERENCES panel.studio_databases(id) ON DELETE CASCADE;
ALTER TABLE ONLY panel.user_places
    ADD CONSTRAINT user_places_user_id_fkey FOREIGN KEY (user_id) REFERENCES panel.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY panel.user_rights
    ADD CONSTRAINT user_rights_user_id_fkey FOREIGN KEY (user_id) REFERENCES panel.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY thumbs.thumbs
    ADD CONSTRAINT thumbs_item_id_fkey FOREIGN KEY (item_id) REFERENCES catalog.items(id) ON DELETE CASCADE;
GRANT USAGE ON SCHEMA catalog TO pammy_panel;
GRANT USAGE ON SCHEMA files TO pammy_panel;
GRANT USAGE ON SCHEMA gate TO pammy_gate;
GRANT USAGE ON SCHEMA media TO pammy_panel;
GRANT USAGE ON SCHEMA panel TO pammy_panel;
REVOKE USAGE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO pammy_panel;
GRANT USAGE ON SCHEMA public TO pammy_gate;
GRANT USAGE ON SCHEMA thumbs TO pammy_panel;
REVOKE ALL ON FUNCTION catalog.check_item_key() FROM PUBLIC;
GRANT ALL ON FUNCTION catalog.check_item_key() TO pammy_panel;
REVOKE ALL ON FUNCTION catalog.check_label_scope() FROM PUBLIC;
GRANT ALL ON FUNCTION catalog.check_label_scope() TO pammy_panel;
REVOKE ALL ON FUNCTION catalog.check_link() FROM PUBLIC;
GRANT ALL ON FUNCTION catalog.check_link() TO pammy_panel;
REVOKE ALL ON FUNCTION catalog.check_scope_path() FROM PUBLIC;
GRANT ALL ON FUNCTION catalog.check_scope_path() TO pammy_panel;
REVOKE ALL ON FUNCTION catalog.drop_source(source bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION catalog.drop_source(source bigint) TO pammy_panel;
REVOKE ALL ON FUNCTION catalog.path_under(scope_path text, key text) FROM PUBLIC;
GRANT ALL ON FUNCTION catalog.path_under(scope_path text, key text) TO pammy_panel;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE catalog.items TO pammy_panel;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE catalog.resources TO pammy_panel;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE catalog.scopes TO pammy_panel;
REVOKE ALL ON FUNCTION catalog.label_fits(label_scope bigint, item bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION catalog.label_fits(label_scope bigint, item bigint) TO pammy_panel;
REVOKE ALL ON FUNCTION files.check_record() FROM PUBLIC;
GRANT ALL ON FUNCTION files.check_record() TO pammy_panel;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE gate.role_sets TO pammy_gate;
REVOKE ALL ON FUNCTION gate.built_in_set(k text) FROM PUBLIC;
GRANT ALL ON FUNCTION gate.built_in_set(k text) TO pammy_gate;
REVOKE ALL ON FUNCTION gate.note_deleted_account() FROM PUBLIC;
GRANT ALL ON FUNCTION gate.note_deleted_account() TO pammy_gate;
REVOKE ALL ON FUNCTION panel.hosts_home_domain() FROM PUBLIC;
GRANT ALL ON FUNCTION panel.hosts_home_domain() TO pammy_panel;
REVOKE ALL ON FUNCTION panel.studio_resource_gone() FROM PUBLIC;
GRANT ALL ON FUNCTION panel.studio_resource_gone() TO pammy_panel;
GRANT SELECT,USAGE ON SEQUENCE catalog.items_id_seq TO pammy_panel;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE catalog.labels TO pammy_panel;
GRANT SELECT,USAGE ON SEQUENCE catalog.labels_id_seq TO pammy_panel;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE catalog.links TO pammy_panel;
GRANT SELECT,USAGE ON SEQUENCE catalog.resources_id_seq TO pammy_panel;
GRANT SELECT,USAGE ON SEQUENCE catalog.scopes_id_seq TO pammy_panel;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE catalog.sources TO pammy_panel;
GRANT SELECT,USAGE ON SEQUENCE catalog.sources_id_seq TO pammy_panel;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE catalog.sync_state TO pammy_panel;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE files.files TO pammy_panel;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE files.imported_notes TO pammy_panel;
GRANT SELECT ON TABLE files.records TO pammy_panel;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE gate.actions TO pammy_gate;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE gate.api_keys TO pammy_gate;
GRANT SELECT,USAGE ON SEQUENCE gate.api_keys_id_seq TO pammy_gate;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE gate.areas TO pammy_gate;
GRANT SELECT,USAGE ON SEQUENCE gate.areas_id_seq TO pammy_gate;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE gate.deleted_accounts TO pammy_gate;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE gate.events TO pammy_gate;
GRANT SELECT,USAGE ON SEQUENCE gate.events_id_seq TO pammy_gate;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE gate.form_links TO pammy_gate;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE gate.form_pages TO pammy_gate;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE gate.forms TO pammy_gate;
GRANT SELECT,USAGE ON SEQUENCE gate.forms_id_seq TO pammy_gate;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE gate.group_privileges TO pammy_gate;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE gate.groups TO pammy_gate;
GRANT SELECT,USAGE ON SEQUENCE gate.groups_id_seq TO pammy_gate;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE gate.links TO pammy_gate;
GRANT SELECT,USAGE ON SEQUENCE gate.links_id_seq TO pammy_gate;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE gate.memberships TO pammy_gate;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE gate.never_together TO pammy_gate;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE gate.record_labels TO pammy_gate;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE gate.record_touches TO pammy_gate;
GRANT SELECT,USAGE ON SEQUENCE gate.record_touches_id_seq TO pammy_gate;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE gate.requests TO pammy_gate;
GRANT SELECT,USAGE ON SEQUENCE gate.requests_id_seq TO pammy_gate;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE gate.resource_actions TO pammy_gate;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE gate.resources TO pammy_gate;
GRANT SELECT,USAGE ON SEQUENCE gate.resources_id_seq TO pammy_gate;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE gate.response_saves TO pammy_gate;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE gate.response_values TO pammy_gate;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE gate.responses TO pammy_gate;
GRANT SELECT,USAGE ON SEQUENCE gate.responses_id_seq TO pammy_gate;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE gate.role_groups TO pammy_gate;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE gate.role_parts TO pammy_gate;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE gate.role_privileges TO pammy_gate;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE gate.role_all_privileges TO pammy_gate;
GRANT SELECT,USAGE ON SEQUENCE gate.role_sets_id_seq TO pammy_gate;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE gate.roles TO pammy_gate;
GRANT SELECT,USAGE ON SEQUENCE gate.roles_id_seq TO pammy_gate;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE gate.sessions TO pammy_gate;
GRANT SELECT,USAGE ON SEQUENCE gate.sessions_id_seq TO pammy_gate;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE gate.studio_app_keys TO pammy_gate;
GRANT SELECT,USAGE ON SEQUENCE gate.studio_app_keys_id_seq TO pammy_gate;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE gate.studio_catalog TO pammy_gate;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE gate.visitor_settings TO pammy_gate;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE gate.visitors TO pammy_gate;
GRANT SELECT,USAGE ON SEQUENCE gate.visitors_id_seq TO pammy_gate;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE panel.activity TO pammy_panel;
GRANT SELECT,USAGE ON SEQUENCE panel.activity_id_seq TO pammy_panel;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE panel.backup_settings TO pammy_panel;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE panel.ceremonies TO pammy_panel;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE panel.domains TO pammy_panel;
GRANT SELECT,USAGE ON SEQUENCE panel.domains_id_seq TO pammy_panel;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE panel.first_steps TO pammy_panel;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE panel.git_tokens TO pammy_panel;
GRANT SELECT,USAGE ON SEQUENCE panel.git_tokens_id_seq TO pammy_panel;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE panel.hosts TO pammy_panel;
GRANT SELECT,USAGE ON SEQUENCE panel.hosts_id_seq TO pammy_panel;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE panel.invites TO pammy_panel;
GRANT SELECT,USAGE ON SEQUENCE panel.invites_id_seq TO pammy_panel;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE panel.mail_notices TO pammy_panel;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE panel.monitor_baseline TO pammy_panel;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE panel.monitor_checks TO pammy_panel;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE panel.monitor_events TO pammy_panel;
GRANT SELECT,USAGE ON SEQUENCE panel.monitor_events_id_seq TO pammy_panel;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE panel.monitor_mail TO pammy_panel;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE panel.monitor_quiet TO pammy_panel;
GRANT SELECT,USAGE ON SEQUENCE panel.monitor_quiet_id_seq TO pammy_panel;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE panel.monitor_settings TO pammy_panel;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE panel.passkeys TO pammy_panel;
GRANT SELECT,USAGE ON SEQUENCE panel.passkeys_id_seq TO pammy_panel;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE panel.path_steps TO pammy_panel;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE panel.routes TO pammy_panel;
GRANT SELECT,USAGE ON SEQUENCE panel.routes_id_seq TO pammy_panel;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE panel.sessions TO pammy_panel;
GRANT SELECT,USAGE ON SEQUENCE panel.sessions_id_seq TO pammy_panel;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE panel.site_folders TO pammy_panel;
GRANT SELECT,USAGE ON SEQUENCE panel.site_folders_id_seq TO pammy_panel;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE panel.started_paths TO pammy_panel;
GRANT SELECT,USAGE ON SEQUENCE panel.started_paths_id_seq TO pammy_panel;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE panel.studio_catalog_records TO pammy_panel;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE panel.studio_databases TO pammy_panel;
GRANT SELECT,USAGE ON SEQUENCE panel.studio_databases_id_seq TO pammy_panel;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE panel.studio_db_users TO pammy_panel;
GRANT SELECT,USAGE ON SEQUENCE panel.studio_db_users_id_seq TO pammy_panel;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE panel.studio_drafts TO pammy_panel;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE panel.studio_fields TO pammy_panel;
GRANT SELECT,USAGE ON SEQUENCE panel.studio_fields_id_seq TO pammy_panel;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE panel.studio_layouts TO pammy_panel;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE panel.studio_resources TO pammy_panel;
GRANT SELECT,USAGE ON SEQUENCE panel.studio_resources_id_seq TO pammy_panel;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE panel.user_places TO pammy_panel;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE panel.user_rights TO pammy_panel;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE panel.users TO pammy_panel;
GRANT SELECT,USAGE ON SEQUENCE panel.users_id_seq TO pammy_panel;
GRANT SELECT ON TABLE public.schema_migrations TO pammy_panel;
GRANT SELECT ON TABLE public.schema_migrations TO pammy_gate;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE thumbs.thumbs TO pammy_panel;
ALTER DEFAULT PRIVILEGES FOR ROLE pammy_owner IN SCHEMA catalog GRANT SELECT,USAGE ON SEQUENCES TO pammy_panel;
ALTER DEFAULT PRIVILEGES FOR ROLE pammy_owner IN SCHEMA catalog GRANT ALL ON FUNCTIONS TO pammy_panel;
ALTER DEFAULT PRIVILEGES FOR ROLE pammy_owner IN SCHEMA catalog GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES TO pammy_panel;
ALTER DEFAULT PRIVILEGES FOR ROLE pammy_owner IN SCHEMA files GRANT SELECT,USAGE ON SEQUENCES TO pammy_panel;
ALTER DEFAULT PRIVILEGES FOR ROLE pammy_owner IN SCHEMA files GRANT ALL ON FUNCTIONS TO pammy_panel;
ALTER DEFAULT PRIVILEGES FOR ROLE pammy_owner IN SCHEMA files GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES TO pammy_panel;
ALTER DEFAULT PRIVILEGES FOR ROLE pammy_owner IN SCHEMA gate GRANT SELECT,USAGE ON SEQUENCES TO pammy_gate;
ALTER DEFAULT PRIVILEGES FOR ROLE pammy_owner IN SCHEMA gate GRANT ALL ON FUNCTIONS TO pammy_gate;
ALTER DEFAULT PRIVILEGES FOR ROLE pammy_owner IN SCHEMA gate GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES TO pammy_gate;
ALTER DEFAULT PRIVILEGES FOR ROLE pammy_owner IN SCHEMA media GRANT SELECT,USAGE ON SEQUENCES TO pammy_panel;
ALTER DEFAULT PRIVILEGES FOR ROLE pammy_owner IN SCHEMA media GRANT ALL ON FUNCTIONS TO pammy_panel;
ALTER DEFAULT PRIVILEGES FOR ROLE pammy_owner IN SCHEMA media GRANT SELECT ON TABLES TO pammy_panel;
ALTER DEFAULT PRIVILEGES FOR ROLE pammy_owner IN SCHEMA panel GRANT SELECT,USAGE ON SEQUENCES TO pammy_panel;
ALTER DEFAULT PRIVILEGES FOR ROLE pammy_owner IN SCHEMA panel GRANT ALL ON FUNCTIONS TO pammy_panel;
ALTER DEFAULT PRIVILEGES FOR ROLE pammy_owner IN SCHEMA panel GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES TO pammy_panel;
ALTER DEFAULT PRIVILEGES FOR ROLE pammy_owner IN SCHEMA thumbs GRANT SELECT,USAGE ON SEQUENCES TO pammy_panel;
ALTER DEFAULT PRIVILEGES FOR ROLE pammy_owner IN SCHEMA thumbs GRANT ALL ON FUNCTIONS TO pammy_panel;
ALTER DEFAULT PRIVILEGES FOR ROLE pammy_owner IN SCHEMA thumbs GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES TO pammy_panel;
ALTER DEFAULT PRIVILEGES FOR ROLE pammy_owner REVOKE ALL ON FUNCTIONS FROM PUBLIC;

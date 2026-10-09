// The schema canvas (docs/databases-plan.md 6). A second surface on the very
// same drawing the Tables list edits -- not a second editor and not a picture
// of the database: "opening the canvas shows customers" (D5).
//
// Two habits it inherits from the Tables page and must not break:
//
//  * **Nothing here changes her database.** Dragging, adding, removing -- all of
//    it is the draft, until Apply on Review.
//  * **Where the rectangles are is not one of her changes.** Positions save on
//    their own and survive Discard, so tidying up her drawing never costs her
//    the arrangement (src/studio/layout.ts).
import {
  applyNodeChanges, Background, Controls, Handle, Position, ReactFlow, ReactFlowProvider, useReactFlow,
  type Edge, type Node, type NodeChange, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  ArrowRight, Copy, Eye, KeyRound, Link2, List as ListIcon, MoreHorizontal, PencilLine, Plus, Table2, Trash2, Wand2,
} from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppOwnedNote } from '../components/app-owned';
import { Link, useNavigate, useParams } from 'react-router';
import { AddFieldDialog, type NewField } from '../components/add-field';
import { useDialogs } from '@panel/core/web/components/dialogs';
import { InlineLink, Loading, Page, Section } from '@panel/core/web/components/page';
import { Badge } from '@panel/core/web/components/ui/badge';
import { Button } from '@panel/core/web/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@panel/core/web/components/ui/dropdown-menu';
import { useAction } from '@panel/core/web/hooks/useAction';
import { useApi, usePageTitle } from '@panel/core/web/hooks/useApi';
import { api, plural } from '@panel/core/web/lib/api';
import { notify } from '@panel/core/web/lib/status';
import { ConnectDialog, Relationships } from '../components/relationships';
import {
  clonedTable, copyName, drawnLine, isNew, newIdentProblem, nextTableName, pointingAt, renamedTable, starterTable,
  typeLabel, withoutTable,
  type CanvasView, type DatabaseEngine, type SchemaData, type SchemaLayout, type SchemaTable,
} from '../lib/schema';

// How long after she stops dragging the positions are written down. Long enough
// that a drag across the canvas is one save rather than fifty, short enough that
// letting go and closing the tab keeps where she put it.
const SETTLE = 600;

type TableNodeData = { table: SchemaTable; brandNew: boolean };

// What a rectangle's menu can do. Handed down through context rather than in
// each node's data, so the nodes are not all rebuilt whenever the page is.
type TableMoves = {
  rename: (t: SchemaTable) => void;
  clone: (t: SchemaTable) => void;
  remove: (t: SchemaTable) => void;
  addField: (t: SchemaTable) => void;
  connect: (t: SchemaTable) => void;
  fields: (t: SchemaTable) => void;
};
const Moves = createContext<TableMoves | null>(null);

// The little menu in a rectangle's corner. `nodrag`/`nopan` so pressing it is
// a press, not the start of dragging the table or the canvas; not modal, so a
// window it opens (Rename, Add field) is not left behind an inert page.
function TableMenu({ table }: { table: SchemaTable }) {
  const moves = useContext(Moves);
  if (!moves) return null;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={`Options for ${table.name}`}
          className="nodrag nopan -mr-1.5 grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring data-[state=open]:bg-accent data-[state=open]:text-foreground">
          <MoreHorizontal className="size-4" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onCloseAutoFocus={(e) => e.preventDefault()}>
        <DropdownMenuItem onSelect={() => moves.addField(table)}><Plus />Add field</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => moves.connect(table)}><Link2 />Connect to another table</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => moves.fields(table)}><ListIcon />Open the Fields page</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => moves.rename(table)}><PencilLine />Rename</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => moves.clone(table)}><Copy />Make a copy</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => moves.remove(table)}><Trash2 />Delete table</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// One table, as a rectangle. Deliberately the same few facts the product plan
// asks for -- name, type, key, required -- and nothing else: defaults, lengths
// and indexes live on the Fields page, or the canvas becomes a second editor.
function TableNode({ data, selected }: NodeProps & { data: TableNodeData }) {
  const { table, brandNew } = data;
  const keys = new Set(table.primaryKey);
  const linked = new Set(table.foreignKeys.flatMap((f) => f.columns));
  return (
    <div className={`w-64 rounded-lg border bg-card text-left shadow-sm ${selected ? 'border-primary ring-2 ring-primary/30' : 'border-border'}`}>
      <Ends />
      <div className="flex items-center gap-2 rounded-t-lg border-b border-border bg-muted/40 px-3 py-2">
        <Table2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate text-sm font-semibold">{table.name}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {brandNew && <Badge variant="outline">new</Badge>}
          <TableMenu table={table} />
        </span>
      </div>
      <ul className="divide-y divide-border/60">
        {table.columns.slice(0, 8).map((c) => (
          <li key={c.name} className="flex items-center gap-2 px-3 py-1.5 text-xs">
            {keys.has(c.name)
              ? <KeyRound className="size-3 shrink-0 text-primary" aria-label="primary key" />
              : linked.has(c.name)
                ? <Link2 className="size-3 shrink-0 text-muted-foreground" aria-label="relationship" />
                : <span className="size-3 shrink-0" aria-hidden />}
            <span className="truncate font-medium">{c.name}</span>
            <span className="ml-auto shrink-0 text-muted-foreground">{typeLabel(c)}</span>
            {c.required && <span className="shrink-0 text-muted-foreground" title="required">*</span>}
          </li>
        ))}
        {table.columns.length > 8 && (
          <li className="px-3 py-1.5 text-xs text-muted-foreground">…and {table.columns.length - 8} more</li>
        )}
        {table.columns.length === 0 && <li className="px-3 py-1.5 text-xs text-muted-foreground">No fields yet</li>}
      </ul>
    </div>
  );
}

const nodeTypes = { table: TableNode };

// Where a line may meet a rectangle: the middle of either side. React Flow will
// not draw a line to a node that has nowhere for it to end, so without these
// no connection was ever drawn. They are only ends for lines -- she connects
// tables from the menu, where the questions are, not by dragging between dots.
const SIDES = [['left', Position.Left], ['right', Position.Right]] as const;
function Ends() {
  return <>{SIDES.flatMap(([side, position]) => (['source', 'target'] as const).map((type) => (
    <Handle key={`${type}-${side}`} id={`${type}-${side}`} type={type} position={position}
      isConnectable={false} className="!pointer-events-none !opacity-0" />
  )))}</>;
}

// The ends of a line say what kind of connection it is, the way database
// drawings usually do: a bar is "one", a crow's foot is "many". Drawn once and
// used by every line; a second set in the highlight colour for the lines of the
// table she has picked.
function LineEnds() {
  const end = (id: string, color: string, many: boolean) => (
    <marker key={id} id={id} viewBox="0 0 16 16" refX="15" refY="8" markerWidth="16" markerHeight="16"
      markerUnits="userSpaceOnUse" orient="auto-start-reverse">
      <g fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round">
        {many
          ? <path d="M15 1.5 L4 8 L15 14.5 M4 8 H15" />
          : <path d="M8 2.5 V13.5 M11 2.5 V13.5" />}
      </g>
    </marker>
  );
  return (
    <svg width="0" height="0" className="absolute" aria-hidden>
      <defs>
        {end('end-one', 'var(--muted-foreground)', false)}
        {end('end-many', 'var(--muted-foreground)', true)}
        {end('end-one-picked', 'var(--primary)', false)}
        {end('end-many-picked', 'var(--primary)', true)}
      </defs>
    </svg>
  );
}

// The key under the drawing: what the two ends mean, in her words.
function LineKey() {
  const sample = (many: boolean) => (
    <svg width="44" height="16" viewBox="0 0 44 16" aria-hidden className="shrink-0">
      <line x1="0" y1="8" x2="43" y2="8" stroke="var(--muted-foreground)" strokeWidth="1.5" markerEnd={`url(#end-${many ? 'many' : 'one'})`} />
    </svg>
  );
  return (
    <p className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-border px-4 py-2 text-xs text-muted-foreground">
      <span className="flex items-center gap-2">{sample(false)}one</span>
      <span className="flex items-center gap-2">{sample(true)}many</span>
      <span>A line from one table to another reads from end to end: one recipe has many guests.</span>
    </p>
  );
}

function Canvas() {
  const { engine, name } = useParams<{ engine: DatabaseEngine; name: string }>();
  usePageTitle(name ? `${name} canvas` : 'Canvas');
  const base = `/api/databases/${engine}/${name}`;
  const data = useApi<SchemaData>(`${base}/schema`);
  const run = useAction();
  const dialogs = useDialogs();
  const flow = useReactFlow();
  const navigate = useNavigate();

  const d = data.data;
  const tables = useMemo(() => d?.draft.tables ?? [], [d]);
  const changes = d?.plan.changes ?? [];

  const [picked, setPicked] = useState<string | null>(null);
  // where the rectangles are, as the server (or Tidy up) last gave them: a new
  // copy here redraws the canvas. `latest` also follows her drags, unsaved yet.
  const [spots, setSpots] = useState<SchemaLayout['tables']>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<SchemaLayout['tables']>({});

  useEffect(() => { if (d) { setSpots(d.layout.tables); latest.current = d.layout.tables; } }, [d?.layout]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  // Saved on its own, and quietly: a position is not a change to announce.
  const saveSpots = useCallback((next: SchemaLayout['tables']) => {
    latest.current = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void api(`${base}/schema/layout`, { layout: { tables: latest.current } })
        .catch(() => notify("Where you put the tables could not be saved just now. They will be where they were when you come back.", 'error'));
    }, SETTLE);
  }, [base]);

  // In `simple` the connecting table is hidden and a many-to-many is ONE line
  // between the two outer tables; in `expanded` the real three rectangles are
  // there. Both are the same drawing -- hiding a junction never deletes it
  // (docs/databases-plan.md 7).
  const view: CanvasView = d?.layout.manyToMany ?? 'simple';
  const hidden = useMemo(() => new Set(
    view === 'simple' ? d?.relationships.flatMap((r) => (r.junction ? [r.junction] : [])) ?? [] : []),
  [view, d]);
  const shown = useMemo(() => tables.filter((t) => !hidden.has(t.name)), [tables, hidden]);

  // The nodes React Flow draws are kept here and changed by its own changes
  // (applyNodeChanges), not rebuilt from `spots` on every frame of a drag. A
  // rebuilt node has lost the size React Flow measured, and React Flow hides
  // an unmeasured node (and the lines to it) until it has measured it again --
  // which is what made the whole canvas flicker while dragging.
  const [nodes, setNodes] = useState<Node[]>([]);
  useEffect(() => {
    setNodes((prev) => {
      const had = new Map(prev.map((n) => [n.id, n]));
      return shown.map((t) => ({
        ...had.get(t.name),
        id: t.name,
        type: 'table',
        // latest, not spots: a drag moves latest but not spots, and picking a
        // table rebuilds these -- spots would put the dragged one back
        position: latest.current[t.name] ?? had.get(t.name)?.position ?? { x: 0, y: 0 },
        selected: picked === t.name,
        data: { table: t, brandNew: !!d && isNew(d.current, t) } satisfies TableNodeData,
      }));
    });
  }, [shown, spots, picked, d]);

  // A table she has just added or copied is placed where there is room, which
  // may be outside the part of the drawing on screen. Once it has been drawn
  // and measured, the view moves to take it in -- along with the one it was
  // copied from, so she sees the two side by side.
  const [reveal, setReveal] = useState<string[] | null>(null);
  useEffect(() => {
    if (!reveal) return;
    const ready = reveal.every((id) => nodes.find((n) => n.id === id)?.measured?.width);
    if (!ready) return;
    setReveal(null);
    void flow.fitView({ nodes: reveal.map((id) => ({ id })), padding: 0.3, maxZoom: 1, duration: 250 });
  }, [reveal, nodes, flow]);

  // One line per connection. Each end is marked "one" or "many" (LineEnds),
  // and a line leaves from the side of a rectangle that faces the other one --
  // worked out from where they are now, so it follows a drag.
  const edges: Edge[] = useMemo(() => {
    const at = new Map(nodes.map((n) => [n.id, n.position.x + (n.measured?.width ?? 256) / 2]));
    // No words on the lines: on a short one they sit on top of it. The ends say
    // what kind it is, the key under the drawing says what the ends mean, and
    // the Connections list says it in sentences.
    const line = (id: string, source: string, target: string, ends: [boolean, boolean]): Edge => {
      const facing = (at.get(source) ?? 0) <= (at.get(target) ?? 0);
      const lit = picked !== null && (source === picked || target === picked);
      const mark = (many: boolean) => `end-${many ? 'many' : 'one'}${lit ? '-picked' : ''}`;
      return {
        id, source, target, type: 'smoothstep',
        sourceHandle: source === target || facing ? 'source-right' : 'source-left',
        targetHandle: source === target || !facing ? 'target-right' : 'target-left',
        markerStart: mark(ends[0]), markerEnd: mark(ends[1]),
        style: { stroke: lit ? 'var(--primary)' : 'var(--muted-foreground)', strokeWidth: lit ? 2 : 1.5 },
        zIndex: lit ? 1 : 0,
        data: { kind: ends[0] && ends[1] ? 'many-to-many' : ends[0] ? 'one-to-many' : 'one-to-one' },
      };
    };
    const have = new Set(shown.map((t) => t.name));
    return (d?.relationships ?? []).flatMap((r) => {
      const id = r.at.map((x) => `${x.table}:${x.foreignKey}`).join('+');
      if (r.junction && view === 'simple') {
        return have.has(r.from) && have.has(r.to) ? [line(id, r.from, r.to, [true, true])] : [];
      }
      // expanded, or a plain relationship: the line runs from the table holding
      // the connection (the "many" end, unless it is one of each) to the one it
      // points at (always "one")
      return r.at.flatMap((a) => {
        const holder = r.junction ?? r.to;
        const points = r.junction
          ? (a.foreignKey === r.at[0]!.foreignKey ? r.from : r.to)
          : r.from;
        return have.has(holder) && have.has(points)
          ? [line(`${a.table}:${a.foreignKey}`, holder, points, [r.kind !== 'one-to-one', false])]
          : [];
      });
    });
  }, [d, shown, view, nodes, picked]);

  const onNodesChange = useCallback((changesIn: NodeChange[]) => {
    setNodes((ns) => applyNodeChanges(changesIn, ns));
    let moved: SchemaLayout['tables'] | null = null;
    for (const c of changesIn) {
      if (c.type === 'position' && c.position) {
        moved = { ...(moved ?? latest.current), [c.id]: { x: Math.round(c.position.x), y: Math.round(c.position.y) } };
      }
      if (c.type === 'select') setPicked((p) => (c.selected ? c.id : p === c.id ? null : p));
    }
    // only the save needs the new positions; the canvas already has them
    if (moved) saveSpots(moved);
  }, [saveSpots]);

  const addTable = async () => {
    if (!d) return;
    const typed = await dialogs.prompt({
      title: 'What is the new table called?',
      label: 'Table name',
      value: nextTableName(tables),
      hint: 'Lowercase letters, digits and underscores — usually the plural of what it holds, like recipes or guests.',
      action: 'Add it',
    });
    if (typed === null) return;
    const clean = typed.trim();
    const problem = newIdentProblem(clean, 'table');
    if (problem) return notify(problem, 'error');
    if (tables.some((t) => t.name === clean)) return notify(`There is already a table called ${clean}.`, 'error');
    const saved = await run(() => api(`${base}/schema/draft`, { draft: { ...d.draft, tables: [...tables, starterTable(clean)] }, basedOn: d.currentHash }),
      `${clean} is in your drawing. Nothing has changed in the database yet.`);
    if (saved === undefined) return;
    setPicked(clean);
    setReveal([clean]);
  };

  // Every move from a rectangle's menu is the same as on the Tables list:
  // change the drawing, send the whole thing back.
  const save = (next: SchemaTable[], done: string, extra: Record<string, unknown> = {}) =>
    run(() => api(`${base}/schema/draft`, { draft: { ...d!.draft, tables: next }, basedOn: d!.currentHash, ...extra }), done);

  const [adding, setAdding] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const addingTo = tables.find((t) => t.name === adding) ?? null;

  const addField = async ({ column, unique }: NewField): Promise<boolean> => {
    const t = addingTo;
    if (!d || !t) return false;
    const next: SchemaTable = {
      ...t,
      columns: [...t.columns, column],
      uniques: unique ? [...t.uniques, { name: `${t.name}_${column.name}_key`.slice(0, 63), columns: [column.name] }] : t.uniques,
    };
    const saved = await save(tables.map((x) => (x.name === t.name ? next : x)),
      `${column.name} is in ${t.name} in your drawing. Nothing has changed in the database yet.`);
    return saved !== undefined;
  };

  const renameTable = async (t: SchemaTable) => {
    if (!d) return;
    const typed = await dialogs.prompt({
      title: `What should ${t.name} be called?`,
      label: 'Table name',
      value: t.name,
      hint: isNew(d.current, t)
        ? 'Lowercase letters, digits and underscores.'
        : 'Its rows stay as they are. Anything outside the panel that asks for this table by name will have to be changed too.',
      action: 'Rename it',
    });
    if (typed === null) return;
    const clean = typed.trim();
    if (clean === t.name) return;
    const problem = newIdentProblem(clean, 'table');
    if (problem) return notify(problem, 'error');
    if (tables.some((x) => x.name === clean)) return notify(`There is already a table called ${clean}.`, 'error');
    const at = latest.current[t.name];
    await save(renamedTable(d.current, tables, t.name, clean),
      `It is called ${clean} in your drawing. Nothing has changed in the database yet.`,
      { renamed: { from: t.name, to: clean, at } });
    if (picked === t.name) setPicked(clean);
  };

  // A copy of the design, not of the rows (lib/schema.ts clonedTable). Placed
  // by the panel, like any new table, so it never lands on top of another.
  const cloneTable = async (t: SchemaTable) => {
    if (!d) return;
    const typed = await dialogs.prompt({
      title: `Make a copy of ${t.name}`,
      body: `The copy has the same fields, key and connections as ${t.name}, and no rows: it starts empty, like any new table.`,
      label: 'Name of the copy',
      value: copyName(tables, t.name),
      action: 'Make the copy',
    });
    if (typed === null) return;
    const clean = typed.trim();
    const problem = newIdentProblem(clean, 'table');
    if (problem) return notify(problem, 'error');
    if (tables.some((x) => x.name === clean)) return notify(`There is already a table called ${clean}.`, 'error');
    const made = clonedTable(t, clean);
    if ('problem' in made) return notify(made.problem, 'error');
    const left = made.left.length ? ` ${made.left.join(', ')} ${made.left.length === 1 ? 'is a kind of field' : 'are kinds of field'} the panel does not make, so the copy is without ${made.left.length === 1 ? 'it' : 'them'}.` : '';
    const saved = await save([...tables, made.table], `${clean} is in your drawing.${left} Nothing has changed in the database yet.`);
    if (saved === undefined) return;
    setPicked(clean);
    setReveal([t.name, clean]);
  };

  const removeTable = async (t: SchemaTable) => {
    if (!d) return;
    const brandNew = isNew(d.current, t);
    const pointing = pointingAt(tables, t.name);
    const loses = pointing.length > 0 && (
      <p>
        {pointing.length === 1 ? 'One connection points' : `${plural(pointing.length, 'connection')} point`} at it, and
        {pointing.length === 1 ? ' goes' : ' go'} too: {pointing.map((p) => `${p.table}.${p.columns.join(', ')}`).join('; ')}.
        The {pointing.length === 1 ? 'field stays' : 'fields stay'}; {pointing.length === 1 ? 'it just stops' : 'they just stop'} pointing at {t.name}.
      </p>
    );
    const ok = await dialogs.confirm({
      title: brandNew ? `Take ${t.name} out of the drawing?` : `Delete the table ${t.name}?`,
      body: <>
        <p>{brandNew
          ? 'It was never made, so there is nothing in it to lose.'
          : <>This goes on the list of changes. Nothing happens until you apply them — and when you do, <strong>every row in {t.name} is deleted</strong>.</>}</p>
        {loses}
      </>,
      action: brandNew ? 'Take it out' : 'Add it to the changes',
      danger: !brandNew,
    });
    if (!ok) return;
    await save(withoutTable(tables, t.name),
      brandNew ? `${t.name} is out of the drawing.` : `Deleting ${t.name} is on the list of changes. Nothing has changed in the database yet.`);
    if (picked === t.name) setPicked(null);
  };

  const moves = useMemo<TableMoves>(() => ({
    rename: (t) => void renameTable(t),
    clone: (t) => void cloneTable(t),
    remove: (t) => void removeTable(t),
    addField: (t) => setAdding(t.name),
    connect: (t) => setConnecting(t.name),
    fields: (t) => navigate(`/databases/${engine}/${name}/tables/${t.name}`),
  // the moves read the drawing they were made with, so they are made again with each new one
  }), [d, picked]);                                        // eslint-disable-line react-hooks/exhaustive-deps

  // Lay them out again in reading order. Worked out on the server so a first
  // visit and this button arrange tables the same way.
  const tidy = async () => {
    const ok = await dialogs.confirm({
      title: 'Tidy up the drawing?',
      body: 'Every table goes back into neat rows, in the order they are in the database. Nothing about the database itself changes.',
      action: 'Tidy it up',
    });
    if (!ok) return;
    const r = await run(() => api<{ layout: SchemaLayout }>(`${base}/schema/tidy`, {}), 'Tidied up.');
    if (r) { setSpots(r.layout.tables); latest.current = r.layout.tables; setTimeout(() => flow.fitView({ padding: 0.2 }), 0); }
  };

  // Saved beside the positions: it is how the drawing is looked at, not part of
  // the drawing, so it survives Discard like everything else in the layout.
  const setView = (next: CanvasView) =>
    run(() => api(`${base}/schema/layout`, { manyToMany: next }),
      next === 'simple' ? 'Connecting tables are tucked away.' : 'Showing every table, connecting ones included.');


  return (
    <Page title={name ?? ''} wide
      intro={<>
        <InlineLink to="/databases">Your databases</InlineLink>
        {d ? ` · ${d.engine === 'postgres' ? 'Postgres' : 'MariaDB'}` : ''}
        {' · '}Drag the tables around. Where you put them is remembered.
      </>}
      actions={<div className="flex flex-wrap gap-2">
        <Button variant="outline" asChild><Link to={`/databases/${engine}/${name}`}><ListIcon />Tables list</Link></Button>
        <Button onClick={addTable} disabled={!d}><Plus />Add table</Button>
      </div>}>
      <AppOwnedNote engine={engine} name={name} />

      {!d ? <Loading /> : <>
        {d.drift && (
          <Section title="This database changed somewhere else" className="border-destructive/40">
            <p className="text-sm">
              Something changed {name} after you started drawing. Your drawing is still here, but it was
              worked out from how the database used to be.
            </p>
          </Section>
        )}

        {changes.length > 0 && (
          <Section title="Not applied yet"
            intro={drawnLine(changes.length, d.app)}
            action={<Button asChild><Link to={`/databases/${engine}/${name}/review`}><Eye />Review changes<ArrowRight /></Link></Button>} />
        )}

        <Section flush title="The drawing"
          action={<div className="flex flex-wrap gap-2">
            {d.relationships.some((r) => r.junction) && (
              <Button variant="outline" size="sm" onClick={() => void setView(view === 'simple' ? 'expanded' : 'simple')}>
                <Link2 />{view === 'simple' ? 'Show connecting tables' : 'Tuck connecting tables away'}
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => flow.fitView({ padding: 0.2 })}>Fit to screen</Button>
            <Button variant="outline" size="sm" onClick={() => void tidy()}><Wand2 />Tidy up</Button>
          </div>}>
          <div className="relative h-[32rem] w-full" data-testid="canvas" role="application" aria-label="Schema canvas">
            <LineEnds />
            <Moves.Provider value={moves}>
            <ReactFlow
              nodes={nodes} edges={edges} nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onPaneClick={() => setPicked(null)}
              // Deleting a table is a change to her drawing, asked about from its
              // menu -- never a stray Backspace while a table happens to be picked.
              deleteKeyCode={null}
              fitView proOptions={{ hideAttribution: false }}
              minZoom={0.2} maxZoom={1.75}>
              <Background />
              <Controls showInteractive={false} />
            </ReactFlow>
            </Moves.Provider>
          </div>
          {d.relationships.length > 0 && <LineKey />}
        </Section>

        <AddFieldDialog table={addingTo} live={!!addingTo && !isNew(d.current, addingTo)}
          onClose={() => setAdding(null)} onAdd={addField} />

        <ConnectDialog base={base} d={d} table={connecting ?? undefined} open={connecting !== null}
          onClose={() => setConnecting(null)} />

        <Relationships base={base} d={d} />

      </>}
    </Page>
  );
}

// React Flow needs its provider above anything calling useReactFlow.
export default function DatabaseCanvas() {
  return <ReactFlowProvider><Canvas /></ReactFlowProvider>;
}

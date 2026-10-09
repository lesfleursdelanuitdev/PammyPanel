// "New file" in the File Explorer (docs/editor-plan.md D3): a name and what to
// start from, then the file is made (never over an existing one) and opened in
// the editor.
import { FilePlus } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Field } from '@panel/core/web/components/page';
import { Button } from '@panel/core/web/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@panel/core/web/components/ui/dialog';
import { Input } from '@panel/core/web/components/ui/input';
import { api, ApiError, friendlyError, signedOut } from '@panel/core/web/lib/api';
import { W } from '@panel/core/web/lib/site';
import { editorHref, isEditable, newFileName, specialName, templateText, TEMPLATES, type Template } from '../../lib/editor';
import { notify } from '@panel/core/web/lib/status';
import { cn } from '@panel/core/web/lib/utils';

export function NewFileDialog({ dir, hasStyle, onClose }: { dir: string; hasStyle: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [template, setTemplate] = useState<Template>('page');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const name = newFileName(typed, template);
  const special = name ? specialName(name) : null;
  const where = dir ? dir.split('/').join(' › ') : W.website.top;

  const make = async () => {
    if (!name) return;
    if (!isEditable(name)) { setProblem('The editor makes files ending in .html, .css, .js, .txt, .md, .json, .xml or .svg.'); return; }
    setBusy(true);
    setProblem(null);
    try {
      const path = dir ? `${dir}/${name}` : name;
      const r = await api<{ path: string; name: string }>('/api/files/save', { path, text: templateText(template, name, hasStyle), create: 'exact' });
      notify(`"${r.name}" made.`);
      navigate(editorHref(r.path));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) { signedOut(); return; }
      setProblem(err instanceof ApiError && err.status === 409 ? `There's already something called "${name}" here. Choose another name.` : friendlyError(err));
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent>
        <form onSubmit={(e) => { e.preventDefault(); void make(); }} className="contents">
          <DialogHeader>
            <DialogTitle>New file</DialogTitle>
            <DialogDescription>In {where}. It opens in the editor once it's made.</DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-4">
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-semibold">Start with</legend>
              {TEMPLATES.map((t) => (
                <label key={t.id} className={cn('flex cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-2.5', template === t.id && 'border-primary bg-primary-soft')}>
                  <input type="radio" name="nf-template" value={t.id} checked={template === t.id} onChange={() => setTemplate(t.id)} className="mt-1 accent-[var(--primary)]" />
                  <span><span className="block font-medium">{t.label}</span><span className="block text-sm text-muted-foreground">{t.hint}</span></span>
                </label>
              ))}
            </fieldset>
            <Field label="Name" htmlFor="nf-name">
              <Input id="nf-name" autoFocus maxLength={120} autoComplete="off" spellCheck={false} value={typed} onChange={(e) => { setTyped(e.target.value); setProblem(null); }}
                placeholder={template === 'css' ? 'style.css' : template === 'page' ? 'about.html' : 'notes.txt'} />
            </Field>
            {name && name !== typed.trim() && <p className="text-sm text-muted-foreground">It will be called <strong>{name}</strong>.</p>}
            {special && <p className="text-sm text-muted-foreground">{special}</p>}
            {problem && <p role="alert" className="text-sm font-semibold text-destructive">{problem}</p>}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy || !name}><FilePlus />{busy ? 'Making it…' : 'Make and open'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import { localiseError } from '../i18n-messages.js';
import { Button } from '../routes/ui.js';
import { Dialog } from './Dialog.js';
import { controlCls, inputCls, smallBtn } from './fields.js';
import {
  flatten,
  insertFromLibrary,
  libraryContentOf,
  type Draft,
  type LibraryContent,
  type TreeNode,
} from './tree.js';
import { nodeLabel, nodeName } from './vars.js';

export interface LibraryItem {
  id: string;
  name: string;
  description: string | null;
  tags: string[];
  languages: string[];
  content: LibraryContent;
  createdBy: string | null;
  updatedAt: string;
}

/** Saves an item, block or roster (with its answer sets) to the organisation's library. */
export function SaveToLibraryDialog({
  draft,
  id,
  onClose,
  onSaved,
}: {
  draft: Draft;
  id: string;
  onClose(): void;
  onSaved(message: string): void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const content = libraryContentOf(draft, id);
  const [name, setName] = useState(content ? nodeName(content.node) : id);
  const [description, setDescription] = useState(
    content ? nodeLabel(content.node, draft.defaultLanguage) : '',
  );
  const [tags, setTags] = useState('');
  const [error, setError] = useState('');
  const save = useMutation({
    mutationFn: () =>
      api('/library', {
        method: 'POST',
        body: {
          name,
          description: description || null,
          tags: tags
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean),
          languages: draft.languages,
          content,
        },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['library'] });
      onSaved(t('designer.library.saved'));
    },
    onError: (e) => setError(localiseError(t, e)),
  });
  if (!content) return null;
  return (
    <Dialog title={t('designer.library.saveTitle', { id })} onClose={onClose}>
      <form
        className="flex flex-col gap-3 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) save.mutate();
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="font-medium">{t('designer.library.name')}</span>
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-medium">{t('designer.library.description')}</span>
          <textarea
            className={`${inputCls} min-h-[3.5rem]`}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-medium">{t('designer.library.tags')}</span>
          <input className={inputCls} value={tags} onChange={(e) => setTags(e.target.value)} />
        </label>
        <p role="status" aria-live="polite" className="text-red-800">
          {error}
        </p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('designer.library.cancel')}
          </Button>
          <Button type="submit" disabled={!name.trim() || save.isPending}>
            {t('designer.library.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Search, preview and insert a library entry after the selected outline row. */
export function InsertFromLibraryDialog({
  draft,
  afterId,
  inside,
  onClose,
  onInsert,
}: {
  draft: Draft;
  afterId: string | null;
  inside: boolean;
  onClose(): void;
  onInsert(next: Draft, newId: string, message: string): void;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [tag, setTag] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
  useEffect(() => {
    const id = setTimeout(() => setTerm(search.trim()), 250);
    return () => clearTimeout(id);
  }, [search]);
  const items = useQuery({
    queryKey: ['library', term, tag],
    queryFn: () =>
      api<LibraryItem[]>(
        `/library?${new URLSearchParams({ ...(term ? { q: term } : {}), ...(tag ? { tag } : {}) })}`,
      ),
    placeholderData: (prev) => prev,
  });
  const allTags = useQuery({
    queryKey: ['library', '', ''],
    queryFn: () => api<LibraryItem[]>('/library'),
  });
  const tags = [...new Set((allTags.data ?? []).flatMap((i) => i.tags))].sort();
  const list = items.data ?? [];
  const pick = list.find((i) => i.id === chosen) ?? list[0] ?? null;
  const lang = draft.defaultLanguage;
  const rows = pick
    ? flatten({
        sections: [{ id: '_', title: {}, items: [pick.content.node] }],
      } as unknown as Draft).slice(1)
    : [];

  const insert = (item: LibraryItem) => {
    const r = insertFromLibrary(draft, afterId, item.content, { inside });
    const renamed = Object.entries(r.renamed).map(([a, b]) => `${a} → ${b}`);
    onInsert(
      r.draft,
      r.newId,
      [
        t('designer.library.inserted', { name: item.name }),
        ...(renamed.length ? [t('designer.library.renamed', { list: renamed.join(', ') })] : []),
      ].join(' '),
    );
  };

  return (
    <Dialog title={t('designer.library.title')} onClose={onClose} wide>
      <div className="flex flex-col gap-3 text-sm">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="font-medium">{t('designer.library.search')}</span>
            <input
              type="search"
              className={`${inputCls} w-64`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-medium">{t('designer.library.tag')}</span>
            <select
              className={`${controlCls} w-auto`}
              value={tag}
              onChange={(e) => setTag(e.target.value)}
            >
              <option value="">{t('designer.library.anyTag')}</option>
              {tags.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </label>
        </div>
        {list.length ? (
          <div className="grid gap-3 md:grid-cols-[16rem_minmax(0,1fr)]">
            <ul className="flex flex-col gap-1" aria-label={t('designer.library.title')}>
              {list.map((i) => (
                <li key={i.id}>
                  <button
                    type="button"
                    aria-pressed={pick?.id === i.id}
                    className="w-full rounded-md border border-slate-200 px-2 py-1.5 text-left hover:bg-indigo-50 aria-pressed:border-indigo-400 aria-pressed:bg-indigo-50"
                    onClick={() => setChosen(i.id)}
                  >
                    <span className="block font-medium">{i.name}</span>
                    {i.tags.length ? (
                      <span className="block text-xs text-slate-600">{i.tags.join(' · ')}</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
            {pick ? (
              <section
                aria-label={t('designer.library.preview', { name: pick.name })}
                className="flex flex-col gap-2 rounded-md border border-slate-200 p-3"
                data-testid="library-preview"
              >
                <h3 className="font-semibold">{pick.name}</h3>
                {pick.description ? <p className="text-slate-700">{pick.description}</p> : null}
                <p className="text-xs text-slate-600">
                  {t('designer.library.languages', { langs: pick.languages.join(', ') })} ·{' '}
                  {t('designer.library.items', { count: rows.length })}
                </p>
                <ul className="flex flex-col gap-0.5 rounded bg-slate-50 p-2">
                  {rows.map(({ node, depth }) => (
                    <li key={node.id} style={{ paddingLeft: `${(depth - 1) * 1}rem` }}>
                      <span className="font-mono">{nodeName(node as TreeNode)}</span>{' '}
                      <span className="text-slate-600">{nodeLabel(node as TreeNode, lang)}</span>
                    </li>
                  ))}
                </ul>
                <div>
                  <Button type="button" onClick={() => insert(pick)}>
                    {t('designer.library.insertThis', { name: pick.name })}
                  </Button>
                </div>
              </section>
            ) : null}
          </div>
        ) : (
          <p className="text-slate-600">{t('designer.library.empty')}</p>
        )}
        <div className="flex justify-end">
          <button type="button" className={smallBtn} onClick={onClose}>
            {t('designer.library.cancel')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

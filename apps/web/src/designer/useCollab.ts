import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import type { DraftApi } from './useDraft.js';

export interface Editor {
  userId: string;
  name: string;
  itemId: string | null;
  lastSeen: string;
}

interface PresenceState {
  editors: Editor[];
  head: { draftRevision: number; updatedAt: string; updatedBy: string | null };
}

/** How often the designer says it is open and checks for newer drafts. */
export const HEARTBEAT_MS = 5000;

/**
 * Light co-editing: a heartbeat with the item being edited, the list of other editors, and
 * newer drafts pulled in as soon as they are saved (loaded, or merged with local edits).
 */
export function useCollab(
  projectId: string,
  qid: string,
  d: DraftApi,
  itemId: string | null,
  announce: (message: string) => void,
) {
  const { t } = useTranslation();
  const [editors, setEditors] = useState<Editor[]>([]);
  const ref = useRef({ d, itemId, announce, t });
  ref.current = { d, itemId, announce, t };
  const ready = !!d.doc;

  useEffect(() => {
    if (!ready) return;
    let stopped = false;
    const base = `/projects/${projectId}/questionnaires/${qid}/presence`;
    const beat = async () => {
      try {
        const { d: draft, itemId: item } = ref.current;
        const s = await api<PresenceState>(base, { method: 'PUT', body: { itemId: item } });
        if (stopped) return;
        setEditors(s.editors);
        if (s.head.draftRevision > draft.revision) {
          const outcome = await draft.sync();
          const who = s.head.updatedBy ?? '…';
          if (outcome === 'merged')
            ref.current.announce(ref.current.t('designer.collab.merged', { who }));
          if (outcome === 'loaded')
            ref.current.announce(ref.current.t('designer.collab.loaded', { who }));
        }
      } catch {
        // Offline or signed out: try again on the next beat.
      }
    };
    void beat();
    const timer = setInterval(() => void beat(), HEARTBEAT_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
      void api(base, { method: 'DELETE' }).catch(() => undefined);
    };
  }, [projectId, qid, ready]);

  // Tell the others promptly when moving to another item.
  useEffect(() => {
    if (!ready) return;
    void api(`/projects/${projectId}/questionnaires/${qid}/presence`, {
      method: 'PUT',
      body: { itemId },
    }).catch(() => undefined);
  }, [projectId, qid, itemId, ready]);

  return editors;
}

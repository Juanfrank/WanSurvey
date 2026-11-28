import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { smallBtn } from '../designer/fields.js';

/**
 * Long lists in blocks: the first `step` rows, and a "Show 20 more (35 left)" button under them.
 *
 *   const more = useShowMore(rows.length);
 *   {rows.slice(0, more.shown).map(…)}
 *   <ShowMoreButton more={more} />
 *
 * `reset` goes back to the first block (when the list is filtered or replaced).
 */
export function useShowMore(total: number, step = 20) {
  const [shown, setShown] = useState(step);
  return {
    shown,
    total,
    step,
    left: Math.max(0, total - shown),
    more: () => setShown((n) => n + step),
    reset: () => setShown(step),
  };
}

export function ShowMoreButton({
  more,
  className = '',
}: {
  more: ReturnType<typeof useShowMore>;
  className?: string;
}) {
  const { t } = useTranslation();
  if (!more.left) return null;
  return (
    <button type="button" className={`${smallBtn} self-start ${className}`} onClick={more.more}>
      {t('ui.showMore', { count: Math.min(more.step, more.left), left: more.left })}
    </button>
  );
}

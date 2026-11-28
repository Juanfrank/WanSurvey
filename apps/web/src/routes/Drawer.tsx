import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../designer/Dialog.js';

/**
 * Drawer: a panel that slides over the page from the right, for the form that creates (or
 * edits) something on a list, so the list keeps the screen instead of a form block above it.
 *
 * It is the app's modal `Dialog` laid out on the side: the focus goes into it and stays there,
 * Escape and the ✕ close it, the focus goes back to what opened it, and it is named by its
 * title. On a phone (under 640 px) it takes the whole screen. The body scrolls; `footer` (the
 * form's buttons) stays in view at the bottom.
 *
 * Mount it while open, unmount it to close:
 *
 *   const [creating, setCreating] = useState(false);
 *   <Button onClick={() => setCreating(true)}>{t('admin.webhooksPage.add')}</Button>
 *   {creating ? (
 *     <Drawer title={t('admin.webhooksPage.add')} onClose={() => setCreating(false)}>
 *       <WebhookForm onDone={() => setCreating(false)} />
 *     </Drawer>
 *   ) : null}
 *
 * A form whose submit button sits in `footer` links them with `form="<form id>"`.
 */
export function Drawer({
  title,
  onClose,
  children,
  footer,
  header,
}: {
  /** The panel's heading, which also names it for screen readers. */
  title: ReactNode;
  /** Called by Escape and by the ✕ button: unmount the drawer in it. */
  onClose(): void;
  children: ReactNode;
  /** Buttons kept at the bottom (Cancel, Save…). */
  footer?: ReactNode;
  /** Shown under the title, outside the scrolling body (a summary, tabs). */
  header?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      side
      title={title}
      onClose={onClose}
      closeLabel={t('app.close')}
      footer={footer}
      header={header}
    >
      {children}
    </Dialog>
  );
}

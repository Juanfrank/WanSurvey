import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

/**
 * Where the page's header goes: the left of the app's top row, with the account menu on the
 * right (AppLayout). Null outside the signed-in layout (tests, public pages).
 */
export const HeaderSlotContext = createContext<HTMLElement | null>(null);

/**
 * PageHeader: the page's title (its one `h1`) on the app's top row, beside the account menu,
 * instead of a row of its own under it. Two shapes:
 *
 * - A page with no breadcrumb (Home, Users, an administration page): the title, and `actions`
 *   beside it (the page's main button).
 *
 *     <PageHeader title={t('team.title')} actions={<Button onClick={invite}>…</Button>} />
 *
 * - A page inside something (a project's tab): the breadcrumb is the title. `parents` are the
 *   links before it, `title` is the `h1` (shown bold, as the breadcrumb's main step) and
 *   `current` the step after it (the open tab), marked `aria-current="page"`.
 *
 *     <PageHeader
 *       parents={[<Link to="/projects">{t('designer.projects')}</Link>]}
 *       title={<Link to="/projects/$projectId" params={{ projectId }}>{name}</Link>}
 *       icon={<ProjectLogo project={p} className="h-7 w-auto" />}
 *       current={tabLabel(tab)}
 *       aside={<DeviceStatusLink projectId={projectId} />}
 *     />
 *
 * The header is moved (a React portal) into the top row; screen readers and tests still find
 * the `h1` and the `nav` named "Breadcrumb" in `main`. Outside the app's layout it renders in
 * place. A page renders one PageHeader.
 */
export function PageHeader({
  title,
  parents,
  current,
  icon,
  aside,
  actions,
  noPrint = false,
  nowrap = false,
}: {
  /** The `h1`'s content. */
  title: ReactNode;
  /** Breadcrumb steps before the title (links). With none, there is no breadcrumb. */
  parents?: ReactNode[];
  /** The breadcrumb step after the title: where in it the page is. */
  current?: ReactNode;
  /** Shown just before the title (a logo). */
  icon?: ReactNode;
  /** Small things right after the title (a status link). */
  aside?: ReactNode;
  /** The page's main buttons, after the title. */
  actions?: ReactNode;
  /** Left out of the printout (a page that is printed, like the paper forms). */
  noPrint?: boolean;
  /**
   * The breadcrumb stays on one line: its steps shrink with an ellipsis (their full text in
   * `title`) instead of wrapping, for a narrow row (the designer beside its outline).
   */
  nowrap?: boolean;
}) {
  const { t } = useTranslation();
  const slot = useContext(HeaderSlotContext);
  const heading = (
    <h1
      className={
        parents?.length
          ? 'inline-flex min-w-0 items-center gap-2 text-lg font-bold text-navy'
          : 'text-xl font-bold min-[900px]:text-2xl'
      }
    >
      {title}
    </h1>
  );
  const body = parents?.length ? (
    <nav aria-label={t('ui.breadcrumb')} className="min-w-0 text-sm text-slate-600">
      <ol
        className={`flex min-w-0 items-center gap-x-1.5 gap-y-1 ${nowrap ? 'whitespace-nowrap' : 'flex-wrap'}`}
      >
        {parents.map((p, i) => (
          <li
            key={i}
            className={`flex items-center gap-1.5 ${nowrap ? 'min-w-[3.5rem] shrink-[4] [&>*:first-child]:min-w-0 [&>*:first-child]:truncate' : ''}`}
          >
            {p}
            <span aria-hidden="true">/</span>
          </li>
        ))}
        <li className="flex min-w-0 items-center gap-2">
          {icon}
          {heading}
          {aside}
        </li>
        {current ? (
          <li className="flex items-center gap-1.5">
            <span aria-hidden="true">/</span>
            <span aria-current="page" className="font-medium text-slate-700">
              {current}
            </span>
          </li>
        ) : null}
      </ol>
    </nav>
  ) : (
    <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
      {icon}
      {heading}
      {aside}
    </div>
  );
  const header = (
    <div
      className={`flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 ${noPrint ? 'no-print' : ''}`}
      data-page-header=""
    >
      {body}
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
  return slot ? createPortal(header, slot) : header;
}

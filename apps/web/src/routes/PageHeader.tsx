import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

/** Below this width (px) a step before the title is folded into "…" rather than cut shorter. */
const MIN_STEP = 64;

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
   * Kept for callers that ask for one line: the breadcrumb is always on one line now (its
   * steps shrink with an ellipsis instead of wrapping).
   */
  nowrap?: boolean;
}) {
  const { t } = useTranslation();
  const slot = useContext(HeaderSlotContext);
  const count = parents?.length ?? 0;
  // A state, not a ref: the header first renders in place, then again in the top row's slot.
  const [nav, setNav] = useState<HTMLElement | null>(null);
  // How many of the first steps are folded into "…" because the breadcrumb has no room.
  const [fold, setFold] = useState(0);
  // Bumped when the room or the fonts change: the breadcrumb is measured again.
  const [room, setRoom] = useState(0);
  // What the last measure was for (room and words), and with how many steps folded.
  const basis = useRef('');
  const measured = useRef(-1);
  useLayoutEffect(() => {
    const box = nav?.parentElement;
    if (!box) return;
    let width = box.clientWidth;
    const again = () => setRoom((n) => n + 1);
    const ro =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            if (box.clientWidth === width) return;
            width = box.clientWidth;
            again();
          });
    ro?.observe(box);
    const fonts = typeof document === 'undefined' ? undefined : document.fonts;
    fonts?.addEventListener('loadingdone', again);
    return () => {
      ro?.disconnect();
      fonts?.removeEventListener('loadingdone', again);
    };
  }, [nav]);
  // After a render: fold one more step while a step before the title is squeezed to a few
  // letters, or the title (or what is beside it) is cut short. The folded steps' names go in
  // the "…"'s title; a step cut short gets its whole name in its title. New room or new words
  // (another language, a name loaded) start again from the whole breadcrumb. It stops by
  // itself: `fold` only grows up to `count`, and nothing is measured twice for the same state.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- measures after renders that change it
  useLayoutEffect(() => {
    if (!nav) return;
    const steps = [...nav.querySelectorAll<HTMLElement>('[data-crumb]')];
    const main = nav.querySelector('[data-crumb-main]');
    const text = (li: HTMLElement) => li.firstElementChild?.textContent?.trim() ?? '';
    const now = `${room}|${nav.parentElement?.clientWidth ?? 0}|${steps.map(text).join('/')}|${main?.textContent ?? ''}`;
    if (now !== basis.current) {
      basis.current = now;
      measured.current = -1;
      if (fold) {
        setFold(0);
        return;
      }
    }
    if (measured.current === fold) return;
    measured.current = fold;
    const cut = (el: Element | null) =>
      !!el && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1;
    steps.forEach((li, i) => {
      if (i === fold - 1) li.title = steps.slice(0, fold).map(text).join(' / ');
      else if (i >= fold && cut(li.firstElementChild)) li.title = text(li);
      else li.removeAttribute('title');
    });
    const squeezed = steps.slice(fold).some((li) => {
      const el = li.firstElementChild;
      return !!el && el.clientWidth > 0 && el.clientWidth < Math.min(el.scrollWidth, MIN_STEP);
    });
    const mainCut = [...(main?.querySelectorAll('.truncate') ?? [])].some(cut);
    if ((squeezed || mainCut) && fold < count) setFold(fold + 1);
  });
  const heading = (
    <h1
      className={
        parents?.length
          ? // The breadcrumb's last step gives way only when nothing else can: the steps before
            // it fold first, then what is beside it (a name, shrinking 100 times faster) is cut.
            'inline-flex min-w-0 items-center gap-2 text-lg font-bold text-navy'
          : 'text-xl font-bold min-[900px]:text-2xl'
      }
    >
      {parents?.length ? <span className="min-w-0 truncate">{title}</span> : title}
    </h1>
  );
  const body = parents?.length ? (
    <nav ref={setNav} aria-label={t('ui.breadcrumb')} className="min-w-0 text-sm text-slate-600">
      {/* One line. Without room, the steps before the title give way first: they are cut short
          ("Household Su…"), then folded from the first one into one "…" (the link of the last
          folded step, their names in its title). On a phone only the title and the step after
          it (the top bar has the way back). */}
      <ol className="flex min-w-0 items-center gap-x-1.5">
        {parents.map((p, i) => (
          <li
            key={i}
            data-crumb={i === fold - 1 ? 'folded' : ''}
            className={`items-center gap-1.5 whitespace-nowrap max-sm:hidden ${
              i < fold - 1
                ? 'hidden'
                : i === fold - 1
                  ? "flex flex-none [&>:first-child]:text-[0px] [&>:first-child]:after:text-sm [&>:first-child]:after:content-['…']"
                  : 'flex min-w-0 max-w-[14rem] shrink-[1000] [&>:first-child]:truncate'
            }`}
          >
            {p}
            <span aria-hidden="true">/</span>
          </li>
        ))}
        <li className="flex min-w-0 items-center gap-2 [&>h1~*]:shrink-[100]" data-crumb-main="">
          {icon}
          {heading}
          {aside}
        </li>
        {current ? (
          <li className="flex min-w-0 flex-none items-center gap-1.5 whitespace-nowrap">
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

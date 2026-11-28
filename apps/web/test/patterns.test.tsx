import * as Tabs from '@radix-ui/react-tabs';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BulkBar, Drawer, FilterBar, MoreMenu, PageHeader } from '../src/routes/ui.js';
import { HeaderSlotContext } from '../src/routes/PageHeader.js';
import { OverflowTabList } from '../src/routes/tabs.js';

/** A list screen with a search, one filter (Status) and a tool button. */
function Screen({ onTool = () => {} }: { onTool?: () => void }) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  return (
    <>
      <FilterBar
        search={{ value: q, onChange: setQ, label: 'Search id or sample data' }}
        active={
          status
            ? [{ id: 'status', label: 'Status', value: 'Assigned', onRemove: () => setStatus('') }]
            : []
        }
        count={`${status ? 3 : 10} cases`}
        actions={
          <button type="button" onClick={onTool}>
            Rules
          </button>
        }
      >
        <label>
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any status</option>
            <option value="assigned">Assigned</option>
          </select>
        </label>
      </FilterBar>
      <button type="button">Outside</button>
      <p>Below the bar</p>
    </>
  );
}

describe('FilterBar', () => {
  it('keeps the search in view, labelled by its placeholder', () => {
    render(<Screen />);
    const search = screen.getByRole('searchbox', { name: 'Search id or sample data' });
    expect(search.getAttribute('placeholder')).toBe('Search id or sample data');
    // The filters are out of sight until asked for.
    expect(screen.queryByRole('combobox', { name: 'Status' })).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('10 cases');
    expect(screen.getByRole('button', { name: 'Rules' })).toBeTruthy();
  });

  it('opens the filters in a floating panel that takes the focus and closes with Escape', async () => {
    const user = userEvent.setup();
    render(<Screen />);
    const button = screen.getByRole('button', { name: /^Filters/ });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    const panel = document.getElementById(button.getAttribute('aria-controls')!)!;
    expect(panel.hidden).toBe(true);
    // Laid over the content, not in the flow: the panel is positioned absolutely.
    expect(panel.className).toContain('absolute');
    // The whole width on a phone.
    expect(panel.className).toMatch(/left-0 right-0/);

    await user.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(panel.hidden).toBe(false);
    const status = screen.getByRole('combobox', { name: 'Status' });
    expect(document.activeElement).toBe(status);

    await user.keyboard('{Escape}');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(panel.hidden).toBe(true);
    expect(document.activeElement).toBe(button);
  });

  it('closes on a click outside, and shows the filters that are on as removable chips', async () => {
    const user = userEvent.setup();
    render(<Screen />);
    const button = screen.getByRole('button', { name: /^Filters/ });
    await user.click(button);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'assigned');
    // The count on the button and a chip.
    expect(button.textContent).toContain('Filters · 1');
    const chips = screen.getByRole('list', { name: 'Filters on' });
    expect(chips.textContent).toContain('Status: Assigned');
    await user.click(screen.getByRole('button', { name: 'Outside' }));
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Outside' }));

    await user.click(screen.getByRole('button', { name: 'Remove filter: Status Assigned' }));
    expect(screen.queryByRole('list', { name: 'Filters on' })).toBeNull();
    expect(button.textContent).not.toContain('·');
    // The chip's button is gone: the focus goes to the Filters button, not to the page's top.
    await waitFor(() => expect(document.activeElement).toBe(button));
  });

  it('pressing the button again closes the panel', async () => {
    const user = userEvent.setup();
    render(<Screen />);
    const button = screen.getByRole('button', { name: /^Filters/ });
    await user.click(button);
    await user.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button);
  });
});

describe('BulkBar', () => {
  it('shows only with a selection, as a region named after it, fixed at the bottom', async () => {
    const onClear = vi.fn();
    const { rerender, container } = render(
      <BulkBar count={0} label="0 cases selected" onClear={onClear}>
        <button type="button">Assign</button>
      </BulkBar>,
    );
    expect(screen.queryByRole('region')).toBeNull();
    expect(container.querySelector('[data-bulk-spacer]')).toBeNull();

    rerender(
      <BulkBar count={3} label="3 cases selected" onClear={onClear}>
        <span>3 selected</span>
        <button type="button">Assign</button>
      </BulkBar>,
    );
    const bar = screen.getByRole('region', { name: '3 cases selected' });
    expect(bar.className).toContain('fixed');
    expect(bar.className).toContain('bottom-3');
    expect(within(bar).getByRole('button', { name: 'Assign' })).toBeTruthy();
    // Its height is kept free after the list, so it never covers the last row.
    expect(container.querySelector('[data-bulk-spacer]')).not.toBeNull();

    await userEvent.click(within(bar).getByRole('button', { name: 'Clear the selection' }));
    expect(onClear).toHaveBeenCalledOnce();
  });
});

describe('BulkBar focus', () => {
  it('when an action clears the selection, the focus stays where the bar was', async () => {
    function List() {
      const [n, setN] = useState(2);
      return (
        <>
          <button type="button">Top</button>
          <BulkBar count={n} label={`${n} cases selected`}>
            <button type="button" onClick={() => setN(0)}>
              Unassign
            </button>
          </BulkBar>
        </>
      );
    }
    render(<List />);
    const unassign = screen.getByRole('button', { name: 'Unassign' });
    unassign.focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.queryByRole('region')).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect((document.activeElement as HTMLElement).dataset.bulkAnchor).toBe('');
  });
});

describe('Drawer', () => {
  it('is a modal dialog named by its title, on the right edge, closed by ✕ and Escape', async () => {
    const onClose = vi.fn();
    render(
      <>
        <button type="button">Opener</button>
        <Drawer title="New export" onClose={onClose} footer={<button type="submit">Save</button>}>
          <label>
            Format
            <select>
              <option>CSV</option>
            </select>
          </label>
        </Drawer>
      </>,
    );
    const dialog = screen.getByRole('dialog', { name: 'New export' });
    expect(dialog.tagName).toBe('DIALOG');
    expect(dialog.dataset.side).toBe('true');
    // Against the right edge, full height; the whole screen on a phone.
    expect(dialog.className).toContain('right-0');
    expect(dialog.className).toContain('h-dvh');
    expect(dialog.className).toContain('w-full');
    expect(dialog.className).toContain('sm:max-w-md');
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeTruthy();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    // Escape: the native dialog's cancel event.
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('gives the focus back to what had it when it closes', () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Add
          </button>
          {open ? (
            <Drawer title="Add" onClose={() => setOpen(false)}>
              <input aria-label="Name" />
            </Drawer>
          ) : null}
        </>
      );
    }
    render(<Host />);
    const add = screen.getByRole('button', { name: 'Add' });
    add.focus();
    fireEvent.click(add);
    const dialog = screen.getByRole('dialog', { name: 'Add' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(add);
  });
});

describe('MoreMenu', () => {
  it('is a menu button: arrows move, a pick runs and returns the focus', async () => {
    const user = userEvent.setup();
    const rename = vi.fn();
    const remove = vi.fn();
    render(
      <MoreMenu
        label="Actions for Household"
        entries={[
          { type: 'item', id: 'rename', label: 'Rename', onSelect: rename },
          { type: 'item', id: 'remove', label: 'Delete', onSelect: remove },
        ]}
      />,
    );
    const button = screen.getByRole('button', { name: 'Actions for Household' });
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    await user.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const menu = screen.getByRole('menu', { name: 'Actions for Household' });
    expect(document.activeElement?.textContent).toContain('Rename');
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement?.textContent).toContain('Delete');
    await user.keyboard('{Enter}');
    expect(remove).toHaveBeenCalledOnce();
    expect(menu.isConnected).toBe(false);
    expect(document.activeElement).toBe(button);

    await user.click(button);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(rename).not.toHaveBeenCalled();
  });
});

describe('OverflowTabList', () => {
  function ProjectTabs({ start = 'overview' }: { start?: string }) {
    const [tab, setTab] = useState(start);
    const items = [
      { value: 'overview', label: 'Overview' },
      { value: 'cases', label: 'Cases' },
      { value: 'people', label: 'People', rarely: true },
      { value: 'settings', label: 'Project settings', rarely: true },
    ];
    return (
      <Tabs.Root value={tab} onValueChange={setTab}>
        <OverflowTabList label="Project sections" value={tab} onSelect={setTab} items={items} />
        {items.map((x) => (
          <Tabs.Content key={x.value} value={x.value}>
            {x.label} panel
          </Tabs.Content>
        ))}
      </Tabs.Root>
    );
  }

  it('keeps the seldom used tabs under "More", and shows the open one in the row', async () => {
    const user = userEvent.setup();
    render(<ProjectTabs />);
    const list = screen.getByRole('tablist', { name: 'Project sections' });
    expect(
      within(list)
        .getAllByRole('tab')
        .map((x) => x.textContent),
    ).toEqual(['Overview', 'Cases']);
    await user.click(screen.getByRole('button', { name: 'More sections' }));
    await user.click(screen.getByRole('menuitem', { name: 'Project settings' }));
    expect(
      within(list).getByRole('tab', { name: 'Project settings' }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(screen.getByText('Project settings panel')).toBeTruthy();
    // People is still under "More".
    expect(within(list).queryByRole('tab', { name: 'People' })).toBeNull();
  });
});

describe('PageHeader', () => {
  it('puts the h1 and the breadcrumb in the top row when the layout offers it', () => {
    function Layout() {
      const [slot, setSlot] = useState<HTMLElement | null>(null);
      return (
        <main>
          <div data-testid="row">
            <div ref={setSlot} />
            <button type="button">Account</button>
          </div>
          <HeaderSlotContext.Provider value={slot}>
            <div data-testid="page">
              <PageHeader
                parents={[<a href="/projects">Projects</a>]}
                title="Household Survey 2026"
                current="Cases"
              />
            </div>
          </HeaderSlotContext.Provider>
        </main>
      );
    }
    render(<Layout />);
    const h1 = screen.getByRole('heading', { level: 1, name: 'Household Survey 2026' });
    expect(screen.getByTestId('row').contains(h1)).toBe(true);
    expect(screen.getByTestId('page').contains(h1)).toBe(false);
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(crumbs.contains(h1)).toBe(true);
    expect(within(crumbs).getByText('Cases').getAttribute('aria-current')).toBe('page');
  });

  it('renders in place outside the layout', () => {
    render(<PageHeader title="Users" actions={<button type="button">Invite</button>} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Users' })).toBeTruthy();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.getByRole('button', { name: 'Invite' })).toBeTruthy();
  });
});

import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Badge, Button, Notice } from '../src/routes/ui.js';
import { SideDrawer, type DrawerState } from '../src/routes/SideDrawer.js';

describe('Notice', () => {
  it('is announced politely, and its close button calls back', async () => {
    const onClose = vi.fn();
    render(<Notice onClose={onClose}>Style saved.</Notice>);
    const box = screen.getByRole('status');
    expect(box.textContent).toContain('Style saved.');
    expect(box.dataset.tone).toBe('success');
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('is an alert for an error, has no close button unless asked, and nothing without text', () => {
    const { container, rerender } = render(<Notice tone="error">Could not save.</Notice>);
    expect(screen.getByRole('alert').textContent).toContain('Could not save.');
    expect(screen.queryByRole('button')).toBeNull();
    // Empty, the live region stays (so the next message is announced) but shows nothing.
    rerender(<Notice>{null}</Notice>);
    expect(screen.getByRole('status').textContent).toBe('');
    expect(container.querySelectorAll('[role="status"] *')).toHaveLength(0);
  });
});

describe('Badge', () => {
  it('is one pill shape whatever the tone', () => {
    render(
      <>
        <Badge tone="success">Active</Badge>
        <Badge tone="warning">Waiting</Badge>
      </>,
    );
    for (const text of ['Active', 'Waiting'])
      expect(screen.getByText(text).className).toContain('rounded-full');
    expect(screen.getByText('Active').className).toContain('bg-emerald-100');
  });
});

describe('Button', () => {
  it('disabled, the primary button turns grey instead of a faded blue', () => {
    render(<Button disabled>Save</Button>);
    const b = screen.getByRole('button', { name: 'Save' });
    expect((b as HTMLButtonElement).disabled).toBe(true);
    expect(b.className).toContain('disabled:bg-slate-200');
    expect(b.className).not.toContain('disabled:opacity-50');
  });

  it('busy, it ignores clicks and says so, but keeps the focus', async () => {
    const onClick = vi.fn();
    render(
      <Button busy onClick={onClick}>
        Exporting…
      </Button>,
    );
    const b = screen.getByRole('button', { name: 'Exporting…' });
    b.focus();
    await userEvent.click(b);
    expect(onClick).not.toHaveBeenCalled();
    expect(b.getAttribute('aria-disabled')).toBe('true');
    expect(b.getAttribute('aria-busy')).toBe('true');
    expect(document.activeElement).toBe(b);
  });
});

describe('SideDrawer', () => {
  const drawer: DrawerState = {
    inline: false,
    pinned: false,
    setPinned: () => {},
    open: false,
    held: false,
    setOpen: () => {},
    peek: () => {},
  };

  it('reads the count with the rail button', () => {
    render(
      <SideDrawer
        id="d"
        drawer={drawer}
        side="right"
        label="My callbacks"
        icon={null}
        badge={1}
        badgeLabel="Due now: 1"
      >
        <p>Inside</p>
      </SideDrawer>,
    );
    const button = screen.getByRole('button', { name: 'My callbacks' });
    const described = document.getElementById(button.getAttribute('aria-describedby')!);
    expect(described?.querySelector('.sr-only')?.textContent).toBe('Due now: 1');
    expect(described?.querySelector('[aria-hidden="true"]')?.textContent).toBe('1');
  });
});

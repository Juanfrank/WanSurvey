import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../api.js';
import { InfoTip } from '../cases/samplingControls.js';
import { inputCls } from '../designer/fields.js';
import { useMe } from '../routes/AppLayout.js';
import {
  Button,
  Card,
  Drawer,
  ErrorText,
  Field,
  MoreMenu,
  QueryState,
  PageHeader,
  TableScroll,
} from '../routes/ui.js';

interface Team {
  id: string;
  name: string;
  leaderId: string | null;
  leaderName: string | null;
  members: { userId: string; name: string; email: string }[];
}

interface Person {
  id: string;
  name: string;
  email: string;
  status: 'active' | 'invited' | 'deactivated';
}

/** Teams of the organisation: a name, a leader and members. */
export function TeamsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const me = useMe();
  const canManage = !!me.data?.permissions.includes('users.manage');
  const teams = useQuery({
    queryKey: ['teams', me.data?.tenantId],
    queryFn: () => api<Team[]>('/teams'),
    enabled: !!me.data,
  });
  const people = useQuery({
    queryKey: ['team', me.data?.tenantId],
    queryFn: () => api<Person[]>('/users'),
    enabled: !!me.data,
  });
  const [editing, setEditing] = useState<Team | 'new' | null>(null);
  // Kept as a key, so the message follows a change of language.
  const [notice, setNotice] = useState<{ key: string; name: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['teams'] });
  const remove = useMutation({
    mutationFn: (team: Team) => api(`/teams/${team.id}`, { method: 'DELETE' }),
    onSuccess: async (_r, team) => {
      setNotice({ key: 'admin.teamsPage.removed', name: team.name });
      await refresh();
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('admin.teams')}
        aside={
          <InfoTip
            id="teams-intro"
            term={t('admin.teams')}
            text={t('admin.teamsPage.intro')}
            align="start"
          />
        }
        actions={
          canManage ? (
            <Button onClick={() => setEditing('new')}>{t('admin.teamsPage.add')}</Button>
          ) : null
        }
      />
      {canManage ? null : <p className="text-sm text-slate-600">{t('admin.teamsPage.readOnly')}</p>}
      <p
        role="status"
        className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-ink-800 empty:hidden"
      >
        {notice ? t(notice.key, { name: notice.name }) : null}
      </p>
      {remove.isError ? <ErrorText>{t('admin.teamsPage.errors.generic')}</ErrorText> : null}
      <QueryState query={teams}>{null}</QueryState>
      {teams.data && teams.data.length === 0 ? (
        <Card>
          <p className="text-slate-600">{t('admin.teamsPage.none')}</p>
        </Card>
      ) : null}
      {teams.data?.length ? (
        <Card className="p-4!">
          <TableScroll label={t('admin.teams')}>
            <table
              className="w-full text-left text-sm [&_td]:whitespace-nowrap"
              aria-busy={teams.isFetching}
            >
              <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-2 pr-4 font-semibold">{t('admin.teamsPage.name')}</th>
                  <th className="py-2 pr-4 font-semibold">{t('admin.teamsPage.leader')}</th>
                  <th className="py-2 pr-4 text-right font-semibold">
                    {t('admin.teamsPage.size')}
                  </th>
                  <th className="py-2 pr-4 font-semibold">{t('admin.teamsPage.members')}</th>
                  {canManage ? (
                    <th className="py-2">
                      <span className="sr-only">{t('admin.teamsPage.actionsHead')}</span>
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {teams.data.map((team) => {
                  const names = team.members.map((m) => m.name).join(', ');
                  return (
                    <tr key={team.id} data-team={team.name} className="border-b border-slate-100">
                      <td className="py-1.5 pr-4 font-medium" title={team.name}>
                        <span className="block max-w-[16rem] truncate">{team.name}</span>
                      </td>
                      <td className="py-1.5 pr-4">
                        {team.leaderName ?? (
                          <span className="text-slate-500">{t('admin.teamsPage.noLeader')}</span>
                        )}
                      </td>
                      <td className="py-1.5 pr-4 text-right tabular-nums">
                        {t('admin.teamsPage.count', { count: team.members.length })}
                      </td>
                      <td className="py-1.5 pr-4 text-slate-600" title={names}>
                        <span className="block max-w-[28rem] truncate">{names || '—'}</span>
                      </td>
                      {canManage ? (
                        <td className="py-1 text-right">
                          <MoreMenu
                            label={t('admin.teamsPage.actionsFor', { name: team.name })}
                            entries={[
                              {
                                type: 'item',
                                id: 'edit',
                                label: t('admin.teamsPage.editMenu'),
                                onSelect: () => setEditing(team),
                              },
                              {
                                type: 'item',
                                id: 'remove',
                                label: t('admin.teamsPage.removeMenu'),
                                onSelect: () => {
                                  if (
                                    window.confirm(
                                      t('admin.teamsPage.confirmRemove', { name: team.name }),
                                    )
                                  )
                                    remove.mutate(team);
                                },
                              },
                            ]}
                          />
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableScroll>
        </Card>
      ) : null}
      {editing ? (
        <TeamDialog
          team={editing === 'new' ? null : editing}
          people={(people.data ?? []).filter((p) => p.status !== 'deactivated')}
          onClose={() => setEditing(null)}
          onSaved={async (name, created) => {
            setEditing(null);
            setNotice({ key: created ? 'admin.teamsPage.created' : 'admin.teamsPage.saved', name });
            await refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function TeamDialog({
  team,
  people,
  onClose,
  onSaved,
}: {
  team: Team | null;
  people: Person[];
  onClose(): void;
  onSaved(name: string, created: boolean): Promise<void>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(team?.name ?? '');
  const [leaderId, setLeaderId] = useState(team?.leaderId ?? '');
  const [members, setMembers] = useState(() => new Set(team?.members.map((m) => m.userId) ?? []));
  const [filter, setFilter] = useState('');
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? people.filter((p) => `${p.name} ${p.email}`.toLowerCase().includes(q)) : people;
  }, [people, filter]);
  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), leaderId: leaderId || null, memberIds: [...members] };
      return team
        ? api(`/teams/${team.id}`, { method: 'PATCH', body })
        : api('/teams', { method: 'POST', body });
    },
    onSuccess: () => onSaved(name.trim(), !team),
  });
  const error = save.error;
  const code = error instanceof ApiError ? error.code : undefined;
  const formId = useId();
  return (
    <Drawer
      title={team ? t('admin.teamsPage.edit', { name: team.name }) : t('admin.teamsPage.add')}
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('admin.teamsPage.cancel')}
          </Button>
          <Button type="submit" form={formId} disabled={!name.trim() || save.isPending}>
            {team ? t('admin.teamsPage.save') : t('admin.teamsPage.create')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) save.mutate();
        }}
      >
        <div className="grid gap-3">
          <Field
            id="team-name"
            label={t('admin.teamsPage.name')}
            required
            autoFocus
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="flex flex-col gap-1">
            <label htmlFor="team-leader" className="text-sm font-medium text-slate-700">
              {t('admin.teamsPage.leader')}
            </label>
            <select
              id="team-leader"
              className={`${inputCls} py-2`}
              value={leaderId}
              onChange={(e) => setLeaderId(e.target.value)}
            >
              <option value="">{t('admin.teamsPage.noLeader')}</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium text-slate-700">
            {t('admin.teamsPage.members')}{' '}
            <span className="font-normal text-slate-500">
              ({t('admin.teamsPage.count', { count: members.size })})
            </span>
          </legend>
          <p className="text-xs text-slate-600">{t('admin.teamsPage.membersHint')}</p>
          <input
            type="search"
            aria-label={t('admin.teamsPage.filter')}
            placeholder={t('admin.teamsPage.filter')}
            className={inputCls}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <ul className="grid max-h-[50vh] gap-1 overflow-auto rounded-md border border-slate-200 p-2">
            {shown.map((p) => (
              <li key={p.id}>
                <label className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-slate-50">
                  <input
                    type="checkbox"
                    checked={members.has(p.id) || p.id === leaderId}
                    disabled={p.id === leaderId}
                    onChange={(e) => {
                      const next = new Set(members);
                      if (e.target.checked) next.add(p.id);
                      else next.delete(p.id);
                      setMembers(next);
                    }}
                  />
                  <span className="truncate">{p.name}</span>
                  <span className="truncate text-xs text-slate-500">{p.email}</span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
        {error ? (
          <ErrorText>
            {code === 'CONFLICT' || code === 'NOT_A_MEMBER'
              ? t(`admin.teamsPage.errors.${code}`)
              : error instanceof ApiError && error.status === 409
                ? t('admin.teamsPage.errors.CONFLICT')
                : t('admin.teamsPage.errors.generic')}
          </ErrorText>
        ) : null}
      </form>
    </Drawer>
  );
}

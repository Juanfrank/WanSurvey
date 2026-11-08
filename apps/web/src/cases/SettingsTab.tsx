import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  FUNCTION_KEYS,
  LAWFUL_BASES,
  type AssignmentMode,
  type LawfulBasis,
  type ProjectSettings,
} from '@wansurvey/schema';
import * as Tabs from '@radix-ui/react-tabs';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.js';
import type { Project } from '../designer/ProjectPages.js';
import { controlCls } from '../designer/fields.js';
import { localiseError } from '../i18n-messages.js';
import { Button } from '../routes/ui.js';
import { SubTabBar } from '../routes/tabs.js';
import { CleaningEditor } from './CleaningEditor.js';
import { ContactRulesEditor } from './ContactRulesEditor.js';
import { useSampleFields } from './hooks.js';
import { ExitReasonsEditor } from './ExitReasonsEditor.js';
import { CawiProjectSettings } from '../cawi/CawiTab.js';
import { BrandingSettings } from './BrandingSettings.js';
import { useCan } from '../designer/hooks.js';
import { GoalsSection } from '../analysis/GoalsSection.js';

/** Per-project switches: automatic personal data for interviewers, and the assignment mode. */
export function SettingsTab({ project }: { project: Project }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [form, setForm] = useState<ProjectSettings>(project.settings);
  const [message, setMessage] = useState('');
  const sampleFields = useSampleFields(project.id);
  useEffect(() => setForm(project.settings), [project.settings]);
  const save = useMutation({
    mutationFn: () =>
      api<Project>(`/projects/${project.id}`, { method: 'PATCH', body: { settings: form } }),
    onSuccess: async (p) => {
      qc.setQueryData(['project', project.id], p);
      await qc.invalidateQueries({ queryKey: ['cases', project.id] });
      setMessage(t('cases.settings.saved'));
    },
    onError: (e) => setMessage(localiseError(t, e)),
  });
  const modes: AssignmentMode[] = ['assigned', 'pool'];
  const canWeb =
    useCan('cawi.waves', project.id) &&
    (!project.modesEnabled.length || project.modesEnabled.includes('CAWI'));
  // Supervisors who set goals but do not configure the project see only the goals.
  const canUpdate = useCan('projects.update', project.id);
  const subs = canUpdate
    ? [
        'assignment',
        'phone',
        'field',
        ...(canWeb ? ['web'] : []),
        'paper',
        'review',
        'cleaning',
        'fieldwork',
        'shortcuts',
        'privacy',
        'look',
      ]
    : ['fieldwork'];
  // No choice yet: the first topic (permissions may still be loading).
  const [sub, setSub] = useState<string | null>(null);
  const current = sub && subs.includes(sub) ? sub : subs[0]!;
  // Each topic saves the whole settings with the same request.
  const section = (children: ReactNode) => (
    <form
      // Two columns on wide screens; the save row runs across.
      className="grid items-start gap-x-10 gap-y-5 xl:grid-cols-2"
      aria-labelledby="settings-title"
      onSubmit={(e) => {
        e.preventDefault();
        setMessage('');
        save.mutate();
      }}
    >
      {children}
      <div className="flex items-center gap-3 xl:col-span-2">
        <Button type="submit" disabled={save.isPending}>
          {t('cases.settings.save')}
        </Button>
        <p role="status" aria-live="polite">
          {message}
        </p>
      </div>
    </form>
  );

  return (
    <div className="flex flex-col gap-4 text-sm">
      {/* The tab already says where we are; the heading stays for screen readers. */}
      <h2 id="settings-title" className="sr-only">
        {t('cases.settings.title')}
      </h2>
      <Tabs.Root value={current} onValueChange={setSub} className="flex flex-col gap-4">
        <SubTabBar
          label={t('cases.settings.sections')}
          items={subs.map((x) => ({ value: x, label: t(`cases.settings.tabs.${x}`) }))}
        />
        <Tabs.Content value="assignment">
          {section(
            <>
              <div className="flex flex-col gap-1">
                <label className="flex items-start gap-2 font-medium">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    aria-describedby="settings-reveal-help"
                    checked={form.revealToInterviewers}
                    onChange={(e) => setForm({ ...form, revealToInterviewers: e.target.checked })}
                  />
                  {t('cases.settings.reveal')}
                </label>
                <p id="settings-reveal-help" className="ml-6 max-w-prose text-slate-600">
                  {t('cases.settings.revealHelp')}
                </p>
              </div>
              <fieldset className="flex flex-col gap-1.5" aria-describedby="settings-mode-help">
                <legend className="mb-1 font-medium">{t('cases.settings.mode')}</legend>
                {modes.map((m) => (
                  <label key={m} className="flex items-start gap-2">
                    <input
                      type="radio"
                      name="assignment-mode"
                      className="mt-0.5"
                      value={m}
                      checked={form.assignmentMode === m}
                      onChange={() => setForm({ ...form, assignmentMode: m })}
                    />
                    {t(`cases.settings.${m}`)}
                  </label>
                ))}
                <p id="settings-mode-help" className="ml-6 max-w-prose text-slate-600">
                  {t('cases.settings.poolHelp')}
                </p>
              </fieldset>
              <div className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2 font-medium">
                  <label htmlFor="settings-expiry">{t('cases.settings.expiry')}</label>
                  <input
                    id="settings-expiry"
                    type="number"
                    min={1}
                    max={form.fieldwork.caseExpiryHours ? 87600 : 3650}
                    className={`${controlCls} w-24`}
                    aria-describedby="settings-expiry-help"
                    value={form.fieldwork.caseExpiryHours ?? form.fieldwork.caseExpiryDays ?? ''}
                    onChange={(e) => {
                      const v = e.target.value === '' ? null : Math.max(1, Number(e.target.value));
                      // The unit stays as it was: hours when the project counts hours, else days.
                      setForm({
                        ...form,
                        fieldwork: form.fieldwork.caseExpiryHours
                          ? { ...form.fieldwork, caseExpiryHours: v }
                          : { ...form.fieldwork, caseExpiryDays: v },
                      });
                    }}
                  />
                  <select
                    className={controlCls}
                    aria-label={t('cases.settings.expiryUnit')}
                    value={form.fieldwork.caseExpiryHours ? 'hours' : 'days'}
                    onChange={(e) => {
                      const v = form.fieldwork.caseExpiryHours ?? form.fieldwork.caseExpiryDays;
                      setForm({
                        ...form,
                        fieldwork:
                          e.target.value === 'hours'
                            ? { ...form.fieldwork, caseExpiryHours: v ?? 48, caseExpiryDays: null }
                            : {
                                ...form.fieldwork,
                                caseExpiryDays: v ? Math.max(1, Math.ceil(v / 24)) : null,
                                caseExpiryHours: null,
                              },
                      });
                    }}
                  >
                    <option value="hours">{t('cases.settings.hours')}</option>
                    <option value="days">{t('cases.settings.days')}</option>
                  </select>
                </div>
                <p id="settings-expiry-help" className="max-w-prose text-slate-600">
                  {t('cases.settings.expiryHelp')}
                </p>
              </div>
            </>,
          )}
        </Tabs.Content>
        <Tabs.Content value="phone">
          {section(
            <>
              <fieldset className="flex flex-col gap-3" data-testid="cati-settings">
                <legend className="mb-1 font-medium">{t('cati.settings.title')}</legend>
                <div className="flex flex-wrap gap-4">
                  {(['from', 'to'] as const).map((k) => (
                    <label key={k} className="flex flex-col gap-1">
                      <span>
                        {k === 'from' ? t('cati.settings.hoursFrom') : t('cati.settings.hoursTo')}
                      </span>
                      <input
                        type="time"
                        className={`${controlCls} w-auto`}
                        aria-describedby="settings-hours-help"
                        value={form.cati.callingHours[k]}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            cati: {
                              ...form.cati,
                              callingHours: { ...form.cati.callingHours, [k]: e.target.value },
                            },
                          })
                        }
                      />
                    </label>
                  ))}
                  <label className="flex flex-col gap-1">
                    <span>{t('cati.settings.maxAttempts')}</span>
                    <input
                      type="number"
                      min={1}
                      max={50}
                      className={`${controlCls} w-24`}
                      value={form.cati.maxAttempts}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          cati: { ...form.cati, maxAttempts: Number(e.target.value) },
                        })
                      }
                    />
                  </label>
                </div>
                <p id="settings-hours-help" className="max-w-prose text-slate-600">
                  {t('cati.settings.hoursHelp')}
                </p>
                <fieldset className="flex flex-wrap gap-4">
                  <legend className="mb-1">{t('cati.settings.retry')}</legend>
                  {(['no_answer', 'busy', 'voicemail'] as const).map((k) => (
                    <label key={k} className="flex flex-col gap-1">
                      <span>{t(`cati.settings.${k}`)}</span>
                      <input
                        type="number"
                        min={1}
                        max={10080}
                        className={`${controlCls} w-24`}
                        value={form.cati.retryMinutes[k]}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            cati: {
                              ...form.cati,
                              retryMinutes: {
                                ...form.cati.retryMinutes,
                                [k]: Number(e.target.value),
                              },
                            },
                          })
                        }
                      />
                    </label>
                  ))}
                </fieldset>
              </fieldset>
              <ExitReasonsEditor
                value={form.earlyExit}
                onChange={(earlyExit) => setForm({ ...form, earlyExit })}
              />
            </>,
          )}
        </Tabs.Content>
        <Tabs.Content value="field">
          {section(
            <>
              <fieldset className="flex flex-col gap-2" data-testid="capi-settings">
                <legend className="mb-1 font-medium">{t('cases.settings.capiTitle')}</legend>
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={form.capi.gps === 'start_end'}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        capi: { ...form.capi, gps: e.target.checked ? 'start_end' : 'off' },
                      })
                    }
                  />
                  {t('cases.settings.gps')}
                </label>
                <label className="flex flex-col gap-1">
                  <span>{t('cases.settings.gpsNotice')}</span>
                  <textarea
                    className={`${controlCls} min-h-[3rem]`}
                    value={form.capi.gpsNotice}
                    maxLength={1000}
                    onChange={(e) =>
                      setForm({ ...form, capi: { ...form.capi, gpsNotice: e.target.value } })
                    }
                  />
                </label>
              </fieldset>
              <fieldset className="flex flex-col gap-2" data-testid="audio-settings">
                <legend className="mb-1 font-medium">{t('cases.settings.audioTitle')}</legend>
                <p className="max-w-3xl text-sm text-slate-600">{t('cases.settings.audioHelp')}</p>
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={form.audio.enabled}
                    onChange={(e) =>
                      setForm({ ...form, audio: { ...form.audio, enabled: e.target.checked } })
                    }
                  />
                  {t('cases.settings.audioEnabled')}
                </label>
                {form.audio.enabled ? (
                  <>
                    <label className="flex items-center gap-2">
                      <input
                        type="number"
                        min={1}
                        max={100}
                        className={`${controlCls} w-24`}
                        value={form.audio.samplePercent}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            audio: { ...form.audio, samplePercent: Number(e.target.value) },
                          })
                        }
                      />
                      {t('cases.settings.audioPercent')}
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="number"
                        min={1}
                        max={3650}
                        className={`${controlCls} w-24`}
                        value={form.audio.retentionDays}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            audio: { ...form.audio, retentionDays: Number(e.target.value) },
                          })
                        }
                      />
                      {t('cases.settings.audioRetention')}
                    </label>
                    <label className="flex flex-col gap-1">
                      <span>
                        {t('cases.settings.audioConsent', { version: form.audio.consentVersion })}
                      </span>
                      <textarea
                        className={`${controlCls} min-h-[6rem]`}
                        value={form.audio.consentText}
                        maxLength={2000}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            audio: { ...form.audio, consentText: e.target.value },
                          })
                        }
                      />
                    </label>
                  </>
                ) : null}
              </fieldset>
            </>,
          )}
        </Tabs.Content>
        <Tabs.Content value="paper">
          {section(
            <>
              <fieldset className="flex flex-col gap-2" data-testid="papi-settings">
                <legend className="mb-1 font-medium">{t('papi.settings.title')}</legend>
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={form.papi.doubleEntry}
                    onChange={(e) =>
                      setForm({ ...form, papi: { ...form.papi, doubleEntry: e.target.checked } })
                    }
                  />
                  {t('papi.settings.doubleEntry')}
                </label>
              </fieldset>
            </>,
          )}
        </Tabs.Content>
        <Tabs.Content value="review">
          {section(
            <>
              <fieldset className="flex flex-col gap-2" data-testid="review-settings">
                <legend className="mb-1 font-medium">{t('review.settings.title')}</legend>
                {(
                  [
                    ['sample', 'samplePercent', 1, 0, 100],
                    ['speeding', 'speedingMsPerQuestion', 1000, 0, 600],
                    ['straight', 'straightlineMinItems', 1, 2, 100],
                  ] as const
                ).map(([label, key, scale, min, max]) => (
                  <label key={key} className="flex items-center gap-2">
                    <input
                      type="number"
                      min={min}
                      max={max}
                      step={scale === 1000 ? 0.1 : 1}
                      className={`${controlCls} w-24`}
                      value={form.review[key] / scale}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          review: {
                            ...form.review,
                            [key]: Math.round(Number(e.target.value) * scale),
                          },
                        })
                      }
                    />
                    {t(`review.settings.${label}`)}
                  </label>
                ))}
                {(
                  [
                    ['shortPageShare', 'shortPageShare', 100, 5, 100],
                    ['clusterMetres', 'clusterMetres', 1, 5, 5000],
                    ['clusterMin', 'clusterMinInterviews', 1, 2, 100],
                  ] as const
                ).map(([label, key, scale, min, max]) => (
                  <label key={key} className="flex items-center gap-2">
                    <input
                      type="number"
                      min={min}
                      max={max}
                      className={`${controlCls} w-24`}
                      value={Math.round(form.review.risk[key] * scale)}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          review: {
                            ...form.review,
                            risk: { ...form.review.risk, [key]: Number(e.target.value) / scale },
                          },
                        })
                      }
                    />
                    {t(`review.settings.${label}`)}
                  </label>
                ))}
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={form.review.rejectReopensCase}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        review: { ...form.review, rejectReopensCase: e.target.checked },
                      })
                    }
                  />
                  {t('review.settings.rejectReopens')}
                </label>
              </fieldset>
              <fieldset className="flex flex-col gap-2" data-testid="approval-settings">
                <legend className="mb-1 font-medium">{t('cases.settings.approvalTitle')}</legend>
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={form.publishApproval.required}
                    onChange={(e) =>
                      setForm({ ...form, publishApproval: { required: e.target.checked } })
                    }
                  />
                  {t('cases.settings.approvalRequired')}
                </label>
                <p className="max-w-prose text-slate-600">{t('cases.settings.approvalHelp')}</p>
              </fieldset>
            </>,
          )}
        </Tabs.Content>
        <Tabs.Content value="fieldwork" className="flex flex-col gap-8">
          {canUpdate &&
            section(
              <>
                <fieldset className="flex flex-col gap-2" data-testid="fieldwork-settings">
                  <legend className="mb-1 font-medium">{t('analysis.settings.title')}</legend>
                  <label className="flex items-center gap-2">
                    <input
                      type="number"
                      min={0}
                      className={`${controlCls} w-28`}
                      value={form.fieldwork.targetCompletes ?? ''}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          fieldwork: {
                            ...form.fieldwork,
                            targetCompletes:
                              e.target.value === '' ? null : Math.max(0, Number(e.target.value)),
                          },
                        })
                      }
                    />
                    {t('analysis.settings.target')}
                  </label>
                </fieldset>
              </>,
            )}
          <GoalsSection projectId={project.id} manage />
        </Tabs.Content>
        <Tabs.Content value="shortcuts">
          {section(
            <>
              <fieldset className="flex flex-col gap-2" data-testid="shortcut-settings">
                <legend className="mb-1 font-medium">
                  {t('interview.shortcutSettings.title')}
                </legend>
                <div className="flex flex-wrap gap-4">
                  {(['dontKnow', 'refused'] as const).map((k) => (
                    <label key={k} className="flex flex-col gap-1">
                      {t(`interview.shortcutSettings.${k}`)}
                      <select
                        className={controlCls}
                        value={form.shortcuts[k]}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            shortcuts: {
                              ...form.shortcuts,
                              [k]: e.target.value as typeof form.shortcuts.dontKnow,
                            },
                          })
                        }
                      >
                        {FUNCTION_KEYS.map((f) => (
                          <option key={f} value={f}>
                            {f}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                  {(['note', 'navigator', 'pause'] as const).map((k) => (
                    <label key={k} className="flex flex-col gap-1">
                      {t(`interview.shortcutSettings.${k}`)}
                      <span className="flex items-center gap-1">
                        Ctrl +
                        <input
                          className={`${controlCls} w-14 uppercase`}
                          maxLength={1}
                          pattern="[A-Za-z]"
                          required
                          value={form.shortcuts[k]}
                          onChange={(e) =>
                            setForm({
                              ...form,
                              shortcuts: { ...form.shortcuts, [k]: e.target.value.toLowerCase() },
                            })
                          }
                        />
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            </>,
          )}
        </Tabs.Content>
        <Tabs.Content value="cleaning">
          {section(
            <>
              <CleaningEditor
                value={form.cleaning}
                fields={
                  Array.isArray(sampleFields.data) ? sampleFields.data.map((f) => f.name) : []
                }
                onChange={(cleaning) => setForm({ ...form, cleaning })}
              />
              <ContactRulesEditor
                value={form.contactRules}
                onChange={(contactRules) => setForm({ ...form, contactRules })}
              />
            </>,
          )}
        </Tabs.Content>
        <Tabs.Content value="privacy">
          {section(
            <>
              <fieldset className="flex flex-col gap-2" data-testid="basis-settings">
                <legend className="mb-1 font-medium">{t('cases.privacy.basisTitle')}</legend>
                <p className="max-w-prose text-slate-600">{t('cases.privacy.basisHelp')}</p>
                {(['phone', 'visit'] as const).map((ch) => (
                  <label key={ch} className="flex flex-wrap items-center gap-2">
                    <span className="w-48">
                      {t(`cases.privacy.basis${ch === 'phone' ? 'Phone' : 'Visit'}`)}
                    </span>
                    <select
                      className={`${controlCls} w-auto`}
                      value={form.contactBasis[ch] ?? ''}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          contactBasis: {
                            ...form.contactBasis,
                            [ch]: (e.target.value || null) as LawfulBasis | null,
                          },
                        })
                      }
                    >
                      <option value="">
                        {t(
                          ch === 'phone'
                            ? 'cases.privacy.basisNone'
                            : 'cases.privacy.basisNoneVisit',
                        )}
                      </option>
                      {LAWFUL_BASES.map((b) => (
                        <option key={b} value={b}>
                          {t(`cawi.settings.bases.${b}`)}
                        </option>
                      ))}
                    </select>
                    {form.contactBasis[ch] === null ? (
                      <span role="alert" className="text-sm font-medium text-amber-ink-900">
                        {t('cases.privacy.basisMissing')}
                      </span>
                    ) : null}
                  </label>
                ))}
              </fieldset>
              <fieldset className="flex flex-col gap-2" data-testid="retention-settings">
                <legend className="mb-1 font-medium">{t('cases.privacy.retentionTitle')}</legend>
                <label className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    max={3650}
                    className={`${controlCls} w-28`}
                    value={form.retention.anonymiseAfterDays ?? ''}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        retention: {
                          anonymiseAfterDays:
                            e.target.value === '' ? null : Math.max(1, Number(e.target.value)),
                        },
                      })
                    }
                  />
                  {t('cases.privacy.retentionDays')}
                </label>
                <p className="max-w-prose text-slate-600">{t('cases.privacy.retentionHelp')}</p>
                {form.retention.anonymiseAfterDays === null ? (
                  <p role="alert" className="max-w-prose font-medium text-amber-ink-900">
                    {t('cases.privacy.retentionNone')}
                  </p>
                ) : null}
              </fieldset>
              <fieldset className="flex flex-col gap-2" data-testid="notice-settings">
                <legend className="mb-1 font-medium">{t('cases.privacy.noticeTitle')}</legend>
                <p className="max-w-prose text-slate-600">{t('cases.privacy.noticeHelp')}</p>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={form.notice.required}
                    onChange={(e) =>
                      setForm({ ...form, notice: { ...form.notice, required: e.target.checked } })
                    }
                  />
                  {t('cases.privacy.noticeRequired')}
                </label>
                <label className="flex flex-wrap items-center gap-2">
                  <input
                    type="checkbox"
                    checked={form.notice.minAge !== null}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        notice: { ...form.notice, minAge: e.target.checked ? 18 : null },
                      })
                    }
                  />
                  {t('cases.privacy.minAge')}
                  {form.notice.minAge !== null ? (
                    <input
                      type="number"
                      min={5}
                      max={30}
                      aria-label={t('cases.privacy.minAgeValue')}
                      className={`${controlCls} w-20`}
                      value={form.notice.minAge}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          notice: {
                            ...form.notice,
                            minAge: Math.min(30, Math.max(5, Number(e.target.value) || 18)),
                          },
                        })
                      }
                    />
                  ) : null}
                </label>
                <p className="max-w-prose text-sm text-slate-600">
                  {t('cases.privacy.minAgeHelp')}
                </p>
              </fieldset>
            </>,
          )}
        </Tabs.Content>
        <Tabs.Content value="look">
          <BrandingSettings project={project} />
        </Tabs.Content>
        <Tabs.Content value="web">
          <CawiProjectSettings project={project} />
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}

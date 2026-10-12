import { AnswerValueSchema, MODES, PARADATA_TYPES } from '@wansurvey/schema';
import { z } from 'zod';

export const MAX_OPS = 2000;

export const DeviceId = z.string().min(8).max(100);

export const StartBody = z.object({
  id: z.uuid(),
  caseId: z.uuid(),
  questionnaireId: z.uuid(),
  mode: z.enum(MODES),
  language: z.string().min(2).max(16).optional(),
  deviceId: DeviceId,
});
export type StartBody = z.infer<typeof StartBody>;

const AnswerOp = z.object({
  seq: z.number().int().positive(),
  kind: z.literal('answer'),
  variable: z.string().min(1).max(200),
  oldValue: AnswerValueSchema.nullable().optional(),
  newValue: AnswerValueSchema.nullable().optional(),
  at: z.iso.datetime(),
  source: z.enum(['interviewer', 'respondent', 'reviewer', 'system']),
  reason: z.string().max(40).nullable().optional(),
});
const ParadataOp = z.object({
  seq: z.number().int().positive(),
  kind: z.literal('paradata'),
  type: z.enum(PARADATA_TYPES),
  at: z.iso.datetime(),
  monotonicMs: z.number().nonnegative().optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
});
export const Op = z.discriminatedUnion('kind', [AnswerOp, ParadataOp]);

/** Starts an interview the server has not seen (an offline device, slice 8). */
export const OfflineStart = z.object({
  caseId: z.uuid(),
  questionnaireVersionId: z.uuid(),
  mode: z.enum(MODES),
  language: z.string().min(2).max(16),
  startedAt: z.iso.datetime(),
});

export const SyncItem = z.object({
  id: z.uuid(),
  start: OfflineStart.optional(),
  ops: z.array(Op).max(MAX_OPS),
  /** The engine snapshot after the last op in `ops`. */
  state: z.record(z.string(), z.unknown()).optional(),
  position: z.string().max(200).nullable().optional(),
  activeMs: z.number().int().nonnegative().optional(),
  totalMs: z.number().int().nonnegative().optional(),
});
export type SyncItem = z.infer<typeof SyncItem>;

export const SyncBody = z.object({
  deviceId: DeviceId,
  interviews: z.array(SyncItem).max(50),
});

export const SubmitBody = z.object({
  deviceId: DeviceId,
  /** The client's last change number: everything up to it must be synced. */
  seq: z.number().int().nonnegative(),
  /** The path the client walked, checked against the server's own run. */
  path: z.array(z.string()).max(20_000),
});
export type SubmitBody = z.infer<typeof SubmitBody>;

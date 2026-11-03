import { createHash } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { projectSettings, type AudioSettings } from '@wansurvey/schema';
import { sql } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../common/auth-context.js';
import { Engine } from '../db/engine.js';
import { BlobStorage, LocalStorage, type ExportStorage } from '../exports/storage.js';
import { JobsService } from '../jobs/jobs.service.js';
import { inSample } from '../review/flags.js';
import type { AppConfig } from '../config.js';
import { join } from 'node:path';

export const AUDIO_STORAGE = Symbol('AUDIO_STORAGE');

/** Recordings are kept apart from the exports: another container, another folder. */
export function audioStorage(c: AppConfig): ExportStorage {
  if (c.EXPORT_STORAGE === 'blob')
    return BlobStorage.fromConfig(c, c.AZURE_STORAGE_AUDIO_CONTAINER);
  return new LocalStorage(join(c.DATA_DIR ?? join(process.cwd(), '.exports'), 'audio'));
}

/** What a recorder produces: Opus in WebM, or AAC in MP4 on Safari. */
export const AUDIO_TYPES = ['audio/webm', 'audio/mp4', 'audio/ogg'] as const;
/** About 30 seconds at 24 kbps is 90 KB; the cap leaves room for a bad encoder, not for abuse. */
export const MAX_SEGMENT_BYTES = 2 * 1024 * 1024;
export const MAX_SEGMENTS = 2000;

export interface Draw {
  record: boolean;
  consentText?: string;
  consentVersion?: number;
}

/**
 * Whether this interview is recorded: the project has recording on, with a consent wording, and
 * the interview is in the share drawn (by its id, so the answer never changes).
 */
export function drawFor(interviewId: string, a: AudioSettings, mode: string): Draw {
  if (
    mode !== 'CAPI' ||
    !a.enabled ||
    !a.consentText.trim() ||
    !inSample(interviewId, a.samplePercent)
  )
    return { record: false };
  return { record: true, consentText: a.consentText, consentVersion: a.consentVersion };
}

export interface SegmentRow {
  segment: number;
  bytes: number;
  durationMs: number;
  contentType: string;
}

/**
 * Interview recordings (ADR 0001, decision 5): segments uploaded by the device after the
 * respondent's consent, kept in a private container, listened to only through the API and
 * only with `audio.listen`, deleted with the retention job or an erasure.
 */
@Injectable()
export class AudioService implements OnModuleInit {
  private readonly logger = new Logger(AudioService.name);

  constructor(
    private readonly engine: Engine,
    private readonly audit: AuditService,
    private readonly jobs: JobsService,
    @Inject(AUDIO_STORAGE) private readonly storage: ExportStorage,
  ) {}

  onModuleInit() {
    this.jobs.register('audio.retention', () => this.retentionAll());
    this.jobs.schedule('audio.retention', { cron: '50 2 * * *' });
  }

  /** One segment from the interviewer's device; the same segment again is harmless. */
  async upload(
    ctx: AuthContext,
    interviewId: string,
    segment: number,
    body: Buffer,
    meta: { contentType: string; durationMs: number; sha256: string },
  ): Promise<{ stored: boolean }> {
    if (!AUDIO_TYPES.includes(meta.contentType as never))
      throw new BadRequestException({ code: 'BAD_TYPE', message: 'Not an accepted audio type' });
    if (!body.length || body.length > MAX_SEGMENT_BYTES)
      throw new BadRequestException({ code: 'BAD_SIZE', message: 'Empty or too large' });
    if (segment < 0 || segment >= MAX_SEGMENTS)
      throw new BadRequestException({ code: 'BAD_SEGMENT', message: 'Segment out of range' });
    const sha = createHash('sha256').update(body).digest('hex');
    if (sha !== meta.sha256.toLowerCase())
      throw new BadRequestException({ code: 'BAD_HASH', message: 'The checksum does not match' });

    return this.engine.sql.withTenant(ctx.tenantId, async (tx) => {
      const iv = await tx
        .selectFrom('interviews')
        .select(['id', 'project_id', 'interviewer_id', 'mode', 'status'])
        .where('id', '=', interviewId)
        .executeTakeFirst();
      // Another person's interview, or one that does not exist: the same answer.
      if (!iv || iv.interviewer_id?.toLowerCase() !== ctx.userId.toLowerCase())
        throw new NotFoundException('Interview not found');
      const project = await tx
        .selectFrom('projects')
        .select('settings')
        .where('id', '=', iv.project_id)
        .executeTakeFirstOrThrow();
      const audio = projectSettings(JSON.parse(project.settings)).audio;
      if (!drawFor(interviewId, audio, iv.mode).record)
        throw new ConflictException({
          code: 'NOT_RECORDED',
          message: 'This interview is not recorded',
        });
      // Nothing is kept without the respondent's yes, recorded as paradata of the interview.
      const consent = await sql<{ payload: string }>`
        SELECT TOP (1) payload FROM dbo.interview_paradata
        WHERE interview_id = ${interviewId} AND type = 'audio_consent'
        ORDER BY at DESC, seq DESC`.execute(tx);
      const granted =
        consent.rows[0] &&
        (JSON.parse(consent.rows[0].payload) as { granted?: boolean }).granted === true;
      if (!granted)
        throw new ConflictException({
          code: 'CONSENT_REQUIRED',
          message: 'No consent recorded yet',
        });

      const existing = await tx
        .selectFrom('interview_audio')
        .select(['sha256'])
        .where('interview_id', '=', interviewId)
        .where('segment', '=', segment)
        .executeTakeFirst();
      if (existing) {
        if (existing.sha256 === sha) return { stored: false };
        throw new ConflictException({
          code: 'SEGMENT_EXISTS',
          message: 'That segment holds other audio',
        });
      }
      const key = `${ctx.tenantId}/${iv.project_id.toLowerCase()}/${interviewId}/${segment}`;
      const w = this.storage.create(key, meta.contentType);
      try {
        await w.write(body);
        await w.done();
      } catch (e) {
        await w.abort();
        throw e;
      }
      await tx
        .insertInto('interview_audio')
        .values({
          id: uuidv7(),
          tenant_id: ctx.tenantId,
          project_id: iv.project_id,
          interview_id: interviewId,
          segment,
          storage_key: key,
          content_type: meta.contentType,
          bytes: body.length,
          duration_ms: Math.max(0, Math.round(meta.durationMs)),
          sha256: sha,
          uploaded_at: new Date(),
        })
        .execute();
      return { stored: true };
    });
  }

  /** The segments of an interview, in order. */
  async list(ctx: AuthContext, projectId: string, interviewId: string): Promise<SegmentRow[]> {
    const rows = await this.engine.sql.withTenant(ctx.tenantId, (tx) =>
      tx
        .selectFrom('interview_audio')
        .select(['segment', 'bytes', 'duration_ms', 'content_type'])
        .where('interview_id', '=', interviewId)
        .where('project_id', '=', projectId)
        .orderBy('segment')
        .execute(),
    );
    return rows.map((r) => ({
      segment: r.segment,
      bytes: r.bytes,
      durationMs: r.duration_ms,
      contentType: r.content_type,
    }));
  }

  /**
   * One segment, whole or a byte range. Listening is written to the log when it starts (a
   * request from byte 0), not for every range the player asks for after it.
   */
  async open(
    ctx: AuthContext,
    projectId: string,
    interviewId: string,
    segment: number,
    range: string | undefined,
  ): Promise<{
    stream: Readable;
    contentType: string;
    size: number;
    start: number;
    end: number;
    partial: boolean;
  }> {
    const row = await this.engine.sql.withTenant(ctx.tenantId, async (tx) => {
      const r = await tx
        .selectFrom('interview_audio')
        .select(['storage_key', 'content_type', 'bytes'])
        .where('interview_id', '=', interviewId)
        .where('project_id', '=', projectId)
        .where('segment', '=', segment)
        .executeTakeFirst();
      return r;
    });
    if (!row) throw new NotFoundException('Recording not found');
    const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
    let start = 0;
    let end = row.bytes - 1;
    if (m && (m[1] || m[2])) {
      if (m[1]) {
        start = Number(m[1]);
        if (m[2]) end = Math.min(end, Number(m[2]));
      } else {
        start = Math.max(0, row.bytes - Number(m[2]));
      }
      if (start > end || start >= row.bytes)
        throw new BadRequestException({ code: 'BAD_RANGE', message: 'Range not satisfiable' });
    }
    if (start === 0)
      await this.engine.sql.withTenant(ctx.tenantId, (tx) =>
        this.audit.recordIn(tx, ctx, {
          action: 'audio.listened',
          targetType: 'interview',
          targetId: interviewId,
          details: { projectId, segment },
        }),
      );
    const file = await this.storage.open(row.storage_key);
    // Blob and local storage return the whole file; the range is cut here (segments are small).
    const stream = sliceStream(file.stream, start, end);
    return {
      stream,
      contentType: row.content_type,
      size: row.bytes,
      start,
      end,
      partial: !!m && (start !== 0 || end !== row.bytes - 1),
    };
  }

  // Life of the files

  /** Removes one file from the container (an erasure goes through here). */
  removeFile(key: string): Promise<void> {
    return this.storage.remove(key);
  }

  /** Deletes recordings and their rows; the files first, so a failure leaves rows to retry. */
  async eraseInterviews(
    tx: Parameters<AuditService['recordIn']>[0],
    interviewIds: string[],
  ): Promise<number> {
    if (!interviewIds.length) return 0;
    const rows = await tx
      .selectFrom('interview_audio')
      .select(['id', 'storage_key'])
      .where('interview_id', 'in', interviewIds)
      .execute();
    for (const r of rows) await this.storage.remove(r.storage_key);
    if (rows.length)
      await tx
        .deleteFrom('interview_audio')
        .where(
          'id',
          'in',
          rows.map((r) => r.id),
        )
        .execute();
    return rows.length;
  }

  /** Nightly: recordings kept longer than their project says, after the interview was decided. */
  async retentionAll(now = new Date()): Promise<number> {
    let n = 0;
    for (const tenantId of await this.engine.allTenantIds()) {
      try {
        n += await this.engine.sql.withTenant(tenantId, async (tx) => {
          const projects = await tx.selectFrom('projects').select(['id', 'settings']).execute();
          let m = 0;
          for (const p of projects) {
            const days = projectSettings(JSON.parse(p.settings)).audio.retentionDays;
            const cutoff = new Date(now.getTime() - days * 86_400_000);
            const due = await sql<{ id: string }>`
              SELECT DISTINCT a.interview_id AS id FROM dbo.interview_audio a
              JOIN dbo.interviews i ON i.id = a.interview_id
              WHERE a.project_id = ${p.id} AND i.status IN ('approved', 'rejected')
                AND COALESCE(i.reviewed_at, i.submitted_at) < ${cutoff.toISOString()}`.execute(tx);
            const ids = due.rows.map((r) => r.id.toLowerCase());
            const gone = await this.eraseInterviews(tx, ids);
            if (gone)
              await this.audit.recordIn(tx, { tenantId } as AuthContext, {
                action: 'audio.deleted',
                details: { projectId: p.id.toLowerCase(), reason: 'retention', segments: gone },
              });
            m += gone;
          }
          return m;
        });
      } catch (e) {
        this.logger.error(`Audio retention failed for ${tenantId}: ${(e as Error).message}`);
      }
    }
    return n;
  }
}

/** Passes on bytes `start..end` (inclusive) of a stream. */
function sliceStream(source: Readable, start: number, end: number): Readable {
  if (start === 0 && end === Number.MAX_SAFE_INTEGER) return source;
  let pos = 0;
  return source.pipe(
    new Transform({
      transform(chunk: Buffer, _enc: string, cb: (e: null, d?: Buffer) => void) {
        const from = Math.max(start - pos, 0);
        const to = Math.min(end - pos + 1, chunk.length);
        pos += chunk.length;
        cb(null, from < to ? chunk.subarray(from, to) : undefined);
      },
    }),
  );
}

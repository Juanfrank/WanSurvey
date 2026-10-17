import { Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import {
  createInterview,
  type CompiledQuestionnaire,
  type InterviewSession,
} from '@wansurvey/logic';
import type { AnswerValue, SpecialKind } from '@wansurvey/schema';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { AuditService } from '../audit/audit.service.js';
import { CasesService } from '../cases/cases.service.js';
import type { AuthContext } from '../common/auth-context.js';
import { Database, type Tx } from '../db/database.js';
import {
  cases,
  interviewDevices,
  interviews,
  papiScanBatches,
  papiScanForms,
  papiScanPages,
  questionnaireVersions,
  questionnaires,
  users,
} from '../db/schema.js';
import {
  InterviewsService,
  type InterviewRow,
  type Writer,
} from '../interviews/interviews.service.js';
import { JobsService } from '../jobs/jobs.service.js';
import { interpret, type IssueKind } from './omr/interpret.js';
import {
  layoutForm,
  PAGE,
  parsePageCode,
  type Bubble,
  type FormLayout,
  type LayoutWords,
  type Measure,
} from './omr/layout.js';
import { measurer, scanFormsPdf } from './omr/pdf.js';
import { fill, findCode, locate, rasterize, type Affine, type PageImage } from './omr/read.js';
import { PapiService, type FormsQuery } from './papi.service.js';
import type { z } from 'zod';

const JOB = 'papi.scan';

/** The words printed on forms, by the form's language (Spanish unless English). */
function wordsFor(lang: string, compiled: CompiledQuestionnaire) {
  const es = !lang.startsWith('en');
  const label = (k: SpecialKind, fallback: string) => {
    const l = compiled.questionnaire.settings.specialCodes[k].label;
    return l[lang] ?? Object.values(l)[0] ?? fallback;
  };
  const words: LayoutWords = {
    markAll: es ? 'Marque todas las que correspondan' : 'Mark all that apply',
    writeHere: es ? 'escriba aquí' : 'write here',
    continued: es ? 'continúa' : 'continued',
    special: {
      DK: label('DK', es ? 'No sabe' : "Don't know"),
      RF: label('RF', es ? 'No responde' : 'Refused'),
      NA: label('NA', es ? 'No aplica' : 'Not applicable'),
    },
  };
  return {
    words,
    instructions: es
      ? 'Rellene completamente el círculo de cada respuesta con bolígrafo oscuro. No marque fuera de los círculos.'
      : 'Fill in the circle of each answer completely with a dark pen. Do not mark outside the circles.',
    pageOf: (n: number, of: number) => (es ? `Página ${n} de ${of}` : `Page ${n} of ${of}`),
  };
}

export interface ScanIssue {
  name: string;
  kind: IssueKind;
  detail?: string;
}

/**
 * Machine-readable paper forms: printed with exact positions and a code on each page, then
 * scanned in batches. Each PDF may hold many forms; pages are grouped by the case in their code,
 * the marks read, the questionnaire's rules applied, and what cannot be read (handwriting,
 * conflicting or faint marks, missing pages) left for a second round in the keying screen.
 */
@Injectable()
export class ScansService implements OnModuleInit {
  private measure: Promise<Measure> | null = null;
  private layouts = new Map<string, FormLayout>();

  constructor(
    private readonly database: Database,
    private readonly cases: CasesService,
    private readonly runtime: InterviewsService,
    private readonly papi: PapiService,
    private readonly jobs: JobsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    this.jobs.register(JOB, (data) => this.process(String(data.tenantId), String(data.batchId)));
  }

  async layout(versionId: string, compiled: CompiledQuestionnaire, lang: string) {
    const key = `${versionId}|${lang}`;
    let l = this.layouts.get(key);
    if (!l) {
      this.measure ??= measurer();
      l = layoutForm(compiled, lang, wordsFor(lang, compiled).words, await this.measure);
      if (this.layouts.size > 50) this.layouts.clear();
      this.layouts.set(key, l);
    }
    return l;
  }

  /** The machine-readable forms of the chosen cases, as one PDF. */
  async formsPdf(tx: Tx, ctx: AuthContext, projectId: string, q: z.infer<typeof FormsQuery>) {
    const f = await this.papi.forms(tx, ctx, projectId, q);
    const [v] = await tx
      .select({ id: questionnaireVersions.id })
      .from(questionnaireVersions)
      .where(
        and(
          eq(questionnaireVersions.questionnaireId, f.questionnaire.id),
          eq(questionnaireVersions.version, f.version),
        ),
      );
    const lang = f.compiled.questionnaire.defaultLanguage;
    const w = wordsFor(lang, f.compiled);
    const layout = await this.layout(v!.id, f.compiled, lang);
    const pdf = await scanFormsPdf(
      layout,
      {
        title: f.questionnaire.name,
        versionId: v!.id,
        lang,
        instructions: w.instructions,
        pageOf: w.pageOf,
      },
      f.cases.map((c) => ({ caseId: c.id, externalId: c.externalId })),
    );
    return { pdf: Buffer.from(pdf), name: f.questionnaire.name, count: f.cases.length };
  }

  /** Stores uploaded PDFs and reads them in the background. */
  async upload(
    ctx: AuthContext,
    projectId: string,
    files: { originalname: string; buffer: Buffer }[],
  ) {
    const ids = await this.database.withTenant(ctx.tenantId, async (tx) => {
      const out: string[] = [];
      for (const f of files) {
        const [b] = await tx
          .insert(papiScanBatches)
          .values({
            tenantId: ctx.tenantId,
            projectId,
            uploadedBy: ctx.userId,
            fileName: f.originalname.slice(0, 200),
            pdf: f.buffer,
          })
          .returning({ id: papiScanBatches.id });
        out.push(b!.id);
      }
      await this.audit.record(
        tx,
        ctx.tenantId,
        this.audit.fromContext(ctx, {
          action: 'papi.scans_uploaded',
          targetType: 'project',
          targetId: projectId,
          details: { files: files.map((f) => f.originalname), batches: out },
        }),
      );
      return out;
    });
    for (const id of ids)
      await this.jobs.enqueue(
        JOB,
        { tenantId: ctx.tenantId, batchId: id },
        { jobId: `scan-${id}` },
      );
    return { batches: ids };
  }

  /** Reads one uploaded PDF: splits it into forms, reads the marks and makes the interviews. */
  async process(tenantId: string, batchId: string) {
    const batch = await this.database.withTenant(tenantId, async (tx) => {
      const [b] = await tx
        .update(papiScanBatches)
        .set({ status: 'running' })
        .where(and(eq(papiScanBatches.id, batchId), eq(papiScanBatches.status, 'queued')))
        .returning();
      return b;
    });
    if (!batch?.pdf) return;
    let images: PageImage[];
    try {
      images = await rasterize(batch.pdf);
    } catch (e) {
      await this.database.withTenant(tenantId, (tx) =>
        tx
          .update(papiScanBatches)
          .set({
            status: 'failed',
            error: e instanceof Error ? e.message.slice(0, 500) : 'unreadable',
            finishedAt: new Date(),
          })
          .where(eq(papiScanBatches.id, batchId)),
      );
      return;
    }
    await this.database.withTenant(tenantId, async (tx) => {
      // Each page: its code, then where the form sits on it.
      type Found = {
        n: number;
        img: PageImage;
        code: ReturnType<typeof parsePageCode>;
        t: Affine | null;
        problem: string | null;
      };
      const found: Found[] = images.map((img, i) => {
        const raw = findCode(img);
        const code = raw ? parsePageCode(raw.text) : null;
        const t = raw && code ? locate(img, raw) : null;
        return {
          n: i + 1,
          img,
          code,
          t,
          problem: !code ? 'no_code' : !t ? 'unaligned' : null,
        };
      });
      // The forms: pages grouped by case (and version), in page order.
      const groups = new Map<string, Found[]>();
      for (const f of found)
        if (f.code && f.t) {
          const k = `${f.code.caseId}|${f.code.versionId}|${f.code.lang}`;
          groups.set(k, [...(groups.get(k) ?? []), f]);
        }
      const pageRows = new Map<Found, string | null>();
      for (const [key, pages] of groups) {
        const [caseId, versionId, lang] = key.split('|') as [string, string, string];
        const [c] = await tx
          .select()
          .from(cases)
          .where(and(eq(cases.id, caseId), eq(cases.projectId, batch.projectId)));
        const [v] = await tx
          .select()
          .from(questionnaireVersions)
          .where(eq(questionnaireVersions.id, versionId));
        if (!c || !v) {
          for (const p of pages) p.problem = c ? 'unknown_version' : 'unknown_case';
          continue;
        }
        const formId = await this.readForm(tx, batch, c, v, lang, pages);
        for (const p of pages) pageRows.set(p, formId);
      }
      for (const f of found)
        await tx.insert(papiScanPages).values({
          tenantId,
          batchId,
          formId: pageRows.get(f) ?? null,
          pageNo: f.n,
          formPage: f.code?.page ?? null,
          problem: f.problem,
          transform: f.t,
          width: f.img.width,
          height: f.img.height,
          image: f.img.png,
        });
      await tx
        .update(papiScanBatches)
        .set({ status: 'done', pages: images.length, pdf: null, finishedAt: new Date() })
        .where(eq(papiScanBatches.id, batchId));
    });
  }

  /**
   * One form: reads its marks, applies them through the questionnaire's logic (so skips,
   * ranges and other rules hold) and stores them as a paper interview. Complete forms with
   * nothing to check are submitted; the rest wait for the second round.
   */
  private async readForm(
    tx: Tx,
    batch: typeof papiScanBatches.$inferSelect,
    c: typeof cases.$inferSelect,
    v: typeof questionnaireVersions.$inferSelect,
    lang: string,
    pages: { img: PageImage; t: Affine | null; code: ReturnType<typeof parsePageCode> }[],
  ) {
    const compiled = v.compiled as CompiledQuestionnaire;
    const layout = await this.layout(v.id, compiled, lang);
    const byPage = new Map(pages.map((p) => [p.code!.page, p]));
    const formId = uuidv7();
    const issues: ScanIssue[] = [];
    const answers = new Map<string, AnswerValue>();
    for (const q of layout.questions) {
      const missing = q.rects.some((r) => !byPage.has(r.page));
      if (missing) {
        issues.push({ name: q.name, kind: 'missing_page' });
        continue;
      }
      const fills = new Map<Bubble, number>();
      for (const b of q.bubbles) {
        const p = byPage.get(b.page)!;
        fills.set(b, fill(p.img, p.t!, b));
      }
      const r = interpret(q, fills);
      if (r.value !== undefined) answers.set(q.name, r.value);
      else if (r.issue)
        issues.push({
          name: q.name,
          kind: r.issue.kind,
          ...(r.issue.detail ? { detail: r.issue.detail } : {}),
        });
    }
    const base = {
      id: formId,
      tenantId: batch.tenantId,
      projectId: batch.projectId,
      batchId: batch.id,
      caseId: c.id,
      questionnaireVersionId: v.id,
      lang,
      pagesExpected: layout.pages,
      pagesFound: [...byPage.keys()].sort((a, b) => a - b),
    };
    // A form already keyed, or being keyed, is not read twice.
    const [taken] = await tx
      .select({ id: interviews.id })
      .from(interviews)
      .where(
        and(
          eq(interviews.caseId, c.id),
          inArray(interviews.status, ['in_progress', 'submitted', 'in_review', 'approved']),
        ),
      )
      .limit(1);
    if (taken || c.status === 'finalised' || c.status === 'withdrawn') {
      await tx.insert(papiScanForms).values({ ...base, status: 'duplicate', issues });
      return formId;
    }

    // The interview, as if keyed by whoever uploaded the scans.
    const interviewId = uuidv7();
    const deviceId = `scan-${formId}`;
    const context = await this.runtime.caseContext(tx, null, batch.projectId, c, false);
    const [row] = (await tx
      .insert(interviews)
      .values({
        id: interviewId,
        tenantId: batch.tenantId,
        projectId: batch.projectId,
        caseId: c.id,
        questionnaireVersionId: v.id,
        mode: 'PAPI',
        interviewerId: batch.uploadedBy,
        language: lang,
        context,
        deviceId,
        entryPass: 1,
      })
      .returning()) as [InterviewRow];
    await tx
      .update(cases)
      .set({ status: 'in_progress', updatedAt: new Date() })
      .where(eq(cases.id, c.id));
    await this.cases.events(tx, batch.tenantId, batch.uploadedBy, [
      {
        caseId: c.id,
        type: 'interview_started',
        details: { interviewId, mode: 'PAPI', version: v.version, pass: 1, via: 'scan' },
      },
    ]);
    await tx
      .insert(interviewDevices)
      .values({ tenantId: batch.tenantId, interviewId, deviceId })
      .onConflictDoNothing();

    const session = createInterview(compiled, this.runtime.engineOptions(row));
    issues.push(...this.apply(session, answers));
    const events = session.drainEvents();
    const now = new Date().toISOString();
    const ops = events.map((e, i) => ({
      seq: i + 1,
      kind: 'answer' as const,
      variable: e.key,
      oldValue: e.oldValue,
      newValue: e.newValue,
      at: now,
      source: 'interviewer' as const,
      reason: 'scan',
    }));
    // Forward through what is answered, so the second round opens where work is left.
    while (session.next().ok && session.currentKey()) {
      /* moves on */
    }
    const writer: Writer = { tenantId: batch.tenantId, userId: batch.uploadedBy, ctx: null };
    await this.runtime.sync(
      tx,
      writer,
      deviceId,
      [
        {
          id: interviewId,
          ops,
          state: session.state() as unknown as Record<string, unknown>,
          position: session.currentKey(),
        },
      ],
      () => null,
    );
    // Nothing to check, and the questionnaire reached its end: submitted at once.
    // Only what the flow reaches matters; a mark the flow skips is worth a look too.
    const path = new Set(session.pathKeys());
    const open = issues.filter((i) => i.kind === 'off_path' || path.has(i.name));
    let status = 'review';
    if (!open.length && session.status().state !== 'in_progress') {
      const [fresh] = (await tx
        .select()
        .from(interviews)
        .where(eq(interviews.id, interviewId))) as [InterviewRow];
      await this.runtime.submit(
        tx,
        fresh,
        { deviceId, seq: ops.length, path: session.pathKeys() },
        writer,
      );
      status = 'done';
    }
    await tx.insert(papiScanForms).values({
      ...base,
      interviewId,
      status,
      issues: open,
    });
    return formId;
  }

  /**
   * Puts the read answers through the questionnaire, in path order, until nothing changes: a
   * mark the logic refuses (out of range, too many choices…) is left empty with its reason, and
   * one the flow skips is reported. Questions on the path with no answer are the second round.
   */
  private apply(session: InterviewSession, answers: Map<string, AnswerValue>): ScanIssue[] {
    const issues = new Map<string, ScanIssue>();
    const tried = new Set<string>();
    for (let round = 0; round < 50; round++) {
      let changed = false;
      for (const key of session.pathKeys()) {
        if (tried.has(key) || !answers.has(key)) continue;
        tried.add(key);
        const r = session.setAnswer(key, answers.get(key)!, 'interviewer');
        if (!r.ok) {
          issues.set(key, { name: key, kind: 'invalid', detail: r.error });
          continue;
        }
        const check = session.validate(key);
        const errors = check.errors;
        if (errors.length) {
          session.clearAnswer(key, 'interviewer');
          issues.set(key, {
            name: key,
            kind: 'invalid',
            detail: errors.map((e) => e.message).join('; '),
          });
        }
        changed = true;
      }
      if (!changed) break;
    }
    const path = new Set(session.pathKeys());
    for (const name of answers.keys())
      if (!path.has(name)) issues.set(name, { name, kind: 'off_path' });
    return [...issues.values()];
  }

  // ------------------------------------------------------------------------------------------

  /** The batches of a project, newest first, with their forms. */
  async list(tx: Tx, projectId: string) {
    const batches = await tx
      .select({
        id: papiScanBatches.id,
        fileName: papiScanBatches.fileName,
        status: papiScanBatches.status,
        pages: papiScanBatches.pages,
        error: papiScanBatches.error,
        createdAt: papiScanBatches.createdAt,
        uploadedBy: users.name,
      })
      .from(papiScanBatches)
      .leftJoin(users, eq(users.id, papiScanBatches.uploadedBy))
      .where(eq(papiScanBatches.projectId, projectId))
      .orderBy(desc(papiScanBatches.createdAt))
      .limit(50);
    if (!batches.length) return [];
    const ids = batches.map((b) => b.id);
    const forms = await tx
      .select({
        id: papiScanForms.id,
        batchId: papiScanForms.batchId,
        caseId: papiScanForms.caseId,
        externalId: cases.externalId,
        interviewId: papiScanForms.interviewId,
        status: papiScanForms.status,
        pagesExpected: papiScanForms.pagesExpected,
        pagesFound: papiScanForms.pagesFound,
        issues: papiScanForms.issues,
        interviewStatus: interviews.status,
      })
      .from(papiScanForms)
      .innerJoin(cases, eq(cases.id, papiScanForms.caseId))
      .leftJoin(interviews, eq(interviews.id, papiScanForms.interviewId))
      .where(inArray(papiScanForms.batchId, ids))
      .orderBy(asc(cases.externalId));
    const stray = await tx
      .select({
        batchId: papiScanPages.batchId,
        pageNo: papiScanPages.pageNo,
        problem: papiScanPages.problem,
      })
      .from(papiScanPages)
      .where(and(inArray(papiScanPages.batchId, ids), sql`${papiScanPages.problem} is not null`))
      .orderBy(asc(papiScanPages.pageNo));
    return batches.map((b) => ({
      ...b,
      forms: forms
        .filter((f) => f.batchId === b.id)
        .map((f) => ({
          ...f,
          // A form finished in the second round is done.
          status:
            f.status === 'review' && f.interviewStatus && f.interviewStatus !== 'in_progress'
              ? 'done'
              : f.status,
        })),
      unreadPages: stray.filter((p) => p.batchId === b.id).map(({ batchId: _b, ...p }) => p),
    }));
  }

  /**
   * What the second round needs for an interview read from a scan: per question its reason
   * and where it is on the scanned page (as fractions of the page), and the pages.
   */
  async forInterview(tx: Tx, interviewId: string) {
    const [form] = await tx
      .select()
      .from(papiScanForms)
      .where(eq(papiScanForms.interviewId, interviewId));
    if (!form) throw new NotFoundException('Not read from a scan');
    const [v] = await tx
      .select()
      .from(questionnaireVersions)
      .where(eq(questionnaireVersions.id, form.questionnaireVersionId));
    const layout = await this.layout(v!.id, v!.compiled as CompiledQuestionnaire, form.lang);
    const pages = await tx
      .select({
        id: papiScanPages.id,
        formPage: papiScanPages.formPage,
        transform: papiScanPages.transform,
        width: papiScanPages.width,
        height: papiScanPages.height,
      })
      .from(papiScanPages)
      .where(eq(papiScanPages.formId, form.id))
      .orderBy(asc(papiScanPages.formPage));
    const issues = form.issues as ScanIssue[];
    const at = (r: { page: number; x: number; y: number; w: number; h: number }) => {
      const p = pages.find((x) => x.formPage === r.page);
      if (!p?.transform) return null;
      const t = p.transform as Affine;
      // The rectangle's corners on the image, then their bounding box as fractions.
      const pts = [
        [r.x, r.y],
        [r.x + r.w, r.y],
        [r.x, r.y + r.h],
        [r.x + r.w, r.y + r.h],
      ].map(([x, y]) => ({
        x: t[0] * x! + t[1] * y! + t[2],
        y: t[3] * x! + t[4] * y! + t[5],
      }));
      const xs = pts.map((q) => q.x);
      const ys = pts.map((q) => q.y);
      return {
        pageId: p.id,
        x: Math.max(0, Math.min(...xs)) / p.width,
        y: Math.max(0, Math.min(...ys)) / p.height,
        w: (Math.max(...xs) - Math.min(...xs)) / p.width,
        h: (Math.max(...ys) - Math.min(...ys)) / p.height,
      };
    };
    return {
      formId: form.id,
      status: form.status,
      pagesExpected: form.pagesExpected,
      pagesFound: form.pagesFound,
      pages: pages.map((p) => ({
        id: p.id,
        formPage: p.formPage,
        width: p.width,
        height: p.height,
      })),
      page: { w: PAGE.w, h: PAGE.h },
      questions: Object.fromEntries(
        layout.questions.map((q) => [
          q.name,
          {
            reading: q.reading,
            issue: issues.find((i) => i.name === q.name) ?? null,
            areas: q.rects.map(at).filter((a) => a !== null),
          },
        ]),
      ),
    };
  }

  /** A scanned page's image. */
  async pageImage(tx: Tx, pageId: string) {
    const [p] = await tx
      .select({ image: papiScanPages.image })
      .from(papiScanPages)
      .where(eq(papiScanPages.id, pageId));
    if (!p) throw new NotFoundException('Page not found');
    return p.image;
  }

  /**
   * Takes a form's interview to do its second round: the person keying it becomes its holder
   * (of the case too), so it opens on their screen like any other keyed form.
   */
  async claim(tx: Tx, ctx: AuthContext, projectId: string, formId: string) {
    const [form] = await tx
      .select()
      .from(papiScanForms)
      .where(and(eq(papiScanForms.id, formId), eq(papiScanForms.projectId, projectId)));
    if (!form?.interviewId) throw new NotFoundException('Form not found');
    const [row] = await tx
      .update(interviews)
      .set({ interviewerId: ctx.userId, updatedAt: new Date() })
      .where(and(eq(interviews.id, form.interviewId), eq(interviews.status, 'in_progress')))
      .returning({ id: interviews.id });
    if (!row) throw new NotFoundException('This form is already finished');
    await tx
      .update(cases)
      .set({ assignedTo: ctx.userId, updatedAt: new Date() })
      .where(eq(cases.id, form.caseId));
    return { interviewId: row.id };
  }

  /** A questionnaire's name for file names. */
  async questionnaireName(tx: Tx, id: string) {
    const [q] = await tx
      .select({ name: questionnaires.name })
      .from(questionnaires)
      .where(eq(questionnaires.id, id));
    return q?.name ?? 'forms';
  }
}

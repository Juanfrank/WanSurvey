import { BlobServiceClient } from '@azure/storage-blob';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExportsService } from '../../src/exports/exports.service.js';
import { BlobStorage } from '../../src/exports/storage.js';
import { JobsService } from '../../src/jobs/jobs.service.js';
import { startAzurite, type Azurite } from '../support/azurite.js';
import { createQuestionnaire } from './fixtures.js';
import {
  bootstrap,
  configured,
  createProject,
  createTenant,
  createUser,
  login,
  type MssqlTestApp,
  type Session,
} from './harness.js';

/** An export through the job, stored as a blob (test/export-blob.test.ts), on SQL Server. */
describe.skipIf(!configured)('SQL Server: an export through the job, in Blob Storage', () => {
  let azurite: Azurite;
  let t: MssqlTestApp;
  let pm: Session;
  let project: string;
  let tenantId: string;
  let container: ReturnType<BlobServiceClient['getContainerClient']>;

  beforeAll(async () => {
    azurite = await startAzurite();
    if (!azurite.available) return;
    container = azurite.service.getContainerClient(`t${Date.now()}`);
    t = await bootstrap({ exportStorage: new BlobStorage(container) });
    const tenant = await createTenant(t.owner);
    tenantId = tenant.id;
    project = await createProject(t.owner, tenant.id);
    await createQuestionnaire(t.owner, tenant.id, project, { publish: true });
    pm = await login(
      t,
      await createUser(t.owner, tenant.id, [{ role: 'project_manager', projectId: project }]),
      tenant.slug,
    );
  }, 60_000);
  afterAll(async () => {
    await t?.close();
    azurite?.stop();
  });

  it('stores the file as a blob, downloads it, and deletes it when it expires', async (ctx) => {
    if (!azurite.available) ctx.skip();
    const created = await pm.agent
      .post(`/api/v1/projects/${project}/exports`)
      .set('x-csrf-token', pm.csrf)
      .send({ format: 'csv' })
      .expect(201);
    await t.app.get(JobsService).drain();
    const names: string[] = [];
    for await (const b of container.listBlobsFlat()) names.push(b.name);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(new RegExp(`^${tenantId}/${created.body.id}/.+\\.csv$`));
    const file = await pm.agent
      .get(`/api/v1/projects/${project}/exports/${created.body.id}/file`)
      .expect(200);
    expect(file.text.startsWith('﻿interview_id,')).toBe(true);

    // Expired (as if made 8 days ago): the blob goes too.
    await t.app.get(ExportsService).expireOld(new Date(Date.now() + 8 * 86_400_000));
    const left: string[] = [];
    for await (const b of container.listBlobsFlat()) left.push(b.name);
    expect(left).toEqual([]);
  });
});

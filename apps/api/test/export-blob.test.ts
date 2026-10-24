import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { BlobServiceClient } from '@azure/storage-blob';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExportsService } from '../src/exports/exports.service.js';
import { BlobStorage } from '../src/exports/storage.js';
import { JobsService } from '../src/jobs/jobs.service.js';
import {
  bootstrap,
  createProject,
  createQuestionnaire,
  createTenant,
  createUser,
  login,
  type Session,
  type TestApp,
} from './harness.js';

/** Azurite's well-known development account. */
const KEY =
  'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';

const freePort = () =>
  new Promise<number>((ok) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address() as { port: number };
      s.close(() => ok(port));
    });
  });

async function streamToBuffer(s: NodeJS.ReadableStream) {
  const parts: Buffer[] = [];
  for await (const c of s) parts.push(Buffer.from(c as Buffer));
  return Buffer.concat(parts);
}

/**
 * Export files in Azure Blob Storage, against Azurite (the storage emulator): written in
 * blocks as they are built, never whole in memory, and nothing left of a file that fails.
 */
describe('exports in Blob Storage', () => {
  let azurite: ChildProcess | undefined;
  let service: BlobServiceClient;
  let available = false;

  beforeAll(async () => {
    const port = await freePort();
    // The server itself (not npx), so killing it stops it.
    azurite = spawn(
      process.execPath,
      [
        createRequire(import.meta.url).resolve('azurite/dist/src/blob/main.js'),
        '--inMemoryPersistence',
        '--silent',
        '--skipApiVersionCheck',
        '--blobPort',
        String(port),
      ],
      { stdio: 'ignore' },
    );
    service = BlobServiceClient.fromConnectionString(
      `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=${KEY};BlobEndpoint=http://127.0.0.1:${port}/devstoreaccount1;`,
    );
    for (let k = 0; k < 60 && !available; k++) {
      available = await service
        .getProperties()
        .then(() => true)
        .catch(() => false);
      if (!available) await new Promise((r) => setTimeout(r, 250));
    }
  }, 30_000);
  afterAll(() => {
    azurite?.kill();
  });

  it('writes a file in blocks with back-pressure, reads it back, and removes it', async (ctx) => {
    if (!available) ctx.skip();
    const storage = new BlobStorage(service.getContainerClient(`t${Date.now()}`));
    const w = storage.create('a/b/file.csv', 'text/csv');
    // 20 MiB in 64 KiB chunks: more than the blocks in flight, so writes have to wait.
    const chunk = new Uint8Array(64 * 1024).fill(65);
    for (let k = 0; k < 320; k++) await w.write(chunk);
    await w.done();
    expect(w.size).toBe(20 * 1024 * 1024);
    const { stream, size } = await storage.open('a/b/file.csv');
    expect(size).toBe(20 * 1024 * 1024);
    const back = await streamToBuffer(stream);
    expect(back.length).toBe(size);
    expect(back.every((b) => b === 65)).toBe(true);
    await storage.remove('a/b/file.csv');
    await expect(storage.open('a/b/file.csv')).rejects.toThrow();
  });

  it('leaves nothing of a file that is abandoned', async (ctx) => {
    if (!available) ctx.skip();
    const container = service.getContainerClient(`t${Date.now()}`);
    const storage = new BlobStorage(container);
    const w = storage.create('x.csv', 'text/csv');
    await w.write(new Uint8Array(1024).fill(1));
    await w.abort();
    const names: string[] = [];
    for await (const b of container.listBlobsFlat()) names.push(b.name);
    expect(names).toEqual([]);
  });

  describe('an export through the job', () => {
    let t: TestApp;
    let pm: Session;
    let project: string;
    let tenantId: string;
    let container: ReturnType<BlobServiceClient['getContainerClient']>;

    beforeAll(async () => {
      if (!available) return;
      container = service.getContainerClient(`t${Date.now()}`);
      t = await bootstrap({ exportStorage: new BlobStorage(container) });
      const tenant = await createTenant(t.admin);
      tenantId = tenant.id;
      project = await createProject(t.admin, tenant.id);
      await createQuestionnaire(t.admin, tenant.id, project, { publish: true });
      pm = await login(
        t.app,
        await createUser(t.admin, tenant.id, [{ role: 'project_manager', projectId: project }]),
      );
    });
    afterAll(async () => {
      await t?.close();
    });

    it('stores the file as a blob, downloads it, and deletes it when it expires', async (ctx) => {
      if (!available) ctx.skip();
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
});

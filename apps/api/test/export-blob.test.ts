import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BlobStorage } from '../src/exports/storage.js';
import { startAzurite, type Azurite } from './support/azurite.js';

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
  let azurite: Azurite;

  beforeAll(async () => {
    azurite = await startAzurite();
  }, 30_000);
  afterAll(() => azurite?.stop());

  it('writes a file in blocks with back-pressure, reads it back, and removes it', async (ctx) => {
    if (!azurite.available) ctx.skip();
    const storage = new BlobStorage(azurite.service.getContainerClient(`t${Date.now()}`));
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
    if (!azurite.available) ctx.skip();
    const container = azurite.service.getContainerClient(`t${Date.now()}`);
    const storage = new BlobStorage(container);
    const w = storage.create('x.csv', 'text/csv');
    await w.write(new Uint8Array(1024).fill(1));
    await w.abort();
    const names: string[] = [];
    for await (const b of container.listBlobsFlat()) names.push(b.name);
    expect(names).toEqual([]);
  });
});

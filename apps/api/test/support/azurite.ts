import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { BlobServiceClient } from '@azure/storage-blob';

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

export interface Azurite {
  service: BlobServiceClient;
  available: boolean;
  stop(): void;
}

/** Starts Azurite (the storage emulator) in memory, on a free port, and waits until it answers. */
export async function startAzurite(): Promise<Azurite> {
  const port = await freePort();
  // The server itself (not npx), so killing it stops it.
  const child: ChildProcess = spawn(
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
  const service = BlobServiceClient.fromConnectionString(
    `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=${KEY};BlobEndpoint=http://127.0.0.1:${port}/devstoreaccount1;`,
  );
  let available = false;
  for (let k = 0; k < 60 && !available; k++) {
    available = await service
      .getProperties()
      .then(() => true)
      .catch(() => false);
    if (!available) await new Promise((r) => setTimeout(r, 250));
  }
  return { service, available, stop: () => void child.kill() };
}

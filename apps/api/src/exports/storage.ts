import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { once } from 'node:events';
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import type { AppConfig } from '../config.js';

/** A file being written; `done` makes it visible, `abort` leaves nothing behind. */
export interface StorageWriter {
  /** Waits when the storage is behind (back-pressure), so memory stays bounded. */
  write(chunk: Uint8Array): Promise<void>;
  readonly size: number;
  done(): Promise<void>;
  abort(): Promise<void>;
}

/** Where export files live: written as they are built, read back to download. */
export interface ExportStorage {
  create(key: string, contentType: string): StorageWriter;
  open(key: string): Promise<{ stream: Readable; size: number }>;
  remove(key: string): Promise<void>;
}

export const EXPORT_STORAGE = Symbol('EXPORT_STORAGE');

/** Blocks of 4 MiB, 4 in flight: at most ~16 MiB of a file in memory while uploading. */
const BLOCK = 4 * 1024 * 1024;
const IN_FLIGHT = 4;

/**
 * The app's managed identity, as a token credential for the Storage SDK: tokens from App
 * Service's identity endpoint (IDENTITY_ENDPOINT, IDENTITY_HEADER), or from the instance
 * metadata service elsewhere in Azure; kept until five minutes before they expire. (What
 * @azure/identity's ManagedIdentityCredential does, without its MSAL dependency.)
 */
export class ManagedIdentity {
  private cached?: { token: string; expiresOnTimestamp: number };

  constructor(
    private readonly clientId?: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async getToken(scopes: string | string[]) {
    if (this.cached && this.cached.expiresOnTimestamp - Date.now() > 5 * 60_000) return this.cached;
    const scope = Array.isArray(scopes) ? scopes[0]! : scopes;
    const resource = scope.replace(/\/\.default$/, '/');
    const endpoint = this.env.IDENTITY_ENDPOINT;
    const url = new URL(endpoint ?? 'http://169.254.169.254/metadata/identity/oauth2/token');
    url.searchParams.set('resource', resource);
    url.searchParams.set('api-version', endpoint ? '2019-08-01' : '2018-02-01');
    if (this.clientId) url.searchParams.set('client_id', this.clientId);
    const res = await fetch(url, {
      headers: endpoint
        ? { 'X-IDENTITY-HEADER': this.env.IDENTITY_HEADER ?? '' }
        : { Metadata: 'true' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Managed identity token: HTTP ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_on: string | number };
    this.cached = { token: body.access_token, expiresOnTimestamp: Number(body.expires_on) * 1000 };
    return this.cached;
  }
}

/** Azure Blob Storage, through the app's managed identity (or a connection string: Azurite). */
export class BlobStorage implements ExportStorage {
  private ready?: Promise<unknown>;

  constructor(private readonly container: ContainerClient) {}

  static fromConfig(c: AppConfig) {
    if (c.AZURE_STORAGE_CONNECTION_STRING)
      return new BlobStorage(
        BlobServiceClient.fromConnectionString(
          c.AZURE_STORAGE_CONNECTION_STRING,
        ).getContainerClient(c.EXPORT_BLOB_CONTAINER),
      );
    // The URL names the container; AZURE_CLIENT_ID picks a user-assigned identity.
    const url = new URL(c.EXPORT_BLOB_URL!);
    const name = url.pathname.replace(/^\/+|\/+$/g, '') || c.EXPORT_BLOB_CONTAINER;
    const service = new BlobServiceClient(url.origin, new ManagedIdentity(c.AZURE_CLIENT_ID));
    return new BlobStorage(service.getContainerClient(name));
  }

  /** The container exists in Azure (Bicep makes it); created here for Azurite. */
  private ensure() {
    return (this.ready ??= this.container.createIfNotExists().catch(() => undefined));
  }

  create(key: string, contentType: string): StorageWriter {
    const blob = this.container.getBlockBlobClient(key);
    const pass = new PassThrough({ highWaterMark: BLOCK });
    const abort = new AbortController();
    let size = 0;
    let failed: unknown;
    const upload = this.ensure()
      .then(() =>
        blob.uploadStream(pass, BLOCK, IN_FLIGHT, {
          blobHTTPHeaders: { blobContentType: contentType },
          abortSignal: abort.signal,
        }),
      )
      .catch((e: unknown) => {
        failed = e;
        pass.destroy();
        throw e;
      });
    // Seen by write() or done(); never an unhandled rejection meanwhile.
    upload.catch(() => undefined);
    return {
      get size() {
        return size;
      },
      async write(chunk) {
        if (failed) throw failed;
        size += chunk.length;
        if (!pass.write(chunk))
          await Promise.race([once(pass, 'drain'), upload.then(() => undefined)]);
        if (failed) throw failed;
      },
      async done() {
        pass.end();
        await upload;
      },
      async abort() {
        abort.abort();
        // Ended, not destroyed: the SDK waits for the stream's end to settle the upload (it
        // is aborted, or commits what it had, deleted just below).
        pass.end();
        await upload.catch(() => undefined);
        // Blocks never committed are not a blob; one that was is deleted.
        await blob.deleteIfExists().catch(() => undefined);
      },
    };
  }

  async open(key: string) {
    const blob = this.container.getBlobClient(key);
    const res = await blob.download();
    return { stream: res.readableStreamBody as Readable, size: res.contentLength ?? 0 };
  }

  async remove(key: string) {
    await this.container.getBlobClient(key).deleteIfExists();
  }
}

/** A directory on this machine: development and tests, where API and worker share a disk. */
export class LocalStorage implements ExportStorage {
  constructor(private readonly dir: string) {}

  private path(key: string) {
    const p = resolve(this.dir, key);
    if (!p.startsWith(resolve(this.dir) + sep)) throw new Error('Invalid storage key');
    return p;
  }

  create(key: string): StorageWriter {
    const final = this.path(key);
    const part = `${final}.part`;
    let size = 0;
    let out: ReturnType<typeof createWriteStream> | undefined;
    const opened = mkdir(dirname(final), { recursive: true }).then(() => {
      out = createWriteStream(part);
      return out;
    });
    return {
      get size() {
        return size;
      },
      async write(chunk) {
        const s = await opened;
        size += chunk.length;
        if (!s.write(chunk)) await once(s, 'drain');
      },
      async done() {
        const s = await opened;
        s.end();
        await once(s, 'finish');
        await rename(part, final);
      },
      async abort() {
        await opened.catch(() => undefined);
        out?.destroy();
        await rm(part, { force: true });
      },
    };
  }

  async open(key: string) {
    const p = this.path(key);
    const { size } = await stat(p);
    return { stream: createReadStream(p), size };
  }

  async remove(key: string) {
    await rm(this.path(key), { force: true });
  }
}

export function exportStorage(c: AppConfig): ExportStorage {
  if (c.EXPORT_STORAGE === 'blob') return BlobStorage.fromConfig(c);
  return new LocalStorage(c.EXPORT_DIR ?? join(process.cwd(), '.exports'));
}

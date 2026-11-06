/**
 * Uploaded files (employee documents, leave attachments) are compressed and
 * stored in Postgres (`stored_files`), so a single database backup holds
 * every record and every file. Rows that own a file keep the reference
 * 'db:<id>' in their stored-name column. Downloads always go through an
 * authenticated route that checks access first.
 *
 * Compression, decided per file:
 * - Photos and scans (JPEG, PNG, WebP): turned upright from EXIF, scaled to
 *   at most 2400 px on the long side and re-encoded (JPEG via mozjpeg q80,
 *   WebP q82 when the image has transparency). The smaller of the original
 *   and the result is kept. This is where real savings come from.
 * - PDF and Word: Brotli, lossless and byte-exact on download. These formats
 *   are already compressed inside, so savings are modest; the file is kept as
 *   uploaded when Brotli saves under 5%. PDF internals are never rewritten,
 *   because that would break the digital signature on a signed contract.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, unlink } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, brotliDecompress, constants as zlib } from 'node:zlib';
import type { MultipartFile } from '@fastify/multipart';
import type { FastifyReply } from 'fastify';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { db, type DbOrTx } from '../db/client.js';
import { employeeDocuments, leaveApplications, storedFiles } from '../db/schema.js';
import { NotFoundError, ValidationError } from './errors.js';

const brotli = promisify(brotliCompress);
const unbrotli = promisify(brotliDecompress);

const ALLOWED = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
const IMAGE = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_SIDE = 2400;
/** a small file can declare a huge canvas (an image bomb): refuse anything above 50 megapixels */
const MAX_PIXELS = 50_000_000;

// libvips threads per image; with the gate below at most 2 × 2 threads compress at once
sharp.concurrency(2);

/**
 * At most two files are compressed at the same time; the rest wait their turn.
 * Keeps memory and CPU bounded however many people upload at once.
 */
const MAX_PARALLEL = 2;
let active = 0;
const waiting: Array<() => void> = [];
async function withCompressionSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_PARALLEL) await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

export interface SavedUpload {
  /** reference to store on the owning row: 'db:<id>' */
  storedName: string;
  /** original name, with the extension changed when an image was re-encoded */
  fileName: string;
  /** type of what will be served */
  mimeType: string;
  /** size of what will be served */
  sizeBytes: number;
  originalSize: number;
  storedSize: number;
}

/** Light check that the bytes match the declared type, so a renamed file can't pose as a PDF. */
function looksLike(mime: string, b: Buffer): boolean {
  const hex = b.subarray(0, 8).toString('hex');
  switch (mime) {
    case 'application/pdf':
      return b.subarray(0, 5).toString('latin1') === '%PDF-';
    case 'image/jpeg':
      return hex.startsWith('ffd8ff');
    case 'image/png':
      return hex === '89504e470d0a1a0a';
    case 'image/webp':
      return b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP';
    case 'application/msword':
      return hex === 'd0cf11e0a1b11ae1';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return hex.startsWith('504b0304');
    default:
      return false;
  }
}

function withExt(name: string, ext: string): string {
  const base = name.slice(0, name.length - extname(name).length) || 'file';
  return `${base}${ext}`;
}

/** Re-encodes an image smaller; returns null when the original is already the smaller one. */
async function shrinkImage(input: Buffer, mime: string): Promise<{ data: Buffer; mime: string; ext: string } | null> {
  try {
    const img = sharp(input, { failOn: 'error', limitInputPixels: MAX_PIXELS }).rotate();
    const meta = await img.metadata();
    const resized = img.resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true });
    const out = meta.hasAlpha
      ? { data: await resized.webp({ quality: 82, effort: 5 }).toBuffer(), mime: 'image/webp', ext: '.webp' }
      : { data: await resized.jpeg({ quality: 80, mozjpeg: true }).toBuffer(), mime: 'image/jpeg', ext: '.jpg' };
    return out.data.length < input.length ? out : null;
  } catch (err) {
    if (/pixel limit/i.test(String((err as Error)?.message))) throw new ValidationError('This image is too large in pixels. Scan it at a lower resolution');
    throw new ValidationError(`This ${mime === 'image/png' ? 'PNG' : mime === 'image/webp' ? 'WebP' : 'JPEG'} image could not be read`);
  }
}

/** Compresses `input` and inserts it; returns what the owning row should store. */
export async function storeBuffer(tx: DbOrTx, input: Buffer, fileName: string, mimeType: string): Promise<SavedUpload> {
  const c = await withCompressionSlot(() => compress(input, fileName, mimeType));
  const [row] = await tx
    .insert(storedFiles)
    .values({
      fileName: c.servedName,
      mimeType: c.servedMime,
      originalSize: input.length,
      servedSize: c.served.length,
      storedSize: c.data.length,
      encoding: c.encoding,
      sha256: createHash('sha256').update(c.served).digest('hex'),
      data: c.data,
    })
    .returning({ id: storedFiles.id });
  return {
    storedName: `db:${row.id}`,
    fileName: c.servedName,
    mimeType: c.servedMime,
    sizeBytes: c.served.length,
    originalSize: input.length,
    storedSize: c.data.length,
  };
}

async function compress(input: Buffer, fileName: string, mimeType: string) {
  let served = input;
  let servedMime = mimeType;
  let servedName = fileName.slice(0, 200);

  if (IMAGE.has(mimeType)) {
    const shrunk = await shrinkImage(input, mimeType);
    if (shrunk) {
      served = shrunk.data;
      servedMime = shrunk.mime;
      if (shrunk.mime !== mimeType) servedName = withExt(servedName, shrunk.ext);
    }
  }

  // images are already compressed after re-encoding; everything else gets Brotli when it pays
  let data = served;
  let encoding: 'identity' | 'br' = 'identity';
  if (!IMAGE.has(servedMime)) {
    const br = await brotli(served, {
      params: {
        [zlib.BROTLI_PARAM_QUALITY]: 9,
        [zlib.BROTLI_PARAM_LGWIN]: 22,
        [zlib.BROTLI_PARAM_SIZE_HINT]: served.length,
      },
    });
    if (br.length < served.length * 0.95) {
      data = br;
      encoding = 'br';
    }
  }

  return { served, servedMime, servedName, data, encoding };
}

/** Reads a multipart file, checks it, compresses it and stores it in the database. */
export async function saveUpload(file: MultipartFile, tx: DbOrTx = db): Promise<SavedUpload> {
  if (!ALLOWED.has(file.mimetype)) {
    file.file.resume();
    throw new ValidationError('Upload a PDF, image or Word document');
  }
  let input: Buffer;
  try {
    input = await file.toBuffer();
  } catch {
    throw new ValidationError(`File is larger than ${config.UPLOAD_MAX_MB} MB`);
  }
  if (file.file.truncated) throw new ValidationError(`File is larger than ${config.UPLOAD_MAX_MB} MB`);
  if (input.length === 0) throw new ValidationError('The file is empty');
  if (!looksLike(file.mimetype, input)) throw new ValidationError('The file content does not match its type');
  return storeBuffer(tx, input, file.filename, file.mimetype);
}

function dbId(storedName: string): number | null {
  const m = /^db:(\d+)$/.exec(storedName);
  return m ? Number(m[1]) : null;
}

/** Removes a stored file (used to roll back an upload whose record failed to save). */
export async function deleteUpload(storedName: string, tx: DbOrTx = db): Promise<void> {
  const id = dbId(storedName);
  if (id) await tx.delete(storedFiles).where(eq(storedFiles.id, id));
}

/**
 * Sends a stored file. For database files the stored name and type win over
 * what the caller passes, since an image may have been re-encoded at upload.
 */
export async function sendUpload(
  reply: FastifyReply,
  stored: { storedName: string; fileName: string; mimeType?: string },
  inline = true,
): Promise<FastifyReply> {
  const id = dbId(stored.storedName);
  let body: Buffer;
  let mime = stored.mimeType ?? 'application/octet-stream';
  let name = stored.fileName;

  if (id) {
    const [f] = await db.select().from(storedFiles).where(eq(storedFiles.id, id));
    if (!f) throw new NotFoundError('File not found');
    body = f.encoding === 'br' ? await unbrotli(f.data) : f.data;
    mime = f.mimeType;
    if (extname(f.fileName) !== extname(name)) name = withExt(name, extname(f.fileName));
  } else {
    // a file uploaded before database storage that has not been moved yet
    if (!/^[a-f0-9]{32}(\.[a-z0-9]{1,7})?$/.test(stored.storedName)) throw new NotFoundError('File not found');
    try {
      body = await readFile(join(config.UPLOAD_DIR, stored.storedName));
    } catch {
      throw new NotFoundError('File not found');
    }
  }

  const safeInline = inline && (mime === 'application/pdf' || mime.startsWith('image/'));
  return reply
    .header('content-type', mime)
    .header('content-length', body.length)
    .header('content-disposition', `${safeInline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`)
    .header('x-content-type-options', 'nosniff')
    .header('cache-control', 'private, no-store')
    .send(body);
}

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/**
 * One-time move at boot: files still on disk from before database storage are
 * compressed into stored_files and their rows re-pointed. Idempotent; the
 * disk copy is deleted only after its row points at the database copy.
 */
export async function moveDiskUploadsToDb(log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void }): Promise<void> {
  let names: string[];
  try {
    names = await readdir(config.UPLOAD_DIR);
  } catch {
    return; // no upload directory: nothing to move
  }
  if (names.length === 0) return;

  let moved = 0;
  let saved = 0;
  const docs = await db.select().from(employeeDocuments);
  for (const d of docs) {
    if (dbId(d.storedName) || !names.includes(d.storedName)) continue;
    const path = join(config.UPLOAD_DIR, d.storedName);
    try {
      const buf = await readFile(path);
      await db.transaction(async (tx) => {
        const s = await storeBuffer(tx, buf, d.fileName, d.mimeType);
        await tx
          .update(employeeDocuments)
          .set({ storedName: s.storedName, fileName: s.fileName, mimeType: s.mimeType, sizeBytes: s.sizeBytes })
          .where(eq(employeeDocuments.id, d.id));
        saved += s.originalSize - s.storedSize;
      });
      await unlink(path).catch(() => undefined);
      moved++;
    } catch (err) {
      log.warn({ err, id: d.id }, 'could not move an employee document into the database');
    }
  }

  const apps = await db
    .select({ id: leaveApplications.id, stored: leaveApplications.attachmentStored, name: leaveApplications.attachmentName })
    .from(leaveApplications);
  for (const a of apps) {
    if (!a.stored || dbId(a.stored) || !names.includes(a.stored)) continue;
    const path = join(config.UPLOAD_DIR, a.stored);
    const mime = MIME_BY_EXT[extname(a.stored).toLowerCase()];
    if (!mime) continue;
    try {
      const buf = await readFile(path);
      await db.transaction(async (tx) => {
        const s = await storeBuffer(tx, buf, a.name ?? `attachment${extname(a.stored!)}`, mime);
        await tx.update(leaveApplications).set({ attachmentStored: s.storedName, attachmentName: s.fileName }).where(eq(leaveApplications.id, a.id));
        saved += s.originalSize - s.storedSize;
      });
      await unlink(path).catch(() => undefined);
      moved++;
    } catch (err) {
      log.warn({ err, id: a.id }, 'could not move a leave attachment into the database');
    }
  }
  if (moved > 0) log.info({ moved, savedBytes: saved }, 'moved uploaded files from disk into the database');
}


import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config.js';

const key = Buffer.from(config.ENCRYPTION_KEY, 'base64');
if (key.length !== 32) throw new Error('ENCRYPTION_KEY deve essere 32 byte in base64 (openssl rand -base64 32)');

/** Cifra con AES-256-GCM. Formato: iv.tag.ciphertext (base64). */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

export function decrypt(payload: string): string {
  const [iv, tag, enc] = payload.split('.').map((p) => Buffer.from(p, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

/** File cifrato: "GCPB1" + iv (12 byte) + dati cifrati + tag (16 byte), AES-256-GCM in streaming */
const FILE_MAGIC = Buffer.from('GCPB1');

/** Cifra un file su disco senza caricarlo in memoria (archivi dei backup, anche grandi) */
export async function encryptFile(src: string, dest: string): Promise<void> {
  const { createReadStream, createWriteStream } = await import('node:fs');
  const { pipeline } = await import('node:stream/promises');
  const { appendFile, writeFile } = await import('node:fs/promises');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  await writeFile(dest, Buffer.concat([FILE_MAGIC, iv]));
  await pipeline(createReadStream(src), cipher, createWriteStream(dest, { flags: 'a' }));
  await appendFile(dest, cipher.getAuthTag());
}

/**
 * Flusso in chiaro di un file cifrato con encryptFile. Il tag si legge prima dalla fine del file: se il file
 * è stato alterato il flusso termina con un errore.
 */
export async function decryptFileStream(file: string): Promise<NodeJS.ReadableStream> {
  const { createReadStream } = await import('node:fs');
  const { open } = await import('node:fs/promises');
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    const head = Buffer.alloc(FILE_MAGIC.length + 12);
    await fh.read(head, 0, head.length, 0);
    if (!head.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC)) throw new Error('File di backup non riconosciuto');
    const tag = Buffer.alloc(16);
    await fh.read(tag, 0, 16, size - 16);
    const decipher = createDecipheriv('aes-256-gcm', key, head.subarray(FILE_MAGIC.length));
    decipher.setAuthTag(tag);
    return createReadStream(file, { start: head.length, end: size - 17 }).pipe(decipher);
  } finally {
    await fh.close();
  }
}

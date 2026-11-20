import { gzipSync } from 'node:zlib';

/**
 * Archivio .tar.gz (formato ustar) da un elenco di file in memoria. Basta per scaricare la configurazione
 * di un plan: nessuna dipendenza esterna, percorsi con "/" fino a 255 caratteri.
 */
export function tarGz(files: Record<string, Buffer>, mtime = new Date()): Buffer {
  const blocks: Buffer[] = [];
  const seconds = Math.floor(mtime.getTime() / 1000);
  for (const [rawPath, data] of Object.entries(files)) {
    const filePath = rawPath.replace(/^\/+/, '');
    let name = filePath;
    let prefix = '';
    if (Buffer.byteLength(name) > 100) {
      // ustar: il percorso si divide in prefisso (fino a 155) e nome (fino a 100) su una "/"
      const cut = filePath.lastIndexOf('/', 155);
      if (cut <= 0 || Buffer.byteLength(filePath.slice(cut + 1)) > 100) throw new Error(`Percorso troppo lungo per l'archivio: ${filePath}`);
      prefix = filePath.slice(0, cut);
      name = filePath.slice(cut + 1);
    }
    const header = Buffer.alloc(512, 0);
    const write = (value: string, offset: number, length: number) => header.write(value, offset, length, 'utf8');
    const octal = (value: number, length: number) => value.toString(8).padStart(length - 1, '0') + '\0';
    write(name, 0, 100);
    write(octal(0o644, 8), 100, 8); // permessi
    write(octal(0, 8), 108, 8); // uid
    write(octal(0, 8), 116, 8); // gid
    write(octal(data.length, 12), 124, 12);
    write(octal(seconds, 12), 136, 12);
    write('        ', 148, 8); // checksum: spazi durante il calcolo
    write('0', 156, 1); // file normale
    write('ustar\0', 257, 6);
    write('00', 263, 2);
    write(prefix, 345, 155);
    let sum = 0;
    for (const byte of header) sum += byte;
    write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    blocks.push(header, data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad, 0));
  }
  blocks.push(Buffer.alloc(1024, 0)); // fine archivio
  return gzipSync(Buffer.concat(blocks));
}

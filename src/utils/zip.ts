import { openSync, readSync, closeSync, statSync } from 'node:fs';

export interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
  crc32: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_LOCATOR = 0x07064b50;
const CENTRAL_SIGNATURE = 0x02014b50;

function readUInt32LE(buf: Buffer, offset: number): number {
  return buf.readUInt32LE(offset);
}

function readUInt16LE(buf: Buffer, offset: number): number {
  return buf.readUInt16LE(offset);
}

function findEocdOffset(fd: number, fileSize: number): number {
  const maxComment = 65535;
  const readSize = Math.min(fileSize, maxComment + 22);
  const buf = Buffer.alloc(readSize);
  readSync(fd, buf, 0, readSize, fileSize - readSize);
  for (let i = buf.length - 22; i >= 0; i--) {
    if (readUInt32LE(buf, i) === EOCD_SIGNATURE) {
      return fileSize - readSize + i;
    }
  }
  throw new Error('Not a valid ZIP archive (EOCD not found).');
}

function parseZip64Locator(fd: number, eocdOffset: number): number | undefined {
  if (eocdOffset < 20) return undefined;
  const buf = Buffer.alloc(20);
  readSync(fd, buf, 0, 20, eocdOffset - 20);
  if (readUInt32LE(buf, 0) !== ZIP64_EOCD_LOCATOR) return undefined;
  const zip64EocdOffset = Number(buf.readBigUInt64LE(8));
  return zip64EocdOffset;
}

export function listZipEntries(filePath: string): ZipEntry[] {
  const fileSize = statSync(filePath).size;
  const fd = openSync(filePath, 'r');
  try {
    const eocdOffset = findEocdOffset(fd, fileSize);
    const eocd = Buffer.alloc(22);
    readSync(fd, eocd, 0, 22, eocdOffset);

    let centralOffset = readUInt32LE(eocd, 16);
    let centralSize = readUInt32LE(eocd, 12);
    let entryCount = readUInt16LE(eocd, 10);

    if (centralOffset === 0xffffffff || centralSize === 0xffffffff || entryCount === 0xffff) {
      const zip64Offset = parseZip64Locator(fd, eocdOffset);
      if (zip64Offset === undefined) {
        throw new Error('ZIP64 archive is missing locator; cannot parse.');
      }
      const zip64 = Buffer.alloc(56);
      readSync(fd, zip64, 0, 56, zip64Offset);
      entryCount = Number(zip64.readBigUInt64LE(32));
      centralSize = Number(zip64.readBigUInt64LE(40));
      centralOffset = Number(zip64.readBigUInt64LE(48));
    }

    const central = Buffer.alloc(centralSize);
    readSync(fd, central, 0, centralSize, centralOffset);

    const entries: ZipEntry[] = [];
    let offset = 0;
    for (let i = 0; i < entryCount; i++) {
      if (readUInt32LE(central, offset) !== CENTRAL_SIGNATURE) {
        throw new Error('Invalid ZIP central directory entry.');
      }
      const compressionMethod = readUInt16LE(central, offset + 10);
      let crc32 = readUInt32LE(central, offset + 16);
      let compressedSize = readUInt32LE(central, offset + 20);
      let uncompressedSize = readUInt32LE(central, offset + 24);
      const nameLen = readUInt16LE(central, offset + 28);
      const extraLen = readUInt16LE(central, offset + 30);
      const commentLen = readUInt16LE(central, offset + 32);
      const name = central.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
      const extra = central.subarray(
        offset + 46 + nameLen,
        offset + 46 + nameLen + extraLen,
      );

      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
        let extraOffset = 0;
        while (extraOffset + 4 <= extra.length) {
          const headerId = extra.readUInt16LE(extraOffset);
          const dataSize = extra.readUInt16LE(extraOffset + 2);
          if (headerId === 0x0001) {
            let fieldOffset = extraOffset + 4;
            if (uncompressedSize === 0xffffffff && fieldOffset + 8 <= extraOffset + 4 + dataSize) {
              uncompressedSize = Number(extra.readBigUInt64LE(fieldOffset));
              fieldOffset += 8;
            }
            if (compressedSize === 0xffffffff && fieldOffset + 8 <= extraOffset + 4 + dataSize) {
              compressedSize = Number(extra.readBigUInt64LE(fieldOffset));
            }
            break;
          }
          extraOffset += 4 + dataSize;
        }
      }

      entries.push({
        name,
        compressedSize,
        uncompressedSize,
        compressionMethod,
        crc32,
      });
      offset += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    closeSync(fd);
  }
}

export function sumEntries(
  entries: ZipEntry[],
  predicate: (entry: ZipEntry) => boolean,
): { compressed: number; uncompressed: number; count: number } {
  let compressed = 0;
  let uncompressed = 0;
  let count = 0;
  for (const entry of entries) {
    if (!predicate(entry)) continue;
    compressed += entry.compressedSize;
    uncompressed += entry.uncompressedSize;
    count += 1;
  }
  return { compressed, uncompressed, count };
}

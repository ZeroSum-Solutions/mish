import { open } from 'node:fs/promises';
import path from 'node:path';

/** Reserve the destination with O_EXCL before consuming any input bytes.
 * EEXIST includes dangling symlinks and names reserved by another request. */
export async function openUniqueUploadFile(
  uploadDir: string,
  safeName: string,
  reserved: Set<string>,
  assertCurrent: () => void,
) {
  const parsed = path.parse(safeName);
  const base = parsed.name || parsed.base || 'file';
  const ext = parsed.ext || '';
  for (let index = 0; index < 10_000; index += 1) {
    const filename = index === 0 ? safeName : `${base}-${index}${ext}`;
    if (reserved.has(filename)) continue;
    const destination = path.join(uploadDir, filename);
    assertCurrent();
    try {
      const handle = await open(destination, 'wx');
      reserved.add(filename);
      return { handle, filename, destination };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error('Upload filename collision limit reached');
}

/** Browser-side image helpers for workbench captures. They never upload; callers send the result to the daemon. */

export interface CaptureRegion { x: number; y: number; width: number; height: number }

/** Pixel size of an image blob. */
export async function readImageFrame(blob: Blob): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob);
    try { return { width: bitmap.width, height: bitmap.height }; } finally { bitmap.close(); }
  }
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('The image could not be read')); image.src = url; });
    return { width: image.naturalWidth, height: image.naturalHeight };
  } finally { URL.revokeObjectURL(url); }
}

/** Crop to a frame-pixel region and encode as PNG. */
export async function cropImage(blob: Blob, region: CaptureRegion): Promise<Blob> {
  const bitmap = await createImageBitmap(blob, region.x, region.y, region.width, region.height);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = region.width; canvas.height = region.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is unavailable');
    context.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(result => (result ? resolve(result) : reject(new Error('The region could not be encoded'))), 'image/png'));
  } finally { bitmap.close(); }
}

export function displayCaptureSupported(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';
}

/**
 * One frame of a screen, window or tab the user picks in the browser's own
 * permission prompt. The stream stops as soon as the frame is drawn; a denial
 * rejects with the browser's NotAllowedError.
 */
export async function grabDisplayFrame(): Promise<{ blob: Blob; width: number; height: number }> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  try {
    const video = document.createElement('video');
    video.muted = true; video.srcObject = stream;
    await video.play();
    const width = video.videoWidth, height = video.videoHeight;
    if (!width || !height) throw new Error('The shared screen produced no frame');
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    canvas.getContext('2d')?.drawImage(video, 0, 0, width, height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(result => (result ? resolve(result) : reject(new Error('The frame could not be encoded'))), 'image/png'));
    return { blob, width, height };
  } finally { for (const track of stream.getTracks()) track.stop(); }
}

/** Decode a data: URL into a Blob without re-encoding. */
export function dataUrlToBlob(dataUrl: string): Blob {
  const [header, payload = ''] = dataUrl.split(',', 2);
  const mime = /^data:([^;,]+)/u.exec(header ?? '')?.[1] ?? 'image/png';
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** True when the region lies inside the frame with positive size. */
export function regionInside(region: CaptureRegion, frame: { width: number; height: number }): boolean {
  return [region.x, region.y, region.width, region.height].every(Number.isInteger)
    && region.x >= 0 && region.y >= 0 && region.width >= 1 && region.height >= 1
    && region.x + region.width <= frame.width && region.y + region.height <= frame.height;
}

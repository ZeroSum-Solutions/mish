export interface ProviderImageContext {
  wireModel: string;
  prompt: string;
  aspect?: string | undefined;
  quality?: string | undefined;
  resolution?: string | undefined;
  imageRefs: ReadonlyArray<{ mime: string; dataUrl: string; abs?: string | undefined }>;
  requestInit?: Pick<RequestInit, 'dispatcher'> | undefined;
}

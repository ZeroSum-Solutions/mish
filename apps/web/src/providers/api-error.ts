export async function readApiErrorBody(resp: Response): Promise<{ message: string; code?: string }> {
  try {
    const json = (await resp.json()) as { error?: { code?: string; message?: string } | string; message?: string; code?: string };
    const message = typeof json.error === 'string' ? json.error : json.error?.message ?? json.message;
    return {
      message: typeof message === 'string' && message.length > 0 ? message : `Request failed (${resp.status}).`,
      ...(typeof json.error === 'object' && typeof json.error?.code === 'string' ? { code: json.error.code } : typeof json.code === 'string' ? { code: json.code } : {}),
    };
  } catch {
    return { message: `Request failed (${resp.status}).` };
  }
}

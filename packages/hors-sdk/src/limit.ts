export class BodyLimitError extends Error {
  readonly maxBytes: number;
  constructor(maxBytes: number) {
    super(`request body exceeds ${maxBytes} bytes`);
    this.name = "BodyLimitError";
    this.maxBytes = maxBytes;
  }
}

export function concat(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Read a byte stream, cancelling as soon as `maxBytes` is exceeded. */
export async function readStreamCapped(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const bytes = value ?? new Uint8Array();
      size += bytes.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new BodyLimitError(maxBytes);
      }
      chunks.push(bytes);
    }
  } catch (error) {
    if (!(error instanceof BodyLimitError)) {
      try {
        await reader.cancel();
      } catch {
        // already closed or cancelled
      }
    }
    throw error;
  }
  return concat(chunks, size);
}

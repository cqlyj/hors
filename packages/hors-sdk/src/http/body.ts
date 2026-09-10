import { BodyLimitError, concat, readStreamCapped } from "../limit.js";

export { BodyLimitError };

export async function readWebBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const length = request.headers.get("content-length");
  if (length !== null && Number(length) > maxBytes) {
    throw new BodyLimitError(maxBytes);
  }
  if (request.body === null) {
    return new Uint8Array();
  }
  if (typeof request.body.getReader === "function") {
    return readStreamCapped(request.body, maxBytes);
  }
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    throw new BodyLimitError(maxBytes);
  }
  return new Uint8Array(buffer);
}

export async function readNodeBody(
  source: AsyncIterable<Uint8Array | Buffer | string>,
  maxBytes: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of source) {
    const bytes =
      typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
    size += bytes.byteLength;
    if (size > maxBytes) {
      throw new BodyLimitError(maxBytes);
    }
    chunks.push(bytes);
  }
  return concat(chunks, size);
}

export function parseJsonArgs(bytes: Uint8Array, contentType: string | null): unknown {
  const media = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (media !== "application/json" && !media.endsWith("+json")) {
    return undefined;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

import { ZodError } from "zod";

export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function errorResponse(error: unknown): Response {
  if (error instanceof AppError)
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  if (error instanceof ZodError)
    return Response.json(
      {
        error: {
          code: "invalid_request",
          message: error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
        },
      },
      { status: 400 },
    );
  if (error instanceof SyntaxError)
    return Response.json(
      {
        error: { code: "invalid_json", message: "Provide a valid JSON body." },
      },
      { status: 400 },
    );
  console.error(
    "Astropath request failed",
    error instanceof Error ? error.message : "Unknown error",
  );
  return Response.json(
    {
      error: {
        code: "internal_error",
        message: "The request could not be completed.",
      },
    },
    { status: 500 },
  );
}

export async function jsonBody(
  request: Request,
  maxBytes = 3000000,
): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader)
    throw new AppError(400, "missing_body", "A JSON body is required.");
  let size = 0;
  const parts: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new AppError(
        413,
        "body_too_large",
        "Use a direct upload for large files.",
      );
    }
    parts.push(value);
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8"));
}

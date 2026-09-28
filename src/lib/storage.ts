import * as blob from "@vercel/blob";
import {
  S3Client,
  S3ServiceException,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface StoredFile {
  pathname: string;
  size: number;
  contentType: string;
}

export function storageProvider() {
  const provider = process.env.STORAGE_PROVIDER || "vercel";
  if (provider !== "vercel" && provider !== "r2")
    throw new Error("STORAGE_PROVIDER must be vercel or r2.");
  return provider;
}

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

let client: S3Client | undefined;
export function r2Client() {
  return (client ??= new S3Client({
    region: "auto",
    endpoint: `https://${required("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: required("R2_ACCESS_KEY_ID"),
      secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  }));
}

export function r2Object(pathname: string) {
  const prefix = process.env.R2_KEY_PREFIX?.replace(/^\/+|\/+$/g, "");
  return {
    Bucket: required("R2_BUCKET"),
    Key: prefix ? `${prefix}/${pathname}` : pathname,
  };
}

export function missingObject(error: unknown) {
  return (
    error instanceof S3ServiceException &&
    error.$metadata.httpStatusCode === 404
  );
}

export async function signedUpload(file: StoredFile, validUntil: number) {
  if (storageProvider() === "r2") {
    const url = await getSignedUrl(
      r2Client(),
      new PutObjectCommand({
        ...r2Object(file.pathname),
        ContentType: file.contentType,
        ContentLength: file.size,
        IfNoneMatch: "*",
      }),
      {
        expiresIn: Math.max(1, Math.floor((validUntil - Date.now()) / 1000)),
        // These restrictions must be in the signature, not merely suggested headers.
        signableHeaders: new Set([
          "content-type",
          "content-length",
          "if-none-match",
        ]),
      },
    );
    return {
      url,
      headers: {
        "Content-Type": file.contentType,
        "Content-Length": String(file.size),
        "If-None-Match": "*",
      } as Record<string, string>,
    };
  }
  const constraints = {
    pathname: file.pathname,
    maximumSizeInBytes: file.size,
    allowedContentTypes: [file.contentType],
    validUntil,
  };
  const signed = await blob.issueSignedToken({
    ...constraints,
    operations: ["put"],
  });
  const { presignedUrl } = await blob.presignUrl(signed, {
    ...constraints,
    operation: "put",
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: false,
  });
  return { url: presignedUrl, headers: { "Content-Type": file.contentType } };
}

export async function headFile(pathname: string): Promise<StoredFile> {
  if (storageProvider() === "r2") {
    try {
      const result = await r2Client().send(
        new HeadObjectCommand(r2Object(pathname)),
      );
      return {
        pathname,
        size: result.ContentLength!,
        contentType: result.ContentType!,
      };
    } catch (error) {
      if (!missingObject(error) || !process.env.BLOB_READ_WRITE_TOKEN)
        throw error;
    }
  }
  return blob.head(pathname);
}

export async function putFile(file: StoredFile, bytes: Uint8Array) {
  if (storageProvider() === "r2") {
    await r2Client().send(
      new PutObjectCommand({
        ...r2Object(file.pathname),
        Body: bytes,
        ContentType: file.contentType,
        ContentLength: file.size,
        IfNoneMatch: "*",
      }),
    );
  } else {
    await blob.put(file.pathname, Buffer.from(bytes), {
      access: "private",
      contentType: file.contentType,
      addRandomSuffix: false,
      allowOverwrite: false,
    });
  }
}

export async function signedDownload(pathname: string, validUntil: number) {
  if (storageProvider() === "r2") {
    try {
      // During a migration, old in-flight uploads can still finish in Blob.
      // Only a missing R2 object permits the explicit legacy fallback.
      if (process.env.BLOB_READ_WRITE_TOKEN)
        await r2Client().send(new HeadObjectCommand(r2Object(pathname)));
      return await getSignedUrl(
        r2Client(),
        new GetObjectCommand(r2Object(pathname)),
        {
          expiresIn: Math.max(1, Math.floor((validUntil - Date.now()) / 1000)),
        },
      );
    } catch (error) {
      if (!missingObject(error) || !process.env.BLOB_READ_WRITE_TOKEN)
        throw error;
    }
  }
  const signed = await blob.issueSignedToken({
    pathname,
    operations: ["get"],
    validUntil,
  });
  return (
    await blob.presignUrl(signed, {
      pathname,
      operation: "get",
      access: "private",
    })
  ).presignedUrl;
}

export async function readFileBytes(pathname: string) {
  if (storageProvider() === "r2") {
    try {
      const result = await r2Client().send(
        new GetObjectCommand(r2Object(pathname)),
      );
      return result.Body
        ? Buffer.from(await result.Body.transformToByteArray())
        : null;
    } catch (error) {
      if (!missingObject(error) || !process.env.BLOB_READ_WRITE_TOKEN)
        throw error;
    }
  }
  const result = await blob.get(pathname, { access: "private" });
  if (!result || result.statusCode !== 200 || !result.stream) return null;
  return Buffer.from(await new Response(result.stream).arrayBuffer());
}

// Used only by explicit maintenance/test scripts; no public deletion endpoint.
export async function deleteFile(pathname: string) {
  if (storageProvider() === "r2")
    await r2Client().send(new DeleteObjectCommand(r2Object(pathname)));
  else await blob.del(pathname);
}

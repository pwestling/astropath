"use client";

import { useEffect, useState } from "react";
import { Copy, ExternalLink, FileText, Upload } from "lucide-react";
import { api, bytes, relative } from "./api";
import type { PublicFile } from "@/lib/public-files";

type Ticket = {
  name: string;
  upload_url: string;
  headers: Record<string, string>;
};
type FilePage = { files: PublicFile[]; next_before: string | null };

export function PublicFilesPanel({
  spaces,
}: {
  spaces: { slug: string; name: string }[];
}) {
  const [config, setConfig] = useState<{
    enabled: boolean;
    max_size: number;
  } | null>(null);
  const [space, setSpace] = useState(spaces[0]?.slug || "general");
  const [file, setFile] = useState<File | null>(null);
  const [listing, setListing] = useState<FilePage | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  useEffect(() => {
    let active = true;
    api<{ enabled: boolean; max_size: number }>("public-files/config")
      .then((value) => {
        if (active) setConfig(value);
      })
      .catch(() => {
        if (active) setError("Unable to check public upload availability.");
      });
    loadFiles().catch(() => {
      if (active) setError("Unable to load public files.");
    });
    return () => {
      active = false;
    };
  }, []);

  async function loadFiles(before?: string) {
    const params = new URLSearchParams({ limit: "30" });
    if (before) params.set("before", before);
    const page = await api<FilePage>(`public-files?${params}`);
    setListing((previous) =>
      before && previous
        ? {
            files: [...previous.files, ...page.files],
            next_before: page.next_before,
          }
        : page,
    );
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
    } catch {
      setError("Open the file and copy its address manually.");
    }
  }

  async function upload() {
    if (!file || busy) return;
    setBusy(true);
    setError("");
    setProgress(0);
    try {
      const ticket = await api<Ticket>("public-files/uploads", {
        method: "POST",
        body: JSON.stringify({
          name: file.name,
          size: file.size,
          content_type: file.type || "application/octet-stream",
          space,
        }),
      });
      await new Promise<void>((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open("PUT", ticket.upload_url);
        // Browser supplies Content-Length from the File, and no app credentials.
        for (const [key, value] of Object.entries(ticket.headers))
          if (key.toLowerCase() !== "content-length")
            request.setRequestHeader(key, value);
        request.upload.onprogress = (event) => {
          if (event.lengthComputable)
            setProgress(Math.round((event.loaded / event.total) * 100));
        };
        request.onload = () =>
          request.status >= 200 && request.status < 300
            ? resolve()
            : reject(
                new Error(
                  "File storage did not accept the upload. Please try again.",
                ),
              );
        request.onerror = () =>
          reject(
            new Error(
              "Upload interrupted. Check your connection and try again.",
            ),
          );
        request.send(file);
      });
      setFile(null);
      setCopied("");
      // The listing confirms the finished upload against the bucket.
      await loadFiles();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="public-files-panel">
      <section className="surface settings-card">
        <h2>Upload a public file</h2>
        <p>
          Anyone with the link can download the original file. The link works
          without Astropath and does not expire.
        </p>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        {config && !config.enabled ? (
          <p>Public uploads have not been configured on this instance.</p>
        ) : (
          <>
            {spaces.length > 1 && (
              <label>
                Space
                <select
                  value={space}
                  disabled={busy}
                  onChange={(event) => setSpace(event.target.value)}
                >
                  {spaces.map((item) => (
                    <option key={item.slug} value={item.slug}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="upload-zone">
              <Upload size={24} />
              <span>
                <strong>{file ? file.name : "Choose a file to publish"}</strong>
                <small>Up to 4 GiB · Public download</small>
              </span>
              <input
                key={file ? "chosen" : "empty"}
                type="file"
                disabled={busy || !config?.enabled}
                onChange={(event) => {
                  const selected = event.target.files?.[0];
                  setError("");
                  if (
                    selected &&
                    (selected.size === 0 ||
                      selected.size > (config?.max_size || 0))
                  ) {
                    setError("Choose a nonempty file up to 4 GiB.");
                    setFile(null);
                  } else setFile(selected || null);
                }}
              />
            </label>
            <button
              className="button primary"
              disabled={!file || busy || !config?.enabled}
              onClick={upload}
            >
              <Upload size={16} />
              {busy ? `Uploading ${progress}%` : "Upload publicly"}
            </button>
            {busy && (
              <progress
                aria-label="Public upload progress"
                value={progress}
                max={100}
              />
            )}
          </>
        )}
      </section>
      <section className="surface settings-card">
        <div className="public-files-heading">
          <h2>Public files</h2>
          {listing && listing.files.length > 0 && (
            <small>
              {listing.files.length}
              {listing.next_before ? "+" : ""}{" "}
              {listing.files.length === 1 ? "file" : "files"}
            </small>
          )}
        </div>
        {!listing ? (
          <p className="small" role="status">
            Loading public files…
          </p>
        ) : listing.files.length ? (
          <ul className="public-file-list">
            {listing.files.map((item) => (
              <li className="public-file-row" key={item.id}>
                <FileText size={18} />
                <div>
                  <a
                    href={item.public_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {item.name}
                  </a>
                  <small>
                    {bytes(item.size)} · {item.uploaded_by} ·{" "}
                    <time dateTime={item.created_at} title={item.created_at}>
                      {relative(item.created_at)}
                    </time>
                    {spaces.length > 1 && <> · {item.space}</>}
                  </small>
                </div>
                <div className="public-file-actions">
                  <button
                    className="button small-button"
                    onClick={() => copy(item.public_url)}
                  >
                    <Copy size={14} />
                    {copied === item.public_url ? "Copied" : "Copy link"}
                  </button>
                  <a
                    className="button small-button"
                    href={item.public_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Open ${item.name}`}
                  >
                    <ExternalLink size={14} />
                    Open
                  </a>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p>
            No public files yet. Files you or your agents publish appear here.
          </p>
        )}
        {listing?.next_before && (
          <button
            className="button"
            disabled={loadingMore}
            onClick={async () => {
              setLoadingMore(true);
              try {
                await loadFiles(listing.next_before!);
              } catch {
                setError("Unable to load more public files.");
              } finally {
                setLoadingMore(false);
              }
            }}
          >
            Load more
          </button>
        )}
      </section>
    </div>
  );
}

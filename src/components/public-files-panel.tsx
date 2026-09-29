"use client";

import { useEffect, useState } from "react";
import { Copy, ExternalLink, Upload } from "lucide-react";
import { api, bytes } from "./api";

type Uploaded = { name: string; public_url: string; size: number };

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
  const [results, setResults] = useState<Uploaded[]>([]);
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
    return () => {
      active = false;
    };
  }, []);

  async function upload() {
    if (!file || busy) return;
    setBusy(true);
    setError("");
    setProgress(0);
    try {
      const ticket = await api<
        Uploaded & { upload_url: string; headers: Record<string, string> }
      >("public-files/uploads", {
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
                new Error("R2 did not accept the upload. Please try again."),
              );
        request.onerror = () =>
          reject(
            new Error(
              "Upload interrupted. Check your connection and try again.",
            ),
          );
        request.send(file);
      });
      setResults((previous) => [
        { name: ticket.name, size: ticket.size, public_url: ticket.public_url },
        ...previous,
      ]);
      setFile(null);
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
          Anyone with the link can download the original file directly from R2.
          The link works without Astropath and does not expire.
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
            <label>
              Workspace space
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
      {results.length > 0 && (
        <section className="surface settings-card">
          <h2>Uploaded in this visit</h2>
          <p>Copy these links to keep or share them.</p>
          {results.map((item) => (
            <div className="public-file-result" key={item.public_url}>
              <strong>{item.name}</strong>
              <small>{bytes(item.size)}</small>
              <input
                aria-label={`Public URL for ${item.name}`}
                readOnly
                value={item.public_url}
                onFocus={(event) => event.target.select()}
              />
              <div className="public-file-actions">
                <button
                  className="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(item.public_url);
                      setCopied(item.public_url);
                    } catch {
                      setError("Select the URL and copy it manually.");
                    }
                  }}
                >
                  <Copy size={16} />
                  {copied === item.public_url ? "Copied" : "Copy URL"}
                </button>
                <a
                  className="button"
                  href={item.public_url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink size={16} />
                  Download
                </a>
              </div>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

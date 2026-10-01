# Public R2 uploads

Public uploads send original bytes to a dedicated public R2 bucket. Downloads go
straight to the bucket's public hostname, with no Astropath authentication or
proxy. Users choose **Public files → Upload publicly** and copy the URL after the
upload finishes. Existing private attachments retain their encrypted storage path.

## Configure the bucket

1. Create a **new, separate bucket**. Do not enable public access on the existing
   private attachment or database-backup bucket.
2. Connect a custom domain in R2 and enable public access. Use the resulting HTTPS
   origin as `R2_PUBLIC_BASE_URL`; no path or query string. Cloudflare's managed
   `r2.dev` origin also works, but is rate-limited and intended for development.
3. Create an Object Read & Write R2 token restricted to this public bucket. Store
   these server-only values in the deployment's secret manager:

   ```dotenv
   R2_PUBLIC_ACCOUNT_ID=your-account-id
   R2_PUBLIC_BUCKET=your-public-bucket
   R2_PUBLIC_BASE_URL=https://files.example.com
   R2_PUBLIC_ACCESS_KEY_ID=your-public-bucket-access-key
   R2_PUBLIC_SECRET_ACCESS_KEY=your-public-bucket-secret-key
   ```

4. Configure bucket CORS. Replace the example upload origin with the app's exact
   `APP_URL`. Add development origins explicitly only when required. This example
   uses the Cloudflare REST API format:

   ```json
   {
     "rules": [
       {
         "id": "App uploads",
         "allowed": {
           "origins": ["https://astropath.example.com"],
           "methods": ["PUT"],
           "headers": ["content-type", "content-length", "content-disposition", "if-none-match"]
         },
         "exposeHeaders": ["ETag"],
         "maxAgeSeconds": 3600
       },
       {
         "id": "Public downloads",
         "allowed": { "origins": ["*"], "methods": ["GET", "HEAD"] },
         "exposeHeaders": ["Content-Length", "Content-Type", "ETag"]
       }
     ]
   }
   ```

5. Deploy/restart the app with the new environment. There is no database migration.
   Authenticated `GET /api/v1/public-files/config` reports availability. All five
   settings are required, even when private uploads use Vercel Blob. The server
   rejects the private bucket as a destination and never falls back to its keys.

The custom download domain should serve this public bucket directly from R2.
The S3 API endpoint is for signed uploads; it is not the public download URL.
Public uploads use random object keys and an attachment Content-Disposition. The
original filename is included in the public URL. A new permission request allocates
another key; there is no overwrite or private-to-public conversion operation.

## Upload from an agent or HTTP client

Call MCP `create_public_upload`, or send:

```http
POST /api/v1/public-files/uploads
Authorization: Bearer YOUR_ASTROPATH_TOKEN
Content-Type: application/json

{"name":"model.stl","content_type":"application/octet-stream","size":1234,"space":"general"}
```

The response contains `upload_url`, `method`, `headers`, `expires_at`, `public_url`,
`name`, `size`, and `visibility: "public"`. It grants a create-only PUT lasting one
hour, with the exact size, MIME type, and attachment disposition bound to the
signature. Send the original bytes and **all returned headers** to `upload_url`.
Do not include the Astropath bearer token. Browsers set Content-Length from the
File automatically and must not set that forbidden header manually. Files may be
up to 4 GiB; this flow uses a single PUT, not multipart uploads.

Only after a successful PUT should the agent report the file as published and
return `public_url`. There is no completion call. The public URL has no signature
or expiration and stays usable while the object and public domain exist.

## Listing

Each upload is recorded in `ap_public_files` when its upload URL is issued,
scoped to the workspace and space, with its name, type and URL encrypted like
other content. `GET /api/v1/public-files` (read scope), the
`list_public_files` MCP tool, and the **Public files** page list completed
uploads newest first. The public bucket is shared by every workspace on an
installation, so the list comes from these records, never from listing the
bucket.

Because uploads go straight to R2, the server confirms a pending record the
first time it is listed: a HEAD request must find the object at its exact size.
Records whose upload URL expired with no object are marked abandoned and drop out.

Objects published before uploads were recorded can be imported once by an
operator. `npm run public-files:import -- TENANT_ID SPACE` assigns every object
under `uploads/` that has no record to that workspace and space; run it with the
same environment as the app. It is repeatable: existing records are skipped.

Astropath authenticates the creation of upload permissions and enforces write
scope plus current tenant/space membership. R2 then honors that permission for its
remaining lifetime, even if the Astropath connection is revoked. Uploaded objects
remain public until removed or access is disabled in R2. Consider cache retention
when retracting published content. No automatic expiry or deletion is configured.

## Verify

Upload a small synthetic file. Confirm the direct R2 upload accepts the required
headers, rejects a changed MIME type or size, and rejects a second PUT to the same
key. Download `public_url` without cookies or Authorization and compare exact bytes.
Test browser preflight from the actual app origin as well as browser upload and
Copy URL. Verify private attachment uploads still use their existing private path.
`npm test` covers permission checks, configuration failures, filename validation,
signed headers, large-file limits, and HTTP/MCP discovery.

References: [R2 public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/),
[presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/),
[CORS](https://developers.cloudflare.com/r2/buckets/cors/), and
[R2 limits](https://developers.cloudflare.com/r2/platform/limits/).

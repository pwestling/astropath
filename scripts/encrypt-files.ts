import { systemDb, pool } from "../src/lib/db";
import {
  contentCipher,
  unwrapTenantKey,
  masterKey,
} from "../src/lib/encryption";
import { putFile, readFileBytes } from "../src/lib/storage";

// Run with writers stopped, after db:migrate. Originals are retained for rollback.
async function main() {
  masterKey();
  await systemDb.query(`CREATE TABLE IF NOT EXISTS ap_legacy_file_objects (
    file_id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES ap_tenants(id),encrypted_path text NOT NULL)`);
  const files = (
    await systemDb.query<{
      id: string;
      tenant_id: string;
      pathname: string;
      size: string;
      status: string;
      wrapped_key: string;
    }>(
      `SELECT f.id,f.tenant_id,f.pathname,f.size,f.status,t.wrapped_key FROM ap_files f
     JOIN ap_tenants t ON t.id=f.tenant_id WHERE NOT f.encrypted ORDER BY f.created_at`,
    )
  ).rows;
  let count = 0;
  for (const file of files) {
    const cipher = contentCipher(
      file.tenant_id,
      unwrapTenantKey(file.tenant_id, file.wrapped_key),
    );
    const pathname = `encrypted/${file.tenant_id}/${file.id}`;
    let original: Buffer | null = null;
    try {
      original = await readFileBytes(file.pathname);
    } catch (error) {
      if (file.status === "ready") throw error;
    }
    if (!original && file.status === "ready")
      throw new Error(`Missing ready file ${file.id}`);
    if (original) {
      if (original.length !== Number(file.size))
        throw new Error(`File size mismatch ${file.id}`);
      const encrypted = cipher.encryptBytes(`file:${file.id}`, original);
      try {
        await putFile(
          {
            pathname,
            size: encrypted.length,
            contentType: "application/octet-stream",
          },
          encrypted,
        );
      } catch (error) {
        const existing = await readFileBytes(pathname);
        if (
          !existing ||
          !cipher.decryptBytes(`file:${file.id}`, existing).equals(original)
        )
          throw error;
      }
      const verify = await readFileBytes(pathname);
      if (
        !verify ||
        !cipher.decryptBytes(`file:${file.id}`, verify).equals(original)
      )
        throw new Error(`File verification failed ${file.id}`);
    }
    await systemDb.transaction(async (tx) => {
      await tx.query(
        "INSERT INTO ap_legacy_file_objects(file_id,tenant_id,encrypted_path) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [
          file.id,
          file.tenant_id,
          cipher.encrypt(`legacy-file:${file.id}`, file.pathname),
        ],
      );
      await tx.query(
        "UPDATE ap_files SET pathname=$2,encrypted=true WHERE id=$1 AND NOT encrypted",
        [file.id, pathname],
      );
    });
    count++;
  }
  console.log(
    `Encrypted and verified ${count} files. Original objects are retained for rollback; see docs/tenant-migration.md.`,
  );
}
main()
  .finally(() => pool.end())
  .catch(() => {
    console.error(
      "File encryption migration failed; originals are retained. Rerun after resolving storage access.",
    );
    process.exitCode = 1;
  });

import { createAuth } from "../src/lib/auth";
import { pool } from "../src/lib/db";
import { ownerEmail } from "../src/lib/config";
import { randomUUID } from "node:crypto";
import { INITIAL_TENANT } from "../src/lib/tenant-migration";

async function main() {
  const email = ownerEmail();
  const password = process.env.OWNER_PASSWORD;
  if (!email || !password || password.length < 12)
    throw new Error(
      "Set OWNER_EMAIL and OWNER_PASSWORD (at least 12 characters).",
    );
  const existing = await pool.query('SELECT id FROM "user" LIMIT 1');
  if (existing.rows.length)
    throw new Error(
      "An owner already exists. Use the authenticated password-change flow.",
    );
  const result = await createAuth(true).api.signUpEmail({
    body: {
      email,
      password,
      name: process.env.OWNER_NAME?.trim() || "Owner",
    },
  });
  await pool.query(
    `INSERT INTO ap_members(id,tenant_id,email,name,user_id,spaces,role)
    VALUES($1,$2,$3,$4,$5,ARRAY['general'],'owner')`,
    [randomUUID(), INITIAL_TENANT, email, result.user.name, result.user.id],
  );
  console.log(
    "Owner account created. Remove OWNER_PASSWORD from the environment.",
  );
}
main()
  .finally(() => pool.end())
  .catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });

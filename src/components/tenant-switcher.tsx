"use client";
import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { api } from "./api";

type Tenant = {
  id: string;
  name: string;
  role: string;
  disabled_at?: string | null;
  members?: number;
};
export function TenantSwitcher() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [active, setActive] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<{ tenants: Tenant[]; active_tenant_id: string | null }>("tenants")
      .then((data) => {
        setTenants(data.tenants);
        setActive(data.active_tenant_id ?? "");
      })
      .catch((error) => setError(error.message));
  }, []);
  async function select(id: string) {
    setBusy(true);
    setError("");
    try {
      await api("tenants/select", {
        method: "POST",
        body: JSON.stringify({ tenant_id: id }),
      });
      window.location.assign("/");
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to switch workspace.",
      );
      setBusy(false);
    }
  }
  async function create() {
    const name = window.prompt("Name your new workspace");
    if (!name?.trim()) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ tenant: Tenant }>("tenants", {
        method: "POST",
        body: JSON.stringify({ name: name.trim() }),
      });
      await select(result.tenant.id);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to create workspace.",
      );
      setBusy(false);
    }
  }
  return (
    <div className="tenant-switcher">
      <span className="nav-label" id="tenant-switcher-label">
        WORKSPACE
      </span>
      <div className="tenant-switcher-row">
        <select
          aria-labelledby="tenant-switcher-label"
          value={active}
          disabled={busy}
          onChange={(event) => void select(event.target.value)}
        >
          {!active && <option value="">Choose a workspace</option>}
          {tenants.map((tenant) => (
            <option key={tenant.id} value={tenant.id}>
              {tenant.name}
            </option>
          ))}
        </select>
        <button
          className="icon-button"
          title="New workspace"
          aria-label="New workspace"
          disabled={busy}
          onClick={() => void create()}
        >
          <Plus size={16} />
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function PlatformTenants() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [admin, setAdmin] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void api<{ platform_admin: boolean }>("tenants")
      .then(async (data) => {
        setAdmin(data.platform_admin);
        if (data.platform_admin)
          setTenants(
            (await api<{ tenants: Tenant[] }>("admin/tenants")).tenants,
          );
      })
      .catch((error) => setError(error.message));
  }, []);
  async function toggle(tenant: Tenant) {
    try {
      await api(`admin/tenants/${tenant.id}`, {
        method: "PATCH",
        body: JSON.stringify({ disabled: !tenant.disabled_at }),
      });
      setTenants((await api<{ tenants: Tenant[] }>("admin/tenants")).tenants);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to update tenant.",
      );
    }
  }
  if (!admin) return null;
  return (
    <section className="settings-card">
      <h2>All workspaces</h2>
      <p>Enable or disable workspaces across this installation.</p>
      {tenants.map((tenant) => (
        <div key={tenant.id} className="button-row">
          <strong>{tenant.name}</strong>
          <span>{tenant.members} members</span>
          <button className="button" onClick={() => void toggle(tenant)}>
            {tenant.disabled_at ? "Enable" : "Disable"}
          </button>
        </div>
      ))}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

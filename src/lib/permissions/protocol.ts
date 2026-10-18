// Vendored from Custodes (github.com/pwestling/custodes) src/permissions/protocol.ts at efd1b46, permission adapter contract version 1.
// Keep in step with that revision rather than editing here; local changes are marked 'Astropath:'.
import { z } from 'zod';

const key = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const label = z.string().min(1).max(200);
const identifier = z.string().min(1).max(256);
const option = z.strictObject({ id: identifier, label, description: z.string().max(1000).optional() });
const baseField = { id: key, label, description: z.string().max(1000).optional(), required: z.boolean() };
export const fieldSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...baseField, type: z.literal('text'), maxLength: z.number().int().min(1).max(2000) }),
  z.strictObject({ ...baseField, type: z.literal('boolean') }),
  z.strictObject({ ...baseField, type: z.literal('choice'), options: z.array(option).min(1).max(100) }),
  z.strictObject({ ...baseField, type: z.literal('choices'), options: z.array(option).min(1).max(100) }),
  z.strictObject({ ...baseField, type: z.literal('reference'), catalog: z.union([key, z.literal('$users')]) }),
  z.strictObject({ ...baseField, type: z.literal('references'), catalog: z.union([key, z.literal('$users')]) }),
]);
export const targetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('application') }),
  z.strictObject({ kind: z.literal('subject'), id: identifier }),
  z.strictObject({ kind: z.literal('entity'), catalog: key, id: identifier }),
]);
const actionTarget = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('application') }),
  z.strictObject({ kind: z.literal('subject') }),
  z.strictObject({ kind: z.literal('entity'), catalog: key }),
]);
export const manifestSchema = z.strictObject({
  protocolVersion: z.literal(1), appId: key, revision: identifier,
  catalogs: z.array(z.strictObject({ id: key, label, inspectable: z.boolean() })).max(30),
  actions: z.array(z.strictObject({
    id: key, label, description: z.string().max(1000).optional(), target: actionTarget,
    destructive: z.boolean(), fields: z.array(fieldSchema).max(20),
  })).max(50),
}).superRefine((manifest, ctx) => {
  const ids = new Set(manifest.catalogs.map(c => c.id));
  const unique = (values: string[]) => new Set(values).size === values.length;
  if (!unique(manifest.actions.map(a => a.id)) || !unique(manifest.catalogs.map(c => c.id))) {
    ctx.addIssue({ code: 'custom', message: 'Duplicate descriptor ids' });
  }
  for (const action of manifest.actions) {
    if (!unique(action.fields.map(f => f.id))) ctx.addIssue({ code: 'custom', message: 'Duplicate field ids' });
    if (action.target.kind === 'entity' && !ids.has(action.target.catalog)) ctx.addIssue({ code: 'custom', message: 'Unknown target catalog' });
    for (const field of action.fields) {
      if ('catalog' in field && field.catalog !== '$users' && !ids.has(field.catalog)) ctx.addIssue({ code: 'custom', message: 'Unknown field catalog' });
      if ('options' in field && !unique(field.options.map(o => o.id))) ctx.addIssue({ code: 'custom', message: 'Duplicate options' });
    }
  }
});
const valueSchema = z.union([z.string().max(2000), z.boolean(), z.array(identifier).max(100)]);
const valuesSchema = z.record(key, valueSchema).refine(v => Object.keys(v).length <= 20);
export const stateSchema = z.strictObject({
  target: targetSchema, version: identifier, title: label,
  facts: z.array(z.strictObject({ label, value: z.string().max(2000) })).max(50),
  access: z.array(z.strictObject({
    id: identifier, label, scope: z.string().max(500).optional(),
    origin: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('direct') }),
      z.strictObject({ kind: z.literal('inherited'), via: z.array(label).min(1).max(20) }),
    ]),
  })).max(500),
  actions: z.array(z.strictObject({ id: key, values: valuesSchema })).max(50),
});
export const catalogPageSchema = z.strictObject({ items: z.array(option).max(100), nextCursor: identifier.optional() });
export const changeSchema = z.strictObject({
  requestId: z.uuid(), schemaRevision: identifier, expectedVersion: identifier,
  target: targetSchema, actionId: key, values: valuesSchema,
});
export const resultSchema = z.strictObject({ requestId: z.uuid(), state: stateSchema });
export type Manifest = z.infer<typeof manifestSchema>;
export type Field = z.infer<typeof fieldSchema>;
export type Target = z.infer<typeof targetSchema>;
export type State = z.infer<typeof stateSchema>;
export type Change = z.infer<typeof changeSchema>;
export type CatalogPage = z.infer<typeof catalogPageSchema>;
export type ChangeResult = z.infer<typeof resultSchema>;

export class PermissionError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 502 | 503;
  readonly outcome: 'rejected' | 'unknown';
  constructor(message: string, status: PermissionError['status'], outcome: PermissionError['outcome'] = 'rejected') {
    super(message); this.status = status; this.outcome = outcome;
  }
}

export function matchesTarget(action: Manifest['actions'][number], target: Target) {
  return action.target.kind === target.kind && (action.target.kind !== 'entity' ||
    (target.kind === 'entity' && action.target.catalog === target.catalog));
}

export function validateChange(manifest: Manifest, change: Change) {
  if (manifest.revision !== change.schemaRevision) throw new PermissionError('Permission form changed. Reload before editing.', 409);
  const action = manifest.actions.find(a => a.id === change.actionId && matchesTarget(a, change.target));
  if (!action) throw new PermissionError('Unsupported permission operation', 422);
  if (Object.keys(change.values).some(id => !action.fields.some(f => f.id === id))) throw new PermissionError('Unknown input field', 422);
  for (const field of action.fields) {
    const value = change.values[field.id];
    if (value === undefined) {
      if (field.required) throw new PermissionError(`${field.label} is required`, 422);
      continue;
    }
    let valid = false;
    switch (field.type) {
      case 'text': valid = typeof value === 'string' && value.length <= field.maxLength && (!field.required || value.trim().length > 0); break;
      case 'boolean': valid = typeof value === 'boolean'; break;
      case 'choice': valid = typeof value === 'string' && field.options.some(o => o.id === value); break;
      case 'choices': valid = Array.isArray(value) && value.every(v => field.options.some(o => o.id === v)); break;
      case 'reference': valid = typeof value === 'string' && value.length > 0 && value.length <= 256; break;
      case 'references': valid = Array.isArray(value); break;
    }
    if (Array.isArray(value) && (new Set(value).size !== value.length || (field.required && value.length === 0))) valid = false;
    if (!valid) throw new PermissionError(`Invalid value for ${field.label}`, 422);
  }
  // Reference existence, assignment eligibility and business rules belong to the app.
}

export function validateState(manifest: Manifest, target: Target, input: unknown): State {
  const state = stateSchema.parse(input);
  if (canonical(state.target) !== canonical(target) || new Set(state.actions.map(a => a.id)).size !== state.actions.length) {
    throw new PermissionError('App returned an inconsistent permission view', 502);
  }
  for (const available of state.actions) {
    if (!manifest.actions.some(a => a.id === available.id && matchesTarget(a, target))) throw new PermissionError('App returned an unknown action', 502);
  }
  return state;
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}

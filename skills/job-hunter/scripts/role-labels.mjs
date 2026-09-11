import { ROLE_LABELS } from './role-taxonomy.mjs';
export const UNCLASSIFIED_ROLE_LABEL = 'Unclassified';
export const ROLE_LABEL_SET = new Set(ROLE_LABELS);
export const rawRoleLabel = (value) => String(value ?? '').trim();
const key = (value) => rawRoleLabel(value).toLowerCase().replace(/[-_\s]+/g, ' ');
const labels = new Map(ROLE_LABELS.map((label) => [key(label), label]));
// Historical free-form role titles need reclassification, not a guessed category.
export const canonicalRoleLabel = (value) => labels.get(key(value)) || UNCLASSIFIED_ROLE_LABEL;

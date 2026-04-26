const SAFE_SKILL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function sanitizeSkillName(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!SAFE_SKILL_NAME.test(trimmed)) return null;
  return trimmed;
}

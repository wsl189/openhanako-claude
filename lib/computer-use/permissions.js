export function normalizeOsPermissions(perms = {}) {
  const accessibility = perms?.accessibility === true;
  const screenRecording = perms?.screenRecording !== false;
  return {
    granted: accessibility && screenRecording,
    accessibility,
    screenRecording,
  };
}

import { describe, expect, it } from 'vitest';
import { resolveDeskLoadBaseDir } from './desk-actions';

describe('resolveDeskLoadBaseDir', () => {
  it('keeps the current draft workspace while browsing without a session', () => {
    expect(resolveDeskLoadBaseDir({
      deskBasePath: '/Users/tc/PythonProject/paper',
      selectedFolder: '/Users/tc/PythonProject/paper',
      homeFolder: '/Users/tc/Desktop',
    })).toBe('/Users/tc/PythonProject/paper');
  });

  it('does not override a real session workspace lookup', () => {
    expect(resolveDeskLoadBaseDir({
      sessionPath: '/tmp/session.json',
      deskBasePath: '/Users/tc/PythonProject/paper',
      selectedFolder: '/Users/tc/PythonProject/paper',
    })).toBeUndefined();
  });

  it('allows callers to clear the sticky draft workspace explicitly', () => {
    expect(resolveDeskLoadBaseDir({
      overrideDir: null,
      deskBasePath: '/Users/tc/PythonProject/paper',
      selectedFolder: '/Users/tc/PythonProject/paper',
      homeFolder: '/Users/tc/Desktop',
    })).toBeUndefined();
  });

  it('prefers an explicit override directory when provided', () => {
    expect(resolveDeskLoadBaseDir({
      overrideDir: '/Users/tc/Desktop',
      deskBasePath: '/Users/tc/PythonProject/paper',
      selectedFolder: '/Users/tc/PythonProject/paper',
    })).toBe('/Users/tc/Desktop');
  });
});

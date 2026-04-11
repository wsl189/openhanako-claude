import { describe, expect, it } from 'vitest';
import { extractToolDetail } from './message-parser';

describe('extractToolDetail', () => {
  it('extracts cmd from exec_command tool', () => {
    const detail = extractToolDetail('exec_command', {
      cmd: 'npm run test -- --watch=false',
    });
    expect(detail).toBe('npm run test -- --watch=false');
  });

  it('extracts first query from structured search_query payload', () => {
    const detail = extractToolDetail('web.run', {
      search_query: [{ q: 'latest openai api docs' }],
    });
    expect(detail).toBe('latest openai api docs');
  });

  it('falls back to generic path-like args for unknown tools', () => {
    const detail = extractToolDetail('unknown_tool', {
      path: '/Users/tc/PythonProject/openhanako/server/routes/chat.js',
    });
    expect(detail).toContain('chat.js');
  });

  it('falls back to url hostname for unknown tools', () => {
    const detail = extractToolDetail('unknown_tool', {
      url: 'https://example.com/docs?id=123',
    });
    expect(detail).toBe('example.com');
  });

  it('extracts task summary for claude_core tool', () => {
    const detail = extractToolDetail('claude_core', {
      task: 'Refactor the API layer and add retry logic',
      cwd: '/Users/tc/PythonProject/openhanako',
    });
    expect(detail).toContain('Refactor the API layer');
  });

  it('shows write line-count detail for Write tool', () => {
    const detail = extractToolDetail('Write', {
      file_path: '/Users/tc/Desktop/blog.html',
      content: '<h1>Hello</h1>\n<p>World</p>',
    });
    expect(detail).toContain('blog.html');
    expect(detail).toContain('+2');
  });

  it('shows edit +/- line stats for Edit tool', () => {
    const detail = extractToolDetail('Edit', {
      file_path: '/Users/tc/Desktop/blog.html',
      old_string: '<h1>Hello</h1>',
      new_string: '<h1>Hello, Hanako</h1>\n<p>Updated</p>',
    });
    expect(detail).toContain('blog.html');
    expect(detail).toContain('+2');
    expect(detail).toContain('-1');
  });
});

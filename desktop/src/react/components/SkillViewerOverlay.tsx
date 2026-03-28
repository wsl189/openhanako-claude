/**
 * SkillViewerOverlay.tsx — 技能详情窗口
 *
 * 文件树 + 可编辑文本 + 自动保存（切文件/关窗时会触发保存）
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useStore } from '../stores';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { useI18n } from '../hooks/use-i18n';
import { getMdWithOpts } from '../utils/markdown';

interface SkillInfo {
  name: string;
  baseDir: string;
  filePath?: string;
  installed?: boolean;
}

interface TreeItem {
  name: string;
  path?: string;
  isDir?: boolean;
  children?: TreeItem[];
}

type SaveState = 'saved' | 'saving' | 'unsaved' | 'error';
type ViewerMode = 'preview' | 'edit';
const md = getMdWithOpts({ html: true, linkify: true, breaks: true });

function isMarkdownFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return ext === 'md' || ext === 'markdown';
}

export function SkillViewerOverlay() {
  const { t } = useI18n();
  const data = useStore(s => s.skillViewerData) as SkillInfo | null;
  const [isDarwin, setIsDarwin] = useState<boolean>(() => (
    document.documentElement.getAttribute('data-platform') === 'darwin'
  ));
  const [files, setFiles] = useState<TreeItem[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Record<string, boolean>>({});
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [fileName, setFileName] = useState('SKILL.md');
  const [content, setContent] = useState<string | null>(null);
  const [mode, setMode] = useState<ViewerMode>('preview');
  const [isDirty, setIsDirty] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [toast, setToast] = useState<string | null>(null);

  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const contentRef = useRef<string | null>(null);
  const activeFileRef = useRef<string | null>(null);
  const activeBaseDirRef = useRef<string | null>(null);
  const isDirtyRef = useRef(false);
  const savingRef = useRef(false);

  useEffect(() => { contentRef.current = content; }, [content]);
  useEffect(() => { activeFileRef.current = activeFile; }, [activeFile]);
  useEffect(() => { isDirtyRef.current = isDirty; }, [isDirty]);

  const isMarkdown = isMarkdownFile(fileName);
  const markdownPreview = useMemo(() => {
    if (mode !== 'preview' || !isMarkdown || content == null) {
      return { html: '', description: '' };
    }
    let body = content;
    let description = '';
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
    if (fmMatch) {
      body = content.slice(fmMatch[0].length);
      description = parseFmDescription(fmMatch[1]);
    }
    return { html: md.render(body), description };
  }, [content, isMarkdown, mode]);

  function showToast(msg: string) {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  }

  const saveCurrentFile = useCallback(async (opts?: { silent?: boolean; force?: boolean }) => {
    const silent = !!opts?.silent;
    const force = !!opts?.force;
    if (savingRef.current) return true;
    const filePath = activeFileRef.current;
    const baseDir = activeBaseDirRef.current;
    const nextContent = contentRef.current;
    if (!filePath || !baseDir || nextContent == null) return true;
    if (!force && !isDirtyRef.current) return true;

    savingRef.current = true;
    setSaveState('saving');
    try {
      const platform = (window as any).platform || (window as any).hana;
      const ok = await platform?.writeSkillFile?.(baseDir, filePath, nextContent);
      if (!ok) throw new Error('write_failed');
      setIsDirty(false);
      setSaveState('saved');
      if (!silent) showToast(t('skillViewer.saved'));
      return true;
    } catch (e: any) {
      setSaveState('error');
      if (!silent) {
        const reason = e?.message && e.message !== 'write_failed' ? `: ${e.message}` : '';
        showToast(`${t('skillViewer.saveFailed')}${reason}`);
      }
      return false;
    } finally {
      savingRef.current = false;
    }
  }, [t]);

  const close = useCallback(async (opts?: { system?: boolean }) => {
    clearTimeout(autoSaveTimer.current);
    await saveCurrentFile({ silent: true, force: true });
    const platform = (window as any).platform || (window as any).hana;

    if (opts?.system) {
      await platform?.confirmSkillViewerClose?.();
      return;
    }

    useStore.setState({ skillViewerData: null });
    await platform?.closeSkillViewer?.();
  }, [saveCurrentFile]);

  // 加载文件树
  useEffect(() => {
    if (!data) return;
    (async () => {
      await saveCurrentFile({ silent: true, force: true });
      const hana = (window as any).hana;
      const items = await hana?.listSkillFiles?.(data.baseDir);
      setFiles(items || []);
      setExpandedDirs({});
      const initialPath = data.filePath || (data.baseDir + '/SKILL.md');
      const initialName = initialPath.split(/[\\/]/).pop() || 'SKILL.md';
      await loadFile(initialPath, initialName, data.baseDir);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.baseDir, data?.filePath]);

  useEffect(() => {
    const platform = (window as any).platform || (window as any).hana;
    (async () => {
      try {
        const plat = await platform?.getPlatform?.();
        if (plat) setIsDarwin(plat === 'darwin');
      } catch {
        // ignore
      }
    })();
  }, []);

  useEffect(() => {
    const platform = (window as any).platform || (window as any).hana;
    platform?.onSkillViewerBeforeClose?.(() => {
      void close({ system: true });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => {
    clearTimeout(toastTimer.current);
    clearTimeout(autoSaveTimer.current);
  }, []);

  async function loadFile(filePath: string, name: string, baseDir = data?.baseDir || '') {
    if (activeFileRef.current && activeFileRef.current !== filePath) {
      await saveCurrentFile({ silent: true, force: true });
    }
    clearTimeout(autoSaveTimer.current);
    activeFileRef.current = filePath;
    setActiveFile(filePath);
    setFileName(name);
    activeBaseDirRef.current = baseDir;
    const text = await (window as any).hana?.readSkillFile?.(filePath);
    contentRef.current = text;
    setContent(text);
    setIsDirty(false);
    setSaveState('saved');
    setMode('preview');
  }

  async function onCopy() {
    if (!data?.baseDir) return;
    try {
      const res = await hanaFetch('/api/skills/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: data.baseDir }),
      });
      const result = await res.json();
      if (result.error) throw new Error(result.error);
      showToast(t('skillViewer.copied'));
    } catch (e: any) {
      showToast(`${t('skillViewer.installFailed')}${e.message}`);
    }
  }

  const expandAll = useCallback(() => {
    const allDirs = collectDirPaths(files);
    setExpandedDirs(Object.fromEntries(allDirs.map((p) => [p, true])));
  }, [files]);

  const collapseAll = useCallback(() => {
    setExpandedDirs({});
  }, []);

  const toggleDir = useCallback((dirPath: string) => {
    setExpandedDirs(prev => ({ ...prev, [dirPath]: !prev[dirPath] }));
  }, []);

  const onEditorChange = useCallback((next: string) => {
    contentRef.current = next;
    setContent(next);
    setIsDirty(true);
    setSaveState('unsaved');
    clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(() => {
      void saveCurrentFile({ silent: true });
    }, 400);
  }, [saveCurrentFile]);

  const toggleMode = useCallback(async () => {
    if (mode === 'edit') {
      await saveCurrentFile({ silent: true, force: true });
      setMode('preview');
      return;
    }
    setMode('edit');
  }, [mode, saveCurrentFile]);

  if (!data) return null;

  return (
    <div className="sv-overlay" onClick={(e) => { if (e.target === e.currentTarget) void close(); }}>
      <div className="sv-container">
        <div className="sv-topbar">
          {!isDarwin && (
            <button className="sv-close" onClick={() => void close()}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
          <div className="sv-topbar-title">
            <span className="sv-skill-name">{data.name || 'Skill'}</span>
            <span> / {fileName}</span>
          </div>
          <div className="sv-topbar-actions">
            <span className={`sv-save-state is-${saveState}`}>
              {saveState === 'saving' && t('skillViewer.saving')}
              {saveState === 'unsaved' && t('skillViewer.unsaved')}
              {saveState === 'error' && t('skillViewer.saveFailed')}
              {saveState === 'saved' && t('skillViewer.saved')}
            </span>
            {content != null && (
              <button className="sv-btn" onClick={() => { void toggleMode(); }}>
                {mode === 'edit' ? t('skillViewer.preview') : t('skillViewer.edit')}
              </button>
            )}
            {!data.installed && (
              <button className="sv-btn sv-btn-outline" onClick={onCopy}>
                {t('settings.skills.copyToSkills')}
              </button>
            )}
          </div>
        </div>

        <div className="sv-body">
          <div className="sv-sidebar">
            <div className="sv-sidebar-header">
              <span className="sv-sidebar-title">{t('skillViewer.structure')}</span>
              <div className="sv-sidebar-actions">
                <button className="sv-sidebar-btn" onClick={expandAll}>{t('skillViewer.expandAll')}</button>
                <button className="sv-sidebar-btn" onClick={collapseAll}>{t('skillViewer.collapseAll')}</button>
              </div>
            </div>
            {files.map((item, i) => (
              <TreeNode
                key={i}
                item={item}
                activeFile={activeFile}
                onSelect={loadFile}
                expandedDirs={expandedDirs}
                onToggleDir={toggleDir}
              />
            ))}
          </div>

          <div className={`sv-content ${mode === 'edit' ? 'is-edit' : 'is-preview'}`}>
            {content == null ? (
              <div className="sv-empty">{t('skillViewer.cantRead')}</div>
            ) : mode === 'edit' ? (
              <textarea
                className="sv-editor"
                value={content}
                spellCheck={false}
                onChange={(e) => onEditorChange(e.target.value)}
              />
            ) : isMarkdown ? (
              <>
                {markdownPreview.description && (
                  <div className="sv-description">
                    <div className="sv-description-label">Description</div>
                    <div className="sv-description-text">{markdownPreview.description}</div>
                  </div>
                )}
                <div className="md-content" dangerouslySetInnerHTML={{ __html: markdownPreview.html }} />
              </>
            ) : (
              <pre><code>{content}</code></pre>
            )}
          </div>
        </div>

        {toast && <div className="sv-toast show">{toast}</div>}
      </div>
    </div>
  );
}

function TreeNode({ item, activeFile, onSelect, expandedDirs, onToggleDir }: {
  item: TreeItem;
  activeFile: string | null;
  onSelect: (path: string, name: string) => void;
  expandedDirs: Record<string, boolean>;
  onToggleDir: (dirPath: string) => void;
}) {
  const dirPath = item.path || '';
  const expanded = !!expandedDirs[dirPath];

  if (item.isDir) {
    return (
      <div className="sv-tree-folder">
        <div className="sv-tree-item" onClick={() => dirPath && onToggleDir(dirPath)}>
          <span className="sv-icon sv-chevron">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {!expanded
                ? <polyline points="9 18 15 12 9 6" />
                : <polyline points="6 9 12 15 18 9" />}
            </svg>
          </span>
          <span className="sv-label">{item.name}</span>
        </div>
        {expanded && (
          <div className="sv-tree-children">
            {item.children?.map((child, i) => (
              <TreeNode
                key={i}
                item={child}
                activeFile={activeFile}
                onSelect={onSelect}
                expandedDirs={expandedDirs}
                onToggleDir={onToggleDir}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  const ext = item.name.split('.').pop()?.toLowerCase() || '';
  const isMd = ext === 'md' || ext === 'markdown';
  const isCode = ['js', 'py', 'sh', 'bash', 'ts'].includes(ext);

  return (
    <div
      className={`sv-tree-item${item.path === activeFile ? ' active' : ''}`}
      onClick={() => item.path && onSelect(item.path, item.name)}
    >
      <span className="sv-icon">
        {isMd ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
          </svg>
        ) : isCode ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
          </svg>
        )}
      </span>
      <span className="sv-label">{item.name}</span>
    </div>
  );
}

function collectDirPaths(items: TreeItem[]): string[] {
  const out: string[] = [];
  const walk = (arr: TreeItem[]) => {
    for (const item of arr) {
      if (!item.isDir) continue;
      if (item.path) out.push(item.path);
      if (Array.isArray(item.children) && item.children.length > 0) {
        walk(item.children);
      }
    }
  };
  walk(items);
  return out;
}

function parseFmDescription(fm: string): string {
  const idx = fm.search(/^description:/m);
  if (idx === -1) return '';
  const fromDesc = fm.slice(idx);
  const lines = fromDesc.split('\n');
  const value = lines[0].replace(/^description:\s*/, '');

  const q = value[0];
  if (q === '"' || q === "'") {
    let full = value.slice(1);
    let i = 1;
    while (!full.includes(q) && i < lines.length) {
      full += '\n' + lines[i].replace(/^ {2,}/, '');
      i++;
    }
    const ci = full.indexOf(q);
    if (ci !== -1) full = full.slice(0, ci);
    return decodeEscapedNewlines(full.trim());
  }

  if (value === '|' || value === '>' || value === '|+' || value === '>+') {
    let block = '';
    for (let i = 1; i < lines.length; i++) {
      if (/^\S/.test(lines[i])) break;
      block += lines[i].replace(/^ {2,}/, '') + '\n';
    }
    return decodeEscapedNewlines(block.trim());
  }

  return decodeEscapedNewlines(value.trim());
}

function decodeEscapedNewlines(text: string): string {
  return text
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n');
}

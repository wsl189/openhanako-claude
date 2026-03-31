/**
 * 纯工具函数，从 modules/utils.js 平移为 TS module
 */

export function toSlash(s: string): string { return s.replace(/\\/g, '/'); }
export function baseName(s: string): string { return s.replace(/\\/g, '/').split('/').pop() || s; }
export function isHttpUrlPath(s: string): boolean { return /^https?:\/\//i.test((s || '').trim()); }

export function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n' || (ch === '\r' && text[i + 1] === '\n')) {
        row.push(field); field = '';
        if (row.some(c => c !== '')) rows.push(row);
        row = [];
        if (ch === '\r') i++;
      } else field += ch;
    }
  }
  row.push(field);
  if (row.some(c => c !== '')) rows.push(row);
  return rows;
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico']);

export function isImageFile(name: string): boolean {
  const ext = (name || '').toLowerCase().replace(/^.*(\.\w+)$/, '$1');
  return IMAGE_EXTS.has(ext);
}

export function formatSessionDate(isoStr: string): string {
  const t = window.t ?? ((p: string) => p);
  const date = new Date(isoStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return t('time.justNow');
  if (diffMin < 60) return t('time.minutesAgo', { n: diffMin });
  if (diffHr < 24) return t('time.hoursAgo', { n: diffHr });
  if (diffDay < 7) return t('time.daysAgo', { n: diffDay });

  const m = date.getMonth() + 1;
  const d = date.getDate();
  return t('time.dateFormat', { m, d });
}

export function cronToHuman(schedule: number | string, type?: string): string {
  const t = window.t ?? ((p: string) => p);
  const dayNames: string[] = (t as any)('cron.dayNames') || ['日', '一', '二', '三', '四', '五', '六'];
  const weekPrefix = t('cron.weekPrefix');
  const renderDay = (idx: number): string => `${weekPrefix}${(Array.isArray(dayNames) ? dayNames : [])[idx] || String(idx)}`;
  const parseDowIndex = (raw: string): number | null => {
    const v = String(raw || '').trim().toUpperCase();
    if (!v) return null;
    const map: Record<string, number> = {
      SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
    };
    if (Object.prototype.hasOwnProperty.call(map, v)) return map[v];
    if (!/^\d+$/.test(v)) return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    if (n === 7) return 0;
    if (n >= 0 && n <= 6) return n;
    return null;
  };
  const formatDowExpr = (expr: string): string => {
    const raw = String(expr || '').trim();
    if (!raw) return raw;
    const upperRaw = raw.toUpperCase();
    if (upperRaw === '1-5' || upperRaw === 'MON-FRI') return t('cron.workdays');
    return raw.split(',').map((seg) => {
      const token = seg.trim();
      if (!token) return token;
      const range = token.match(/^([A-Za-z]{3}|\d{1,2})-([A-Za-z]{3}|\d{1,2})$/);
      if (range) {
        const start = parseDowIndex(range[1]);
        const end = parseDowIndex(range[2]);
        if (start !== null && end !== null) return `${renderDay(start)}-${renderDay(end)}`;
        return token;
      }
      const idx = parseDowIndex(token);
      if (idx !== null) return renderDay(idx);
      return token;
    }).join('/');
  };
  const pad2 = (n: number): string => String(Math.max(0, Math.min(59, n))).padStart(2, '0');
  const toEveryMinutes = (raw: number): number => {
    if (!Number.isFinite(raw) || raw <= 0) return 1;
    // 兼容旧数据：5 这类值按“分钟数”理解
    if (raw < 1000) return Math.max(1, Math.round(raw));
    return Math.max(1, Math.round(raw / 60000));
  };
  const renderEveryByMinutes = (mins: number): string => {
    if (mins >= 60 && mins % 60 === 0) {
      return t('cron.everyHours', { n: mins / 60 });
    }
    return t('cron.everyMinutes', { n: mins });
  };

  if (typeof schedule === 'number') {
    return renderEveryByMinutes(toEveryMinutes(schedule));
  }
  const s = String(schedule).trim();

  // 兼容旧数据：every 可能被存成自然语言字符串（如 "every minute" / "每分钟"）
  const parseLegacyEvery = (text: string): { unit: 'minutes' | 'hours'; n: number } | null => {
    const en = text.match(/^every\s*(\d+)?\s*(minute|minutes|hour|hours)$/i);
    if (en) {
      const n = Math.max(1, parseInt(en[1] || '1', 10));
      const unit = /hour/i.test(en[2]) ? 'hours' : 'minutes';
      return { unit, n };
    }

    const zhMinute = text.match(/^每\s*(\d+)?\s*分(?:钟)?$/);
    if (zhMinute) {
      const n = Math.max(1, parseInt(zhMinute[1] || '1', 10));
      return { unit: 'minutes', n };
    }

    const zhHour = text.match(/^每\s*(\d+)?\s*(?:小)?时$/);
    if (zhHour) {
      const n = Math.max(1, parseInt(zhHour[1] || '1', 10));
      return { unit: 'hours', n };
    }

    return null;
  };

  const legacyEvery = parseLegacyEvery(s);
  if (legacyEvery) {
    return legacyEvery.unit === 'hours'
      ? t('cron.everyHours', { n: legacyEvery.n })
      : t('cron.everyMinutes', { n: legacyEvery.n });
  }

  // 兼容旧数据：某些 daily cron 可能被存成 "21:00" 这类时间字符串
  const hhmm = s.match(/^(\d{1,2}):(\d{2})$/);
  if (hhmm && type === 'cron') {
    const hour = String(Math.max(0, Math.min(23, Number(hhmm[1]))));
    const min = hhmm[2];
    return t('cron.dailyAt', { hour, min });
  }
  if (/^\d+$/.test(s)) {
    return renderEveryByMinutes(toEveryMinutes(parseInt(s, 10)));
  }
  const parts = s.split(' ');
  if (parts.length !== 5) return s;
  const [min, hour, , , dow] = parts;

  const minuteStep = min.match(/^\*\/(\d+)$/);
  const hourRange = hour.match(/^(\d{1,2})-(\d{1,2})$/);
  if (minuteStep && hourRange) {
    const n = Math.max(1, parseInt(minuteStep[1], 10));
    const startHour = Math.max(0, Math.min(23, Number(hourRange[1])));
    const endHour = Math.max(0, Math.min(23, Number(hourRange[2])));
    const span = `${pad2(startHour)}:00-${pad2(endHour)}:59`;
    const freq = t('cron.everyMinutes', { n });
    const dayStr = dow === '*' ? '' : formatDowExpr(dow);
    return dayStr ? `${dayStr} ${span} ${freq}` : `${span} ${freq}`;
  }

  if (min === '*' && hour === '*' && dow === '*') {
    return t('cron.everyMinutes', { n: 1 });
  }
  if (min.startsWith('*/') && hour === '*' && dow === '*') {
    return t('cron.everyMinutes', { n: min.slice(2) });
  }
  if (min === '0' && hour.startsWith('*/') && dow === '*') {
    return t('cron.everyHours', { n: hour.slice(2) });
  }
  if (min === '0' && hour === '*' && dow === '*') return t('cron.hourly');
  if (hour === '*' && dow === '*' && /^\d+$/.test(min)) return t('cron.hourly');
  if (dow === '*' && hour !== '*' && min !== '*') {
    return t('cron.dailyAt', { hour, min: min.padStart(2, '0') });
  }
  if (dow !== '*' && hour !== '*' && /^\d+$/.test(hour) && /^\d+$/.test(min)) {
    const dayStr = formatDowExpr(dow);
    return t('cron.weeklyAt', { days: dayStr, hour, min: min.padStart(2, '0') });
  }

  if (dow !== '*') {
    const dayStr = formatDowExpr(dow);
    if (dayStr !== dow) return `${dayStr} ${hour} ${min}`;
  }
  return s;
}

/**
 * 兼容旧调用：当前不再解析/剥离 mood 区块，直接返回原文。
 */
export function parseMoodFromContent(content: string): { mood: string | null; text: string } {
  if (!content) return { mood: null, text: '' };
  return { mood: null, text: content };
}

/**
 * 给 md-content 里的代码块注入复制按钮
 */
export function injectCopyButtons(container: HTMLElement): void {
  const t = window.t ?? ((p: string) => p);
  const pres = container.querySelectorAll('pre');
  for (const pre of pres) {
    if (pre.querySelector('.copy-btn')) continue;
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.textContent = t('attach.copy');
    btn.addEventListener('click', () => {
      const code = pre.querySelector('code');
      const text = code ? code.textContent : pre.textContent;
      navigator.clipboard.writeText(text || '').then(() => {
        btn.textContent = t('attach.copied');
        setTimeout(() => { btn.textContent = t('attach.copy'); }, 1500);
      });
    });
    pre.style.position = 'relative';
    pre.appendChild(btn);
  }
}

import { describe, expect, it } from 'vitest';
import { cronToHuman } from './format';

function withZhI18n() {
  (globalThis as any).window = {
    t: (key: string, vars?: Record<string, unknown>) => {
      const dict: Record<string, any> = {
        'cron.everyHours': ({ n }: any) => `每 ${n} 小时`,
        'cron.everyMinutes': ({ n }: any) => `每 ${n} 分钟`,
        'cron.workdays': '工作日',
        'cron.hourly': '每小时',
        'cron.dailyAt': ({ hour, min }: any) => `每天 ${hour}:${min}`,
        'cron.weeklyAt': ({ days, hour, min }: any) => `${days} ${hour}:${min}`,
        'cron.dayNames': ['日', '一', '二', '三', '四', '五', '六'],
        'cron.weekPrefix': '周',
      };
      const v = dict[key];
      if (typeof v === 'function') return v(vars || {});
      if (v !== undefined) return v;
      return key;
    },
  };
}

describe('cronToHuman complex cron display', () => {
  it('renders weekday + hour range + every-5-min cron in human-friendly text', () => {
    withZhI18n();
    const result = cronToHuman('*/5 9-14 * * 1-5', 'cron');
    expect(result).toBe('工作日 09:00-14:59 每 5 分钟');
  });

  it('keeps weekly fixed-time display for simple cron', () => {
    withZhI18n();
    const result = cronToHuman('0 8 * * 1,3,5', 'cron');
    expect(result).toBe('周一/周三/周五 8:00');
  });
});

/**
 * SettingsConfirmCard — 设置修改确认卡片
 *
 * 三种控件：toggle / list / text
 * 用户可编辑后确认/取消，通过 REST API resolve 阻塞的 tool Promise。
 */

import { memo, useState, useCallback, useMemo } from 'react';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useI18n } from '../../hooks/use-i18n';

interface Props {
  confirmId: string;
  settingKey: string;
  cardType: 'toggle' | 'list' | 'text';
  currentValue: string;
  proposedValue: string;
  options?: string[];
  optionLabels?: Record<string, string>;
  label: string;
  description?: string;
  status: 'pending' | 'confirmed' | 'rejected' | 'timeout';
}

const THEME_I18N: Record<string, string> = {
  'warm-paper': 'settings.appearance.warmPaper',
  'midnight': 'settings.appearance.midnight',
  'high-contrast': 'settings.appearance.highContrast',
  'grass-aroma': 'settings.appearance.grassAroma',
  'contemplation': 'settings.appearance.contemplation',
  'absolutely': 'settings.appearance.absolutely',
  'delve': 'settings.appearance.delve',
  'deep-think': 'settings.appearance.deepThink',
  'auto': 'settings.appearance.auto',
};

const THINKING_I18N: Record<string, string> = {
  'auto': 'settings.agent.thinkingLevels.auto',
  'off': 'settings.agent.thinkingLevels.off',
  'low': 'settings.agent.thinkingLevels.low',
  'medium': 'settings.agent.thinkingLevels.medium',
  'high': 'settings.agent.thinkingLevels.high',
};

const LOCALE_LABELS: Record<string, string> = {
  'zh-CN': '简体中文', 'en': 'English',
};

const SETTING_LABEL_KEYS: Record<string, string> = {
  'locale': 'toolDef.updateSettings.locale',
  'timezone': 'toolDef.updateSettings.timezone',
  'thinking_level': 'toolDef.updateSettings.thinkingBudget',
  'memory.enabled': 'toolDef.updateSettings.memory',
  'agent.name': 'toolDef.updateSettings.agentName',
  'user.name': 'toolDef.updateSettings.userName',
  'home_folder': 'toolDef.updateSettings.workingDir',
  'theme': 'toolDef.updateSettings.theme',
  'models.chat': 'toolDef.updateSettings.chatModel',
};

function toggleLabel(from: string, to: string, t: (k: string) => string): string {
  const f = from === 'true' ? t('common.on') : t('common.off');
  const toLabel = to === 'true' ? t('common.on') : t('common.off');
  return `${f} → ${toLabel}`;
}

export const SettingsConfirmCard = memo(function SettingsConfirmCard(props: Props) {
  const { confirmId, settingKey, cardType, currentValue, proposedValue, options, optionLabels: externalLabels, label, description, status: initialStatus } = props;
  const { t } = useI18n();
  const [status, setStatus] = useState(initialStatus);
  const [editValue, setEditValue] = useState(proposedValue);

  // 本地化标签：优先用外部传入的，否则卡片自行查 i18n
  const optionLabels = useMemo(() => {
    if (externalLabels && Object.keys(externalLabels).length) return externalLabels;
    if (settingKey === 'theme') return Object.fromEntries(Object.entries(THEME_I18N).map(([k, v]) => [k, t(v)]));
    if (settingKey === 'thinking_level') return Object.fromEntries(Object.entries(THINKING_I18N).map(([k, v]) => [k, t(v)]));
    if (settingKey === 'locale') return LOCALE_LABELS;
    return undefined;
  }, [externalLabels, settingKey, t]);

  // 设置项标签：优先用外部传入的，否则自行查 i18n
  const displayLabel = useMemo(() => {
    if (label && label !== settingKey) return label;
    const key = SETTING_LABEL_KEYS[settingKey];
    return key ? t(key) : label;
  }, [label, settingKey, t]);

  const handleConfirm = useCallback(async () => {
    try {
      await hanaFetch(`/api/confirm/${confirmId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'confirmed', value: editValue }),
      });
      setStatus('confirmed');
    } catch { /* silent */ }
  }, [confirmId, editValue]);

  const handleReject = useCallback(async () => {
    try {
      await hanaFetch(`/api/confirm/${confirmId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rejected' }),
      });
      setStatus('rejected');
    } catch { /* silent */ }
  }, [confirmId]);

  // ── 已完成状态 ──
  if (status !== 'pending') {
    if (status === 'confirmed' && cardType === 'toggle') {
      return (
        <div className="settings-confirm-card done">
          <div className="settings-confirm-header">
            <span className="settings-confirm-label">{displayLabel}</span>
            <div className={`hana-toggle${editValue === 'true' ? ' on' : ''}`} style={{ pointerEvents: 'none' }}>
              <div className="hana-toggle-thumb" />
            </div>
          </div>
          <div className="settings-confirm-note">{toggleLabel(currentValue, editValue, t)}</div>
        </div>
      );
    }
    const displayValue = optionLabels?.[editValue] || editValue;
    const statusText = status === 'confirmed' ? `${displayLabel} → ${displayValue}`
      : status === 'rejected' ? t('common.changeRejected').replace('{label}', displayLabel)
      : t('common.changeTimeout').replace('{label}', displayLabel);
    const statusClass = status === 'confirmed' ? 'confirmed' : 'rejected';
    return (
      <div className="settings-confirm-card done">
        <div className={`settings-confirm-status ${statusClass}`}>{statusText}</div>
      </div>
    );
  }

  // ── Pending 状态 ──
  return (
    <div className="settings-confirm-card">
      {cardType === 'toggle' ? (
        <>
          <div className="settings-confirm-header" onClick={() => setEditValue(editValue === 'true' ? 'false' : 'true')} style={{ cursor: 'pointer' }}>
            <div>
              <div className="settings-confirm-label">{displayLabel}</div>
              {description && <div className="settings-confirm-desc">{description}</div>}
            </div>
            <div className={`hana-toggle${editValue === 'true' ? ' on' : ''}`}>
              <div className="hana-toggle-thumb" />
            </div>
          </div>
          <div className="settings-confirm-note">{toggleLabel(currentValue, editValue, t)}</div>
        </>
      ) : (
        <>
          <div className="settings-confirm-label">{displayLabel}</div>
          {description && <div className="settings-confirm-desc">{description}</div>}
          <div className="settings-confirm-control">
            {cardType === 'list' && options && (
              <div className="settings-confirm-options">
                {options.map(opt => (
                  <button
                    key={opt}
                    className={`settings-confirm-option${opt === editValue ? ' selected' : ''}`}
                    onClick={() => setEditValue(opt)}
                  >
                    {opt === editValue ? '✓ ' : ''}{optionLabels?.[opt] || opt}
                  </button>
                ))}
              </div>
            )}
            {cardType === 'text' && (
              <input
                className="settings-confirm-input"
                type="text"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
              />
            )}
          </div>
        </>
      )}

      <div className="settings-confirm-actions">
        <button className="settings-confirm-btn confirm" onClick={handleConfirm}>{t('common.confirm')}</button>
        <button className="settings-confirm-btn reject" onClick={handleReject}>{t('common.cancel')}</button>
      </div>
    </div>
  );
});

import React, { useState, useEffect } from 'react';
import { useSettingsStore } from '../store';
import { t, autoSaveConfig } from '../helpers';
import { Toggle } from '../widgets/Toggle';

export function WorkTab() {
  const { settingsConfig } = useSettingsStore();
  const [hbEnabled, setHbEnabled] = useState(true);
  const [hbIntervalInput, setHbIntervalInput] = useState('17');
  const [cronAutoApprove, setCronAutoApprove] = useState(true);

  useEffect(() => {
    if (settingsConfig) {
      setHbEnabled(settingsConfig.desk?.heartbeat_enabled !== false);
      setHbIntervalInput(String(settingsConfig.desk?.heartbeat_interval ?? 17));
      setCronAutoApprove(settingsConfig.desk?.cron_auto_approve !== false);
    }
  }, [settingsConfig]);

  const toggleHeartbeat = async (on: boolean) => {
    setHbEnabled(on);
    await autoSaveConfig({ desk: { heartbeat_enabled: on } });
  };

  const toggleCronAutoApprove = async (on: boolean) => {
    setCronAutoApprove(on);
    await autoSaveConfig({ desk: { cron_auto_approve: on } });
  };

  const saveWork = async () => {
    const parsed = Number(hbIntervalInput);
    const interval = Number.isFinite(parsed)
      ? Math.max(1, Math.min(120, Math.floor(parsed)))
      : 17;
    setHbIntervalInput(String(interval));
    await autoSaveConfig({ desk: { heartbeat_interval: interval } });
  };

  return (
    <div className="settings-tab-content active" data-tab="work">
      {/* 巡检 */}
      <section className="settings-section">
        <h2 className="settings-section-title">{t('settings.work.title')}</h2>
        <div className="tool-caps-group">
          <div className="tool-caps-item">
            <div className="tool-caps-label">
              <span className="tool-caps-name">{t('settings.work.heartbeatEnabled')}</span>
              <span className="tool-caps-desc">{t('settings.work.heartbeatDesc')}</span>
            </div>
            <Toggle
              on={hbEnabled}
              onChange={toggleHeartbeat}
            />
          </div>
          <div className={`tool-caps-item${hbEnabled ? '' : ' settings-disabled'}`}>
            <div className="tool-caps-label">
              <span className="tool-caps-name">{t('settings.work.heartbeatInterval')}</span>
            </div>
            <div className="settings-input-group">
              <input
                type="number"
                className="settings-input small"
                min={1}
                max={120}
                value={hbIntervalInput}
                disabled={!hbEnabled}
                onChange={(e) => {
                  const next = e.target.value;
                  if (next === '' || /^\d+$/.test(next)) setHbIntervalInput(next);
                }}
              />
              <span className="settings-input-unit">{t('settings.work.heartbeatUnit')}</span>
            </div>
          </div>
          <div className="tool-caps-item">
            <div className="tool-caps-label">
              <span className="tool-caps-name">{t('settings.work.cronAutoApprove')}</span>
              <span className="tool-caps-desc">{t('settings.work.cronAutoApproveDesc')}</span>
            </div>
            <Toggle
              on={cronAutoApprove}
              onChange={toggleCronAutoApprove}
            />
          </div>
        </div>
      </section>

      <div className="settings-section-footer">
        <button className="settings-save-btn-sm" onClick={saveWork}>
          {t('settings.save')}
        </button>
      </div>
    </div>
  );
}

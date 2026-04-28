import React, { useEffect, useState } from 'react';
import { t } from '../helpers';
import iconUrl from '../../../assets/Hanako.png';

const hana = (window as any).hana;
const RELEASE_REPO_URL = 'https://github.com/wsl189/myagent-releases';
const RELEASE_REPO_LABEL = 'github.com/wsl189/myagent-releases';

export function AboutTab() {
  const [version, setVersion] = useState('');
  const [licenseOpen, setLicenseOpen] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<{ version: string; downloadUrl?: string; downloaded?: boolean; percent?: number } | null>(null);

  useEffect(() => {
    hana?.getAppVersion?.().then((v: string) => setVersion(v || ''));
    hana?.checkUpdate?.().then((info: any) => {
      if (info?.version) setUpdateInfo(info);
    });
    const unsubscribe = hana?.onUpdateInfo?.((info: any) => {
      setUpdateInfo(info?.version ? info : null);
    });
    return () => unsubscribe?.();
  }, []);

  return (
    <div className="settings-tab-content active" data-tab="about">
      <div className="about-hero">
        <img
          className="about-icon about-icon-clickable"
          src={iconUrl}
          alt="Hanako"
        />
        <div className="about-name">Hanako</div>
        <div className="about-tagline">{t('settings.about.tagline')}</div>
        {version && <div className="about-version">v{version}</div>}
        {updateInfo && (
          <div className="about-update">
            <span>
              {updateInfo.downloaded
                ? t('settings.about.updateReady', { version: updateInfo.version })
                : t('settings.about.updateAvailable', { version: updateInfo.version })}
              {!updateInfo.downloaded && typeof updateInfo.percent === 'number' ? ` ${updateInfo.percent}%` : ''}
            </span>
            <a
              className="about-update-link"
              href="#"
              onClick={(e) => {
                e.preventDefault();
                if (updateInfo.downloaded) hana?.installUpdate?.();
                else if (updateInfo.downloadUrl) hana?.openExternal?.(updateInfo.downloadUrl);
              }}
            >
              {updateInfo.downloaded ? t('settings.about.updateInstall') : t('settings.about.updateDownload')}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </a>
          </div>
        )}
      </div>

      <section className="about-info">
        <div className="about-row">
          <span className="about-label">{t('settings.about.license')}</span>
          <span className="about-value">Apache License 2.0</span>
        </div>
        <div className="about-row">
          <span className="about-label">{t('settings.about.copyright')}</span>
          <span className="about-value">&copy; 2026 liliMozi</span>
        </div>
        <div className="about-row">
          <span className="about-label">GitHub</span>
          <a
            className="about-value about-link"
            href="#"
            onClick={(e) => {
              e.preventDefault();
              hana?.openExternal?.(RELEASE_REPO_URL);
            }}
          >
            {RELEASE_REPO_LABEL}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </a>
        </div>
      </section>

      <button
        className="about-license-toggle"
        onClick={() => setLicenseOpen(!licenseOpen)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points={licenseOpen ? '18 15 12 9 6 15' : '6 9 12 15 18 9'} />
        </svg>
        {t('settings.about.licenseToggle')}
      </button>

      {licenseOpen && (
        <pre className="about-license-text">{LICENSE_TEXT}</pre>
      )}

    </div>
  );
}

const LICENSE_TEXT = `Apache License, Version 2.0

Copyright 2026 liliMozi

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.`;

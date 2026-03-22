import { createRoot } from 'react-dom/client';
import { useEffect } from 'react';
import { useStore } from './react/stores';
import { SkillViewerOverlay } from './react/components/SkillViewerOverlay';
import { initTheme, initDragPrevention } from './react/bootstrap';

initTheme();
initDragPrevention();

function SkillViewerApp() {
  useEffect(() => {
    const platform = (window as any).platform || (window as any).hana;
    let disposed = false;
    const loadLocale = async (locale: string) => {
      if (!(window as any).i18n?.load) return;
      await (window as any).i18n.load(locale || 'zh-CN');
      if (disposed) return;
      useStore.setState({ locale: (window as any).i18n?.locale || locale });
    };

    platform?.onSkillViewerLoad?.((data: any) => {
      useStore.setState({ skillViewerData: data || null });
    });

    (async () => {
      try {
        // 先加载默认语言，避免初次渲染出现 i18n key。
        await loadLocale('zh-CN');

        const serverPort = await platform?.getServerPort?.();
        const serverToken = await platform?.getServerToken?.();
        if (disposed) return;

        useStore.setState({
          serverPort: String(serverPort || ''),
          serverToken: String(serverToken || ''),
        });

        if (!serverPort) return;
        const headers: Record<string, string> = {};
        if (serverToken) headers.Authorization = `Bearer ${serverToken}`;

        const res = await fetch(`http://127.0.0.1:${serverPort}/api/config`, { headers });
        if (!res.ok) return;
        const config = await res.json();

        const locale = config?.locale || 'zh-CN';
        await loadLocale(locale);
      } catch {
        // 兜底保证有语言包
        await loadLocale('zh-CN');
      }
    })();

    return () => {
      disposed = true;
    };
  }, []);

  return <SkillViewerOverlay />;
}

const el = document.getElementById('react-root');
if (el) {
  createRoot(el).render(<SkillViewerApp />);
}

import { useEffect, useState } from 'react';
import type { components } from './lib/generated/api';

type Health = components['schemas']['Health'];

export default function ProductionApp() {
  const [status, setStatus] = useState('正在连接服务…');
  useEffect(() => {
    const abort = new AbortController();
    void fetch('/api/v1/health', {
      credentials: 'same-origin',
      signal: abort.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('服务暂不可用');
        const health = (await response.json()) as Health;
        setStatus(health.status === 'ok' ? '服务已连接' : '服务暂不可用');
      })
      .catch(() => {
        if (!abort.signal.aborted) setStatus('服务暂不可用');
      });
    return () => abort.abort();
  }, []);
  return (
    <main className="signin-screen">
      <section className="signin-card">
        <div className="eyebrow">ATELIER</div>
        <h1>创作空间</h1>
        <p role="status">{status}</p>
        <p>登录功能正在准备中。</p>
      </section>
    </main>
  );
}

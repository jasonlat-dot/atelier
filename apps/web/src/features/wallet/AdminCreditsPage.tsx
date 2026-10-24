import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import type { AdminProps } from '../upstream/upstreamApi';
import AdminCreditAdjustment from './AdminCreditAdjustment';
import AdminRedeemCodes from './AdminRedeemCodes';
import './AdminCreditsPage.css';
export { default as AdminCreditAdjustment } from './AdminCreditAdjustment';

export default function AdminCreditsPage(props: AdminProps) {
  const [search, setSearch] = useSearchParams();
  const tab = search.get('tab') === 'codes' ? 'codes' : 'adjust';
  const [codesVisited, setCodesVisited] = useState(tab === 'codes');
  const [adjustVisited, setAdjustVisited] = useState(tab === 'adjust');
  if (props.me.user.role === 'USER')
    return (
      <main className="account-shell">
        <h1>无权访问</h1>
        <Link to="/wallet">返回积分账本</Link>
      </main>
    );
  const changeTab = (next: 'adjust' | 'codes') => {
    if (next === 'codes') setCodesVisited(true);
    else setAdjustVisited(true);
    setSearch((current) => {
      const params = new URLSearchParams(current);
      if (next === 'codes') params.set('tab', 'codes');
      else params.delete('tab');
      return params;
    });
  };
  return (
    <main className="account-shell admin-credits-page">
      <header className="admin-credit-page-head">
        <div>
          <div className="eyebrow">ATELIER / ADMIN</div>
          <h1>积分管理</h1>
          <p>管理人工积分调整与兑换码，所有变更保留审计记录。</p>
        </div>
        <Link className="btn" to="/wallet">
          <ArrowLeft size={16} />
          返回积分账本
        </Link>
      </header>
      <nav className="admin-credit-tabs" aria-label="积分管理内容">
        <button
          aria-pressed={tab === 'adjust'}
          onClick={() => changeTab('adjust')}
        >
          积分调整
        </button>
        <button
          aria-pressed={tab === 'codes'}
          onClick={() => changeTab('codes')}
        >
          兑换码管理
        </button>
      </nav>
      {(adjustVisited || tab === 'adjust') && (
        <div hidden={tab !== 'adjust'}>
          <AdminCreditAdjustment {...props} />
        </div>
      )}
      {(codesVisited || tab === 'codes') && (
        <div hidden={tab !== 'codes'}>
          <AdminRedeemCodes {...props} />
        </div>
      )}
    </main>
  );
}

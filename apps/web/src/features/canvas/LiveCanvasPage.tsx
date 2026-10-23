import Feedback from '../../components/Feedback';
import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ReactFlowProvider } from '@xyflow/react';
import { SessionError, type Me } from '../auth/sessionApi';
import { projectApi } from './projectApi';
import LiveCanvasEditor from './LiveCanvasEditor';
import './LiveCanvas.css';
import '@xyflow/react/dist/style.css';
export type CanvasProps = {
  me: Me;
  onExpired: () => void;
  onReload: () => void;
};
export default function LiveCanvasPage(props: CanvasProps) {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const draft = search.get('draft');
  const key = useRef(crypto.randomUUID());
  const query = useQuery({
    queryKey: ['canvas-project', props.me.user.id, id],
    queryFn: ({ signal }) => projectApi.get(id, signal),
    enabled: id !== 'new',
    staleTime: 0,
    gcTime: 0,
  });
  const creating = useRef<Promise<unknown>>();
  useEffect(() => {
    if (id !== 'new') return;
    let live = true;
    if (!creating.current)
      creating.current = projectApi.create(
        '未命名画布',
        props.me.csrf_token,
        key.current,
      );
    void creating.current
      .then((value) => {
        if (live)
          navigate(
            `/canvas/${(value as Awaited<ReturnType<typeof projectApi.create>>).project.id}${draft && draft.length <= 16000 ? `?draft=${encodeURIComponent(draft)}` : ''}`,
            { replace: true },
          );
      })
      .catch(() => {
        if (live) navigate('/canvas', { replace: true });
      });
    return () => {
      live = false;
    };
  }, [id, navigate, props.me.csrf_token, draft]);
  useEffect(() => {
    if (query.error instanceof SessionError) {
      if (query.error.status === 401 || query.error.code === 'ACCOUNT_DISABLED')
        props.onExpired();
      if (query.error.code === 'MFA_REQUIRED') props.onReload();
    }
  }, [query.error, props.onExpired, props.onReload]);
  if (id === 'new' || query.isPending)
    return (
      <main className="page-padding">
        <p role="status">{id === 'new' ? '正在创建画布…' : '正在加载画布…'}</p>
      </main>
    );
  if (!query.data)
    return (
      <main className="page-padding">
        <h1>暂时无法打开画布</h1>
        <Feedback eventKey={query.error} variant="error">
          {query.error instanceof SessionError && query.error.status === 404
            ? '画布已删除或你没有访问权限。'
            : '连接暂时异常，请重试。'}
        </Feedback>
        <button className="btn" onClick={() => void query.refetch()}>
          重新加载
        </button>
      </main>
    );
  return (
    <ReactFlowProvider key={id}>
      <LiveCanvasEditor {...props} initial={query.data} />
    </ReactFlowProvider>
  );
}

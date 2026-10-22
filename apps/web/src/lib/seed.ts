import type { DB, CanvasGraph, Project } from './types';
const at = (s: string) => `/assets/${s}`;
const now = () => new Date().toISOString();
export function demoGraph(): CanvasGraph {
  return {
    viewport: { x: 68, y: 82, zoom: 0.84 },
    nodes: [
      {
        id: 'idea-1',
        type: 'text',
        position: { x: 85, y: 160 },
        data: {
          title: '项目简报',
          text: '一支具有电影质感的旅行短片：日落时分，温柔的暖色调，慢镜头和自然光。',
        },
        style: { width: 260 },
      },
      {
        id: 'image-1',
        type: 'image',
        position: { x: 440, y: 70 },
        data: {
          title: '场景参考 · 山脉',
          src: at('art-mountains.svg'),
          assetId: 'ast-1',
        },
        style: { width: 270 },
      },
      {
        id: 'config-1',
        type: 'config',
        position: { x: 445, y: 390 },
        data: {
          title: '视频生成配置',
          kind: 'video',
          quality: '720p',
          ratio: '16:9',
          duration: 6,
          model: 'motion-demo',
        },
        style: { width: 260 },
      },
      {
        id: 'video-1',
        type: 'video',
        position: { x: 820, y: 128 },
        data: {
          title: '旅途概念片 · 6 秒',
          src: at('sample-motion.mp4'),
          poster: at('video-frame.png'),
          assetId: 'ast-2',
        },
        style: { width: 310 },
      },
    ],
    edges: [
      {
        id: 'edge-1',
        source: 'idea-1',
        target: 'config-1',
        type: 'smoothstep',
        animated: false,
      },
      {
        id: 'edge-2',
        source: 'image-1',
        target: 'config-1',
        type: 'smoothstep',
      },
      {
        id: 'edge-3',
        source: 'config-1',
        target: 'video-1',
        type: 'smoothstep',
      },
    ],
  };
}
const project = (
  id: string,
  ownerId: string,
  name: string,
  graph: CanvasGraph,
): Project => ({ id, ownerId, name, revision: 1, updatedAt: now(), graph });
export function seedDb(): DB {
  return {
    users: [
      {
        id: 'user-demo',
        name: 'Mira Chen',
        email: 'mira@gmail.com',
        role: 'USER',
        credits: 2680,
        avatar: 'MC',
      },
      {
        id: 'admin-demo',
        name: 'Jordan Lee',
        email: 'jordan@gmail.com',
        role: 'ADMIN',
        credits: 10000,
        avatar: 'JL',
      },
      {
        id: 'root-demo',
        name: 'Studio Owner',
        email: 'owner@gmail.com',
        role: 'SUPER_ADMIN',
        credits: 25000,
        avatar: 'SO',
      },
    ],
    currentUserId: 'user-demo',
    checkin: {},
    ledger: [],
    projects: [
      project(
        'project-demo',
        'user-demo',
        '旅行短片 · 秋日电影感',
        demoGraph(),
      ),
      project('project-admin', 'admin-demo', '品牌视觉探索', {
        ...demoGraph(),
        nodes: demoGraph().nodes.map((n) => ({ ...n, id: `a-${n.id}` })),
        edges: [],
      }),
    ],
    assets: [
      {
        id: 'ast-1',
        name: '暮色山脉',
        kind: 'image',
        src: at('art-mountains.svg'),
        ownerId: 'user-demo',
        createdAt: now(),
      },
      {
        id: 'ast-2',
        name: '旅行概念片',
        kind: 'video',
        src: at('sample-motion.mp4'),
        poster: at('video-frame.png'),
        ownerId: 'user-demo',
        createdAt: now(),
        duration: 6,
      },
      {
        id: 'ast-3',
        name: '沙漠光影',
        kind: 'image',
        src: at('art-desert.svg'),
        ownerId: 'user-demo',
        createdAt: now(),
      },
      {
        id: 'ast-4',
        name: '蓝色轨道',
        kind: 'image',
        src: at('art-orbit.svg'),
        ownerId: 'user-demo',
        createdAt: now(),
      },
      {
        id: 'ast-a',
        name: '品牌产品场景',
        kind: 'image',
        src: at('art-bloom.svg'),
        ownerId: 'admin-demo',
        createdAt: now(),
      },
    ],
    jobs: [],
    models: [
      {
        id: 'image-demo',
        label: 'Atelier Image',
        kind: 'image',
        enabled: true,
        cost: 30,
        provider: 'Demo image provider',
      },
      {
        id: 'motion-demo',
        label: 'Atelier Motion',
        kind: 'video',
        enabled: true,
        cost: 150,
        provider: 'Demo video provider',
      },
    ],
  };
}

import { useRef, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import { Copy, Check } from 'lucide-react';
function CodeBlock({ children }: { children: ReactNode }) {
  const code = useRef<HTMLPreElement>(null),
    [copied, setCopied] = useState(false);
  return (
    <div className="chat-code">
      <button
        className="text-action"
        onClick={() =>
          void navigator.clipboard
            .writeText(code.current?.textContent || '')
            .then(() => setCopied(true))
            .catch(() => setCopied(false))
        }
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}{' '}
        {copied ? '已复制' : '复制代码'}
      </button>
      <pre ref={code}>{children}</pre>
    </div>
  );
}
export default function SafeMarkdown({ text }: { text: string }) {
  return (
    <div className="chat-markdown">
      <Markdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        urlTransform={(url) => {
          try {
            const value = new URL(url, window.location.origin);
            return ['http:', 'https:', 'mailto:'].includes(value.protocol)
              ? url
              : '';
          } catch {
            return '';
          }
        }}
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          img: ({ src, alt }) => (
            <a href={src} target="_blank" rel="noopener noreferrer">
              {alt || '查看图片'}
            </a>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}

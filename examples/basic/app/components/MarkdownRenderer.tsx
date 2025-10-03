import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownRendererProps {
  content: string;
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  return (
    <div className="markdown-container">
      <ReactMarkdown
        remarkPlugins={[remarkGfm as any]}
        components={{
          // Style the components inline to match dark theme
          h1: ({children}: {children?: React.ReactNode}) => <h1 style={{fontSize: "1.5em", marginTop: "1em", marginBottom: "0.5em"}}>{children}</h1>,
          h2: ({children}: {children?: React.ReactNode}) => <h2 style={{fontSize: "1.3em", marginTop: "0.8em", marginBottom: "0.4em"}}>{children}</h2>,
          h3: ({children}: {children?: React.ReactNode}) => <h3 style={{fontSize: "1.1em", marginTop: "0.6em", marginBottom: "0.3em"}}>{children}</h3>,

          table: ({children}: {children?: React.ReactNode}) => (
            <table style={{
              borderCollapse: "collapse",
              width: "100%",
              marginTop: "0.5em",
              marginBottom: "0.5em"
            }}>
              {children}
            </table>
          ),
          
          th: ({children}: {children?: React.ReactNode}) => (
            <th style={{
              border: "1px solid #30363d",
              padding: "0.5em",
              backgroundColor: "#161b22",
              textAlign: "left"
            }}>
              {children}
            </th>
          ),

          td: ({children}: {children?: React.ReactNode}) => (
            <td style={{
              border: "1px solid #30363d",
              padding: "0.5em"
            }}>
              {children}
            </td>
          ),

          code({className, children, ...props}: {className?: string; children?: React.ReactNode}) {
            // Detect inline vs block code by checking if there's a language class
            const isBlock = className && className.startsWith('language-');
            
            if (!isBlock) {
              return (
                <code style={{
                  background: "#2d333b",
                  padding: "0.2em 0.4em",
                  borderRadius: "3px",
                  fontSize: "0.9em"
                }}>
                  {children}
                </code>
              );
            }
            return (
              <pre style={{
                background: "#161b22",
                padding: "1em",
                borderRadius: "6px",
                border: "1px solid #30363d",
                overflowX: "auto",
                margin: "0.5em 0"
              }}>
                <code className={className} {...props}>
                  {children}
                </code>
              </pre>
            );
          },
          
          blockquote: ({children}: {children?: React.ReactNode}) => (
            <blockquote style={{
              borderLeft: "3px solid #30363d",
              paddingLeft: "1em",
              marginLeft: "0",
              fontStyle: "italic",
              color: "#8b949e"
            }}>
              {children}
            </blockquote>
          ),

          ul: ({children}: {children?: React.ReactNode}) => <ul style={{marginLeft: "1.5em", marginTop: "0.3em", marginBottom: "0.3em"}}>{children}</ul>,
          ol: ({children}: {children?: React.ReactNode}) => <ol style={{marginLeft: "1.5em", marginTop: "0.3em", marginBottom: "0.3em"}}>{children}</ol>,
          li: ({children}: {children?: React.ReactNode}) => <li style={{marginTop: "0.2em", marginBottom: "0.2em"}}>{children}</li>,
          hr: () => <hr style={{border: "0", borderTop: "1px solid #30363d", margin: "1em 0"}} />,
          p: ({children}: {children?: React.ReactNode}) => <p style={{marginBottom: "0.5em", lineHeight: "1.6"}}>{children}</p>,
          strong: ({children}: {children?: React.ReactNode}) => <strong style={{fontWeight: "600"}}>{children}</strong>,
          em: ({children}: {children?: React.ReactNode}) => <em style={{fontStyle: "italic"}}>{children}</em>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
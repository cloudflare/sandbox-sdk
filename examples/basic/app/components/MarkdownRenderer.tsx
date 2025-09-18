import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownRendererProps {
  content: string;
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  return (
    <div className="markdown-container">
      <ReactMarkdown 
        remarkPlugins={[remarkGfm]}
        components={{
          // Style the components inline to match dark theme
          h1: ({children}) => <h1 style={{fontSize: "1.5em", marginTop: "1em", marginBottom: "0.5em"}}>{children}</h1>,
          h2: ({children}) => <h2 style={{fontSize: "1.3em", marginTop: "0.8em", marginBottom: "0.4em"}}>{children}</h2>,
          h3: ({children}) => <h3 style={{fontSize: "1.1em", marginTop: "0.6em", marginBottom: "0.3em"}}>{children}</h3>,
          
          table: ({children}) => (
            <table style={{
              borderCollapse: "collapse",
              width: "100%",
              marginTop: "0.5em",
              marginBottom: "0.5em"
            }}>
              {children}
            </table>
          ),
          
          th: ({children}) => (
            <th style={{
              border: "1px solid #30363d",
              padding: "0.5em",
              backgroundColor: "#161b22",
              textAlign: "left"
            }}>
              {children}
            </th>
          ),
          
          td: ({children}) => (
            <td style={{
              border: "1px solid #30363d",
              padding: "0.5em"
            }}>
              {children}
            </td>
          ),
          
          code({inline, className, children, ...props}) {
            if (inline) {
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
          
          blockquote: ({children}) => (
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
          
          ul: ({children}) => <ul style={{marginLeft: "1.5em", marginTop: "0.3em", marginBottom: "0.3em"}}>{children}</ul>,
          ol: ({children}) => <ol style={{marginLeft: "1.5em", marginTop: "0.3em", marginBottom: "0.3em"}}>{children}</ol>,
          li: ({children}) => <li style={{marginTop: "0.2em", marginBottom: "0.2em"}}>{children}</li>,
          hr: () => <hr style={{border: "0", borderTop: "1px solid #30363d", margin: "1em 0"}} />,
          p: ({children}) => <p style={{marginBottom: "0.5em", lineHeight: "1.6"}}>{children}</p>,
          strong: ({children}) => <strong style={{fontWeight: "600"}}>{children}</strong>,
          em: ({children}) => <em style={{fontStyle: "italic"}}>{children}</em>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
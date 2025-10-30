import React from 'react';
import { InlineMath, BlockMath } from 'react-katex';
import 'katex/dist/katex.min.css';

interface LaTeXRendererProps {
  content: string;
}

export function LaTeXRenderer({ content }: LaTeXRendererProps) {
  // Parse the entire content at once to handle multi-line LaTeX
  const parseContent = (): React.ReactNode[] => {
    const elements: React.ReactNode[] = [];

    // Regular expressions for finding LaTeX delimiters
    const combinedRegex = /(\$\$[\s\S]*?\$\$|\$[^\$\n]+?\$)/g;

    let lastIndex = 0;
    let match;

    while ((match = combinedRegex.exec(content)) !== null) {
      // Add any text before the match
      if (match.index > lastIndex) {
        const textBefore = content.substring(lastIndex, match.index);
        if (textBefore) {
          // Split by newlines and add line breaks
          const lines = textBefore.split('\n');
          lines.forEach((line, idx) => {
            if (line) {
              elements.push(
                <span key={`text-${lastIndex}-${idx}`}>{line}</span>
              );
            }
            // Add line break except for last line
            if (idx < lines.length - 1) {
              elements.push(<br key={`br-${lastIndex}-${idx}`} />);
            }
          });
        }
      }

      const matchedText = match[0];

      // Check if it's display math ($$...$$) or inline math ($...$)
      if (matchedText.startsWith('$$') && matchedText.endsWith('$$')) {
        // Display math - extract content between $$
        const formula = matchedText.slice(2, -2).trim();
        elements.push(
          <div key={`block-${match.index}`} className="latex-display">
            <BlockMath
              math={formula}
              renderError={(error: Error) => (
                <div style={{ color: 'red' }}>
                  Error rendering LaTeX: {error.message}
                  <pre>{formula}</pre>
                </div>
              )}
            />
          </div>
        );
      } else if (matchedText.startsWith('$') && matchedText.endsWith('$')) {
        // Inline math - extract content between $
        const formula = matchedText.slice(1, -1).trim();
        elements.push(
          <InlineMath
            key={`inline-${match.index}`}
            math={formula}
            renderError={(error: Error) => (
              <span style={{ color: 'red', fontSize: '0.9em' }}>
                [Error: {formula}]
              </span>
            )}
          />
        );
      }

      lastIndex = match.index + matchedText.length;

      // Check if there's a newline immediately after this formula
      if (content[lastIndex] === '\n') {
        elements.push(<br key={`br-after-${match.index}`} />);
        lastIndex++; // Skip the newline
      }
    }

    // Add any remaining text after the last match
    if (lastIndex < content.length) {
      const remainingText = content.substring(lastIndex);
      if (remainingText) {
        // Split by newlines and add line breaks
        const lines = remainingText.split('\n');
        lines.forEach((line, idx) => {
          if (line) {
            elements.push(
              <span key={`text-final-${lastIndex}-${idx}`}>{line}</span>
            );
          }
          // Add line break except for last line
          if (idx < lines.length - 1) {
            elements.push(<br key={`br-final-${lastIndex}-${idx}`} />);
          }
        });
      }
    }

    // If no LaTeX was found, return the original content
    if (elements.length === 0) {
      elements.push(<span key="text-only">{content}</span>);
    }

    return elements;
  };

  return <div className="latex-container">{parseContent()}</div>;
}

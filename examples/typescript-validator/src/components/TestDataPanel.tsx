import CornerSquares from './CornerSquares';

interface TestDataPanelProps {
  value: string;
  onChange: (value: string) => void;
  result: string;
  isValidating: boolean;
}

export default function TestDataPanel({
  value,
  onChange,
  result,
  isValidating
}: TestDataPanelProps) {
  return (
    <div className="flex-1 bg-bg-cream flex flex-col overflow-hidden relative">
      <div className="px-4 py-3 border-b border-border-beige bg-bg-cream-dark">
        <h2 className="text-sm font-semibold text-text-medium">
          Test Data (JSON)
        </h2>
      </div>
      <div className="flex-1 overflow-hidden">
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Enter test data..."
          className="w-full h-full p-4 font-mono text-sm resize-none bg-bg-cream text-text-dark placeholder:text-text-medium focus:outline-none focus:ring-2 focus:ring-[#ff4801] focus:ring-inset"
          spellCheck={false}
        />
      </div>

      {/* Result Display */}
      {result && (
        <>
          {/* Corner squares where test data and result meet */}
          <div className="absolute left-0 top-1/2 -translate-y-1/2 pointer-events-none">
            <CornerSquares />
          </div>
          <div
            className={`px-4 py-3 border-t border-b border-border-beige bg-bg-cream-dark transition-opacity duration-200 ${isValidating ? 'opacity-50' : 'opacity-100'}`}
          >
            <h2 className="text-sm font-semibold text-text-medium">Result</h2>
          </div>
          <div
            className={`flex-1 overflow-hidden transition-opacity duration-200 ${isValidating ? 'opacity-50' : 'opacity-100'}`}
          >
            <pre className="w-full h-full p-4 font-mono text-xs overflow-auto bg-bg-cream text-text-dark">
              {result}
            </pre>
          </div>
        </>
      )}
    </div>
  );
}

interface SchemaEditorProps {
  value: string;
  onChange: (value: string) => void;
}

export default function SchemaEditor({ value, onChange }: SchemaEditorProps) {
  return (
    <div className="flex-1 bg-bg-cream border-r border-border-beige flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-border-beige bg-bg-cream-dark">
        <h2 className="text-sm font-semibold text-text-medium">
          Schema Editor (TypeScript)
        </h2>
      </div>
      <div className="flex-1 overflow-hidden">
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Write your TypeScript schema..."
          className="w-full h-full p-4 font-mono text-sm resize-none bg-bg-cream text-text-dark placeholder:text-text-medium focus:outline-none focus:ring-2 focus:ring-[#ff4801] focus:ring-inset"
          spellCheck={false}
        />
      </div>
    </div>
  );
}

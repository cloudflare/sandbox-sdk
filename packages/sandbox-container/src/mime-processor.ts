export interface ExecutionResult {
  type: 'result' | 'stdout' | 'stderr' | 'error' | 'execution_complete';
  text?: string;
  html?: string;
  png?: string;    // base64
  jpeg?: string;   // base64
  svg?: string;
  latex?: string;
  markdown?: string;
  javascript?: string;
  json?: any;
  chart?: ChartData;
  data?: any;
  metadata?: any;
  execution_count?: number;
  ename?: string;
  evalue?: string;
  traceback?: string[];
  timestamp: number;
}

export interface ChartData {
  type: 'line' | 'bar' | 'scatter' | 'pie' | 'histogram' | 'heatmap' | 'unknown';
  title?: string;
  data: any;
  layout?: any;
  config?: any;
  library?: 'matplotlib' | 'plotly' | 'altair' | 'seaborn' | 'unknown';
}

export function processMessage(msg: any): ExecutionResult | null {
    const msgType = msg.header?.msg_type || msg.msg_type;
    
    switch (msgType) {
      case 'execute_result':
      case 'display_data':
        return processDisplayData(msg.content.data, msg.content.metadata);
        
      case 'stream':
        return {
          type: msg.content.name === 'stdout' ? 'stdout' : 'stderr',
          text: msg.content.text,
          timestamp: Date.now()
        };
        
      case 'error':
        return {
          type: 'error',
          ename: msg.content.ename,
          evalue: msg.content.evalue,
          traceback: msg.content.traceback,
          timestamp: Date.now()
        };
        
      default:
        return null;
    }
  }

function processDisplayData(data: any, metadata?: any): ExecutionResult {
    const result: ExecutionResult = {
      type: 'result',
      timestamp: Date.now(),
      metadata
    };
    
    // Process different MIME types in order of preference
    
    // Interactive/Rich formats
    if (data['application/vnd.plotly.v1+json']) {
      result.chart = extractPlotlyChart(data['application/vnd.plotly.v1+json']);
      result.json = data['application/vnd.plotly.v1+json'];
    }
    
    if (data['application/vnd.vega.v5+json']) {
      result.chart = extractVegaChart(data['application/vnd.vega.v5+json'], 'vega');
      result.json = data['application/vnd.vega.v5+json'];
    }
    
    if (data['application/vnd.vegalite.v4+json'] || data['application/vnd.vegalite.v5+json']) {
      const vegaData = data['application/vnd.vegalite.v4+json'] || data['application/vnd.vegalite.v5+json'];
      result.chart = extractVegaChart(vegaData, 'vega-lite');
      result.json = vegaData;
    }
    
    // HTML content (tables, formatted output)
    if (data['text/html']) {
      result.html = data['text/html'];
      
      // Check if it's a pandas DataFrame
      if (isPandasDataFrame(data['text/html'])) {
        result.data = { type: 'dataframe', html: data['text/html'] };
      }
    }
    
    // Images
    if (data['image/png']) {
      result.png = data['image/png'];
      
      // Try to detect if it's a chart
      if (isLikelyChart(data, metadata)) {
        result.chart = {
          type: 'unknown',
          library: 'matplotlib',
          data: { image: data['image/png'] }
        };
      }
    }
    
    if (data['image/jpeg']) {
      result.jpeg = data['image/jpeg'];
    }
    
    if (data['image/svg+xml']) {
      result.svg = data['image/svg+xml'];
    }
    
    // Mathematical content
    if (data['text/latex']) {
      result.latex = data['text/latex'];
    }
    
    // Code
    if (data['application/javascript']) {
      result.javascript = data['application/javascript'];
    }
    
    // Structured data
    if (data['application/json']) {
      result.json = data['application/json'];
    }
    
    // Markdown
    if (data['text/markdown']) {
      result.markdown = data['text/markdown'];
    }
    
    // Plain text (fallback)
    if (data['text/plain']) {
      result.text = data['text/plain'];
    }
    
    return result;
  }

function extractPlotlyChart(plotlyData: any): ChartData {
    const data = plotlyData.data || plotlyData;
    const layout = plotlyData.layout || {};
    
    // Try to detect chart type from traces
    let chartType: ChartData['type'] = 'unknown';
    if (data && data.length > 0) {
      const firstTrace = data[0];
      if (firstTrace.type === 'scatter') {
        chartType = firstTrace.mode?.includes('lines') ? 'line' : 'scatter';
      } else if (firstTrace.type === 'bar') {
        chartType = 'bar';
      } else if (firstTrace.type === 'pie') {
        chartType = 'pie';
      } else if (firstTrace.type === 'histogram') {
        chartType = 'histogram';
      } else if (firstTrace.type === 'heatmap') {
        chartType = 'heatmap';
      }
    }
    
    return {
      type: chartType,
      title: layout.title?.text || layout.title,
      data: data,
      layout: layout,
      config: plotlyData.config,
      library: 'plotly'
    };
  }

function extractVegaChart(vegaData: any, format: 'vega' | 'vega-lite'): ChartData {
    // Try to detect chart type from mark or encoding
    let chartType: ChartData['type'] = 'unknown';
    
    if (format === 'vega-lite' && vegaData.mark) {
      const mark = typeof vegaData.mark === 'string' ? vegaData.mark : vegaData.mark.type;
      switch (mark) {
        case 'line':
          chartType = 'line';
          break;
        case 'bar':
          chartType = 'bar';
          break;
        case 'point':
        case 'circle':
          chartType = 'scatter';
          break;
        case 'arc':
          chartType = 'pie';
          break;
        case 'rect':
          if (vegaData.encoding?.color) {
            chartType = 'heatmap';
          }
          break;
      }
    }
    
    return {
      type: chartType,
      title: vegaData.title,
      data: vegaData,
      library: 'altair' // Altair outputs Vega-Lite
    };
  }

function isPandasDataFrame(html: string): boolean {
    // Simple heuristic to detect pandas DataFrame HTML
    return html.includes('dataframe') || 
           (html.includes('<table') && html.includes('<thead') && html.includes('<tbody'));
  }

function isLikelyChart(data: any, metadata?: any): boolean {
    // Check metadata for hints
    if (metadata?.needs?.includes('matplotlib')) {
      return true;
    }
    
    // Check if other chart formats are present
    if (data['application/vnd.plotly.v1+json'] || 
        data['application/vnd.vega.v5+json'] ||
        data['application/vnd.vegalite.v4+json']) {
      return true;
    }
    
    // If only image output without text, likely a chart
    if ((data['image/png'] || data['image/svg+xml']) && !data['text/plain']) {
      return true;
    }
    
    return false;
  }

export function extractFormats(result: ExecutionResult): string[] {
    const formats: string[] = [];
    
    if (result.text) formats.push('text');
    if (result.html) formats.push('html');
    if (result.png) formats.push('png');
    if (result.jpeg) formats.push('jpeg');
    if (result.svg) formats.push('svg');
    if (result.latex) formats.push('latex');
    if (result.markdown) formats.push('markdown');
    if (result.javascript) formats.push('javascript');
    if (result.json) formats.push('json');
    if (result.chart) formats.push('chart');
    
    return formats;
  }
// Execution Result Container
export class Execution {
    code;
    context;
    /**
     * All results from the execution
     */
    results = [];
    /**
     * Accumulated stdout and stderr
     */
    logs = {
        stdout: [],
        stderr: [],
    };
    /**
     * Execution error if any
     */
    error;
    /**
     * Execution count (for interpreter)
     */
    executionCount;
    constructor(code, context) {
        this.code = code;
        this.context = context;
    }
    /**
     * Convert to a plain object for serialization
     */
    toJSON() {
        return {
            code: this.code,
            logs: this.logs,
            error: this.error,
            executionCount: this.executionCount,
            results: this.results.map((result) => ({
                text: result.text,
                html: result.html,
                png: result.png,
                jpeg: result.jpeg,
                svg: result.svg,
                latex: result.latex,
                markdown: result.markdown,
                javascript: result.javascript,
                json: result.json,
                chart: result.chart,
                data: result.data,
            })),
        };
    }
}
// Implementation of Result
export class ResultImpl {
    raw;
    constructor(raw) {
        this.raw = raw;
    }
    get text() {
        return this.raw.text || this.raw.data?.["text/plain"];
    }
    get html() {
        return this.raw.html || this.raw.data?.["text/html"];
    }
    get png() {
        return this.raw.png || this.raw.data?.["image/png"];
    }
    get jpeg() {
        return this.raw.jpeg || this.raw.data?.["image/jpeg"];
    }
    get svg() {
        return this.raw.svg || this.raw.data?.["image/svg+xml"];
    }
    get latex() {
        return this.raw.latex || this.raw.data?.["text/latex"];
    }
    get markdown() {
        return this.raw.markdown || this.raw.data?.["text/markdown"];
    }
    get javascript() {
        return this.raw.javascript || this.raw.data?.["application/javascript"];
    }
    get json() {
        return this.raw.json || this.raw.data?.["application/json"];
    }
    get chart() {
        return this.raw.chart;
    }
    get data() {
        return this.raw.data;
    }
    formats() {
        const formats = [];
        if (this.text)
            formats.push("text");
        if (this.html)
            formats.push("html");
        if (this.png)
            formats.push("png");
        if (this.jpeg)
            formats.push("jpeg");
        if (this.svg)
            formats.push("svg");
        if (this.latex)
            formats.push("latex");
        if (this.markdown)
            formats.push("markdown");
        if (this.javascript)
            formats.push("javascript");
        if (this.json)
            formats.push("json");
        if (this.chart)
            formats.push("chart");
        return formats;
    }
}
//# sourceMappingURL=interpreter-types.js.map
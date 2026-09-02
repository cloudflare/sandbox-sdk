import { fileError } from "./errors.js";
import { FramedRead } from "./framed-read.js";

const SHIM_PATH = "/usr/local/bin/sandbox-shim";

export interface ReadFileOptions {
  cwd?: string;
  user?: string;
  signal?: AbortSignal;
}

export type ContainerExecutor = Pick<Container, "exec">;

export class ContainerFiles {
  readonly #container: ContainerExecutor;

  constructor(container: ContainerExecutor) {
    this.#container = container;
  }

  async readFile(path: string, options: ReadFileOptions = {}): Promise<Response> {
    validatePath(path, options.cwd);

    const process = await this.#container.exec([SHIM_PATH, "read", path], {
      ...options,
      stdout: "pipe",
      stderr: "ignore",
    });

    const read = FramedRead.open(process);
    try {
      const frame = await read.readFrame();
      if (frame.kind === "error") {
        throw fileError(path, frame.errno, frame.detail);
      }

      return new Response(read.body(), {
        headers: { "Content-Type": "application/octet-stream" },
      });
    } catch (error) {
      read.terminate(error);
      throw error;
    }
  }
}

function validatePath(path: string, cwd: string | undefined): void {
  if (path.length === 0) {
    throw new TypeError("path must not be empty");
  }
  if (path.includes("\0")) {
    throw new TypeError("path cannot contain NUL characters");
  }
  if (!path.startsWith("/") && cwd === undefined) {
    throw new TypeError("cwd is required when path is relative");
  }
}
